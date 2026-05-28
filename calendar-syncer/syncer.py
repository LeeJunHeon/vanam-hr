"""Google Calendar 동기화 데몬 (Phase 6 1단계 — 읽기 전용 뼈대).

흐름:
1. config 로드 → logger 셋업 → 시작 로그
2. DB 연결 → 직원 email 매칭 맵 1회 로드
3. CalendarClient 인증 (도메인 위임)
4. 메인 루프: 근태 캘린더 4개를 읽어 일정 + 직원 매칭을 로그로만 출력
   (DB 쓰기/캘린더 쓰기 절대 안 함)

설정한 주기(CALENDAR_SYNC_INTERVAL, 기본 30분)마다 반복.
"""

import signal
import sys
import time
from datetime import datetime, timedelta, timezone

from config import load_config, CALENDARS
from db import Database
from logger import setup_logger
from calendar_client import CalendarClient

# 한국 시간대 (UTC+9). ZoneInfo 대신 고정 오프셋 사용 (한국은 DST 없음).
KST = timezone(timedelta(hours=9))


class Syncer:
    def __init__(self):
        self.config = load_config()
        self.logger = setup_logger(self.config.log_level, self.config.log_file)
        self.running = True

        self.logger.info("Calendar Syncer 시작 (Phase 6 1단계 — 읽기 전용)")
        self.logger.info(
            f"SYNC_INTERVAL={self.config.sync_interval}초, "
            f"READ_DAYS_AHEAD={self.config.read_days_ahead}일, "
            f"SUBJECT={self.config.subject_email}"
        )

        # DB 연결 + 직원 email 매칭 맵 로드
        self.db = Database(
            host=self.config.db_host,
            port=self.config.db_port,
            dbname=self.config.db_name,
            user=self.config.db_user,
            password=self.config.db_password,
        )
        self.email_map = self.db.get_employee_email_map()
        self.logger.info(f"직원 {len(self.email_map)}명 매칭 맵 로드")

        # Google Calendar 인증
        self.client = CalendarClient(
            key_file=self.config.key_file,
            subject_email=self.config.subject_email,
        )
        self.logger.info(f"인증 성공 (subject: {self.config.subject_email})")

    def _reload_email_map(self):
        """직원 맵을 매 사이클 갱신 (신규 직원/이메일 변경 반영)."""
        try:
            self.email_map = self.db.get_employee_email_map()
        except Exception as e:
            self.logger.warning(f"직원 맵 갱신 실패 (이전 맵 유지): {e}")

    def sync_once(self):
        """1회 실행: 근태 캘린더 4개 읽기 → 직원 매칭 로그."""
        cycle_start = time.time()

        # 읽기 범위: 오늘 00:00 (KST) ~ 오늘+READ_DAYS_AHEAD일 23:59:59 (KST)
        now_kst = datetime.now(KST)
        time_min = now_kst.replace(hour=0, minute=0, second=0, microsecond=0)
        time_max = (now_kst + timedelta(days=self.config.read_days_ahead)).replace(
            hour=23, minute=59, second=59, microsecond=0
        )

        self.logger.info(
            f"=== 동기화 사이클 시작 (읽기 범위: {time_min.date()} ~ {time_max.date()}) ==="
        )

        # 직원 맵 갱신
        self._reload_email_map()

        total_all_day = 0
        total_timed = 0
        total_matched = 0

        for key, cal in CALENDARS.items():
            cal_name = cal["name"]
            cal_id = cal["id"]
            try:
                events = self.client.list_events(cal_id, time_min, time_max)
            except Exception as e:
                self.logger.warning(f"  [{cal_name}] 읽기 실패: {e}")
                continue

            all_day_cnt = 0
            timed_cnt = 0
            matched_cnt = 0

            for event in events:
                p = self.client.parse_event(event)
                if p["is_all_day"]:
                    all_day_cnt += 1
                    when_label = f"종일 {p['start_date_or_datetime']}"
                else:
                    timed_cnt += 1
                    when_label = f"시간 {p['start_date_or_datetime']}"

                # 직원 매칭
                creator = p["creator_email"]
                match_label = "매칭 안 됨"
                if creator:
                    normalized = creator.lower().strip()
                    emp_id = self.email_map.get(normalized)
                    if emp_id is not None:
                        matched_cnt += 1
                        match_label = f"→ employee_id={emp_id} (매칭됨)"
                    else:
                        match_label = "→ 매칭 안 됨"

                # 시스템 생성분 표시 (추후 스킵 대상)
                system_label = ""
                if p["ext_props"].get("vanam_source"):
                    system_label = " [시스템 생성분 — 추후 스킵 대상]"

                self.logger.info(
                    f"  [{cal_name}] {when_label} | {p['summary']} "
                    f"| creator={creator or '-'} {match_label}{system_label}"
                )

            self.logger.info(
                f"  [{cal_name}] 요약 — 종일 {all_day_cnt}건 / "
                f"시간지정 {timed_cnt}건 / 직원매칭 {matched_cnt}건"
            )

            total_all_day += all_day_cnt
            total_timed += timed_cnt
            total_matched += matched_cnt

        elapsed = time.time() - cycle_start
        self.logger.info(
            f"=== 사이클 종료: {elapsed:.2f}s "
            f"(전체 종일 {total_all_day} / 시간지정 {total_timed} / 매칭 {total_matched}) ==="
        )

    def run(self):
        """메인 루프. 예외는 잡아서 로그 남기고 계속."""
        while self.running:
            try:
                self.sync_once()
            except Exception as e:
                self.logger.exception(f"sync_once 예외 (계속 진행): {e}")

            if not self.running:
                break

            # interval 만큼 sleep (1초 단위로 끊어 종료 신호에 빠르게 반응)
            slept = 0
            while self.running and slept < self.config.sync_interval:
                time.sleep(1)
                slept += 1

        self.logger.info("Calendar Syncer 정상 종료")

    def stop(self, signum, frame):
        self.logger.info(f"종료 신호 수신 ({signum})")
        self.running = False


def main():
    syncer = Syncer()
    signal.signal(signal.SIGTERM, syncer.stop)
    signal.signal(signal.SIGINT, syncer.stop)
    try:
        syncer.run()
    except KeyboardInterrupt:
        sys.exit(0)


if __name__ == "__main__":
    main()

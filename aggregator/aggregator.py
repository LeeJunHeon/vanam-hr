"""presence_raw → attendance_daily 변환 데몬 (메인 entry point).

매 60초마다 활성 직원 각각의 오늘+어제 work_date presence_raw를 분석해
출퇴근 시각을 계산하고 attendance_daily에 UPSERT.
is_overridden=true 인 row는 건드리지 않음.

출퇴근 정의 (시나리오 A: employee 단위 통합 timeline, location 무관):
- 출근: 그날 첫 'online'의 checked_at
- 퇴근: 그날 마지막 'online'의 checked_at
  (단, now - last_online >= grace_minutes 일 때만 확정)
- grace_minutes는 hr.policy_settings.debounce_minutes에서 읽음 (기본 60)
- auto_status 판정은 별도 단계 (현재 NULL)

work_date 귀속 (야간 근무자 정책):
- 새벽 cutoff_hour 시 이전 활동은 전일 work_date로 귀속
- cutoff_hour는 hr.policy_settings.work_date_cutoff_hour 에서 읽음 (기본 4)
- 예: 5/27 03:30 활동 → work_date=5/26 (어제 야간 시프트의 연장)
- aggregator는 매 사이클마다 어제+오늘 두 work_date 모두 처리하여
  04:00~05:00 사이 grace 60분 도달 시점도 정확히 잡힌다.

sync 단순 루프. asyncio 의존성 없음.
"""

import signal
import sys
import time
from datetime import datetime, timezone, timedelta
from typing import Optional

from config import load_config
from db import Database
from logger import setup_logger


class Aggregator:
    def __init__(self):
        self.config = load_config()
        self.logger = setup_logger(self.config.log_level, self.config.log_file)
        self.db = Database(
            host=self.config.db_host,
            port=self.config.db_port,
            dbname=self.config.db_name,
            user=self.config.db_user,
            password=self.config.db_password,
        )
        self.running = True

    def compute_check_in_out(
        self,
        raw_records: list[dict],
        grace_minutes: int,
        now: datetime,
    ) -> tuple[Optional[datetime], Optional[datetime]]:
        """raw_records를 분석해 (check_in, check_out) 반환 (시나리오 A).

        시나리오 A: employee 단위 통합 timeline (location 무관).
        - check_in:  그날 첫 'online'의 checked_at
        - check_out: 그날 마지막 'online'의 checked_at
                     (단, now - last_online >= grace_minutes 일 때만 확정)

        아직 grace 시간이 안 지났으면 check_out=None (사무실 또는 외출 가능성).
        같은 날 다시 online이 잡히면 마지막 online이 갱신됨.

        raw_records는 checked_at 오름차순 정렬되어 있어야 함.
        now는 timezone-aware datetime (UTC 권장).
        """
        if not raw_records:
            return None, None

        # 첫 online
        check_in = None
        for r in raw_records:
            if r["status"] == "online":
                check_in = r["checked_at"]
                break

        # 마지막 online
        last_online = None
        for r in reversed(raw_records):
            if r["status"] == "online":
                last_online = r["checked_at"]
                break

        # check_out 판정: 마지막 online 이후 grace_minutes 이상 경과 시 확정
        check_out = None
        if last_online is not None:
            elapsed_seconds = (now - last_online).total_seconds()
            if elapsed_seconds >= grace_minutes * 60:
                check_out = last_online

        return check_in, check_out

    def aggregate_today(self):
        """매 사이클 1회 실행. 활성 직원 각각에 대해 어제+오늘 두 work_date 처리."""
        cycle_start = time.time()

        # 정책 로드: grace_minutes (마지막 online 이후 N분 무재연결 = 퇴근 확정)
        grace_raw = self.db.get_policy("debounce_minutes")
        try:
            grace_minutes = int(grace_raw) if grace_raw else 60
        except ValueError:
            self.logger.warning(
                f"debounce_minutes 값 파싱 실패 ({grace_raw}), 기본 60 사용"
            )
            grace_minutes = 60

        # 정책 로드: cutoff_hour (새벽 N시 이전은 전일 work_date)
        cutoff_raw = self.db.get_policy("work_date_cutoff_hour")
        try:
            cutoff_hour = int(cutoff_raw) if cutoff_raw else 4
        except ValueError:
            self.logger.warning(
                f"work_date_cutoff_hour 값 파싱 실패 ({cutoff_raw}), 기본 4 사용"
            )
            cutoff_hour = 4

        today = self.db.get_work_date_kst(cutoff_hour)
        yesterday = today - timedelta(days=1)
        self.logger.info(
            f"=== Aggregate 사이클 시작 "
            f"(work_date today={today}, yesterday={yesterday}, "
            f"grace={grace_minutes}분, cutoff={cutoff_hour}시) ==="
        )

        # 모든 직원 동일 기준 시각 사용 (UTC timezone-aware)
        now = datetime.now(timezone.utc)

        # 활성 직원 조회
        t0 = time.time()
        employees = self.db.get_active_employees()
        self.logger.info(
            f"  [1] 활성 직원 조회: {time.time()-t0:.3f}s ({len(employees)}건)"
        )

        if not employees:
            self.logger.debug("활성 직원 0건 — 사이클 건너뜀")
            return

        # 직원별 처리 (어제 + 오늘 두 work_date)
        upsert_count = 0
        skip_no_data = 0
        skip_overridden = 0

        for emp in employees:
            for work_date in (yesterday, today):
                result = self._process_employee_work_date(
                    emp, work_date, grace_minutes, cutoff_hour, now
                )
                if result == "upsert":
                    upsert_count += 1
                elif result == "overridden":
                    skip_overridden += 1
                else:
                    skip_no_data += 1

        total = time.time() - cycle_start
        self.logger.info(
            f"=== 사이클 종료: {total:.3f}s "
            f"(upsert {upsert_count}, no_data {skip_no_data}, overridden {skip_overridden}) ==="
        )

    def _process_employee_work_date(
        self,
        emp: dict,
        work_date,
        grace_minutes: int,
        cutoff_hour: int,
        now: datetime,
    ) -> str:
        """단일 직원 + 단일 work_date 처리. 반환: 'upsert' | 'overridden' | 'no_data'."""
        emp_id = emp["id"]
        emp_no = emp.get("employee_no", "?")
        emp_name = emp.get("name", "?")

        raw = self.db.get_presence_raw_by_work_date(emp_id, work_date, cutoff_hour)
        if not raw:
            return "no_data"

        check_in, check_out = self.compute_check_in_out(raw, grace_minutes, now)

        # 둘 다 없으면 INSERT 의미 없음
        if check_in is None and check_out is None:
            return "no_data"

        # work_minutes 계산
        work_minutes = None
        if check_in is not None and check_out is not None:
            delta = check_out - check_in
            work_minutes = int(delta.total_seconds() // 60)

        # auto_status 판정 (단순 버전)
        # - check_in/check_out 모두 있음 → 'normal'
        # - 둘 다 없음 → 'absent'
        # - 그 외 (출근만 또는 퇴근만) → NULL (판정 보류)
        # 향후: 시프트 패턴 매칭 후 grace_in/out 정책으로 late/early_leave 세분화 예정
        if check_in is not None and check_out is not None:
            auto_status = "normal"
        elif check_in is None and check_out is None:
            auto_status = "absent"
        else:
            auto_status = None

        new_id = self.db.upsert_attendance_daily(
            employee_id=emp_id,
            work_date=work_date,
            check_in=check_in,
            check_out=check_out,
            work_minutes=work_minutes,
            auto_status=auto_status,
        )

        if new_id is None:
            self.logger.debug(
                f"  직원 {emp_id}({emp_no}/{emp_name}) work_date={work_date} "
                f"— is_overridden=true 로 보호됨, 스킵"
            )
            return "overridden"
        else:
            self.logger.info(
                f"  직원 {emp_id}({emp_no}/{emp_name}) work_date={work_date} — "
                f"check_in={check_in}, check_out={check_out}, "
                f"work_minutes={work_minutes}, id={new_id}"
            )
            return "upsert"

    def run(self):
        """메인 루프. time.monotonic() 기반 fixed-rate scheduling.

        run_once() 소요 시간이 sleep에 누적되지 않도록 다음 wake-up 시각을 절대값으로 계산.
        근태 분 단위 정확성 위해 정확히 interval을 유지.
        """
        self.logger.info("Aggregator 시작")
        self.logger.info(
            f"INTERVAL_SECONDS={self.config.interval_seconds}, "
            f"LOG_LEVEL={self.config.log_level}"
        )

        next_run_at = time.monotonic()
        interval = self.config.interval_seconds

        while self.running:
            try:
                now = time.monotonic()

                if now >= next_run_at:
                    next_run_at += interval
                    self.aggregate_today()

                    behind = time.monotonic() - next_run_at
                    if behind > 0:
                        skip_count = int(behind // interval) + 1
                        self.logger.warning(
                            f"사이클이 {behind:.1f}초 지연됨 — {skip_count}회 skip"
                        )
                        next_run_at += skip_count * interval
                else:
                    sleep_time = min(1.0, next_run_at - now)
                    time.sleep(sleep_time)

            except Exception as e:
                self.logger.exception(f"Aggregate 루프 예외: {e}")
                time.sleep(60)
                next_run_at = time.monotonic()

        self.logger.info("Aggregator 정상 종료")

    def stop(self, sig=None, frame=None):
        self.logger.info(f"종료 시그널 수신 ({sig}) — 다음 루프에서 종료")
        self.running = False


def main():
    aggregator = Aggregator()
    signal.signal(signal.SIGINT, aggregator.stop)
    if hasattr(signal, "SIGTERM"):
        try:
            signal.signal(signal.SIGTERM, aggregator.stop)
        except (ValueError, OSError):
            pass
    try:
        aggregator.run()
    except KeyboardInterrupt:
        sys.exit(0)


if __name__ == "__main__":
    main()

"""Google Calendar 동기화 데몬 (Phase 6 2-A — 카테고리 판정 로그) + 캘린더 쓰기 endpoint.

흐름:
1. config 로드 → logger 셋업 → 시작 로그
2. DB 연결
3. CalendarClient 인증 (도메인 위임)
4. Flask HTTP 서버를 별도 스레드로 시작 (내부망 전용)
   - POST /internal/calendar-event: 재고관리 등 내부 시스템이 일정 등록
   - GET  /internal/health: liveness 체크
5. 메인 루프:
   - 매일 04:00 KST에 sync_once 1회 실행
   - 부팅 직후 1회 즉시 실행 (검증 편의)
   - DB의 calendar_sources (sync_enabled=true) 동적 조회
   - 당일 일정만 읽기
   - 키워드 매칭으로 카테고리 판정 (priority 오름차순, 첫 매칭 사용)
   - 매칭 안 되면 default_category 사용
   - 결과를 로그로만 출력 (DB INSERT 안 함, Phase 6-2B에서 추가)

체크 주기: 60초 (분 단위로 04:00 도달 감지). CPU 부담 거의 없음.
"""

import signal
import sys
import threading
import time
from datetime import datetime, timedelta, timezone

from flask import Flask, jsonify, request

from config import load_config
from db import Database
from logger import setup_logger
from calendar_client import CalendarClient

# 한국 시간대 (UTC+9). ZoneInfo 대신 고정 오프셋 사용 (한국은 DST 없음).
KST = timezone(timedelta(hours=9))

# 실행 시각 (KST 기준)
RUN_HOUR = 4
RUN_MINUTE = 0

# 메인 루프 체크 주기 (초)
CHECK_INTERVAL_SECONDS = 60


def _is_valid_date(s) -> bool:
    """YYYY-MM-DD 형식 검증."""
    if not isinstance(s, str):
        return False
    if len(s) != 10:
        return False
    try:
        datetime.strptime(s, "%Y-%m-%d")
        return True
    except ValueError:
        return False


class Syncer:
    def __init__(self):
        self.config = load_config()
        self.logger = setup_logger(self.config.log_level, self.config.log_file)
        self.running = True
        self.last_run_date = None  # 같은 날 중복 실행 방지

        self.logger.info("Calendar Syncer 시작 (Phase 6 2-A — 카테고리 판정 로그)")
        self.logger.info(
            f"실행 시각: 매일 {RUN_HOUR:02d}:{RUN_MINUTE:02d} KST, "
            f"SUBJECT={self.config.subject_email}"
        )

        # DB 연결
        self.db = Database(
            host=self.config.db_host,
            port=self.config.db_port,
            dbname=self.config.db_name,
            user=self.config.db_user,
            password=self.config.db_password,
        )

        # Google Calendar 인증
        self.client = CalendarClient(
            key_file=self.config.key_file,
            subject_email=self.config.subject_email,
        )

        # HTTP 서버 (재고관리 등 내부 시스템이 일정 등록할 때 사용)
        self.http_app = self._create_http_app()
        self.http_thread = None

        self.logger.info("초기화 완료")

    def _create_http_app(self) -> Flask:
        """Flask 앱 생성. /internal/calendar-event + /internal/health 두 엔드포인트.

        - X-Internal-Token 헤더로 인증 (env INTERNAL_API_TOKEN과 비교)
        - 같은 docker network의 컨테이너만 접근 (expose만, ports 매핑 X)
        - vanam_source="inventory" 표시로 syncer 무한루프 방지
        """
        app = Flask(__name__)

        @app.get("/internal/health")
        def health():
            return jsonify({"ok": True}), 200

        @app.post("/internal/calendar-event")
        def create_calendar_event():
            # 1) 토큰 검증
            token = request.headers.get("X-Internal-Token")
            if not token or token != self.config.internal_api_token:
                self.logger.warning(
                    f"인증 실패 (X-Internal-Token 누락 또는 불일치): "
                    f"remote={request.remote_addr}"
                )
                return jsonify({"ok": False, "error": "Unauthorized"}), 401

            # 2) Body 파싱
            try:
                data = request.get_json(force=True, silent=False)
            except Exception:
                return jsonify({"ok": False, "error": "Invalid JSON"}), 400

            if not isinstance(data, dict):
                return jsonify({"ok": False, "error": "Body must be JSON object"}), 400

            title = data.get("title")
            start_date = data.get("startDate")
            end_date = data.get("endDate")

            # 3) 입력 검증
            if not title or not isinstance(title, str) or not title.strip():
                return jsonify({"ok": False, "error": "title is required"}), 400
            if not _is_valid_date(start_date):
                return jsonify({"ok": False, "error": "startDate must be YYYY-MM-DD"}), 400
            if not _is_valid_date(end_date):
                return jsonify({"ok": False, "error": "endDate must be YYYY-MM-DD"}), 400
            if end_date < start_date:
                return jsonify({"ok": False, "error": "endDate must be >= startDate"}), 400

            # 4) 캘린더에 등록
            try:
                event_id = self.client.insert_event(
                    calendar_id=self.config.write_target_id,
                    title=title,
                    start_date=start_date,
                    end_date=end_date,
                    source="inventory",
                )
            except Exception as e:
                self.logger.exception(f"캘린더 일정 등록 실패: {e}")
                return jsonify({"ok": False, "error": str(e)}), 500

            self.logger.info(
                f"캘린더 일정 등록 완료: title='{title}', "
                f"{start_date}~{end_date}, eventId={event_id}"
            )
            return jsonify({"ok": True, "eventId": event_id}), 200

        return app

    def _match_category(
        self,
        summary: str,
        keyword_rules: list[dict],
        default_category_id: int,
        default_category_code: str,
    ) -> tuple[int, str, str | None]:
        """제목 키워드로 카테고리 판정.

        priority 오름차순으로 순회하면서 첫 매칭 룰 사용.
        매칭 안 되면 default (캘린더의 default_category) 반환.

        반환: (category_id, category_code, matched_keyword_or_None)
        """
        if not summary:
            return default_category_id, default_category_code, None

        for rule in keyword_rules:  # 이미 priority 오름차순 정렬됨
            if rule["keyword"] in summary:
                return rule["category_id"], rule["category_code"], rule["keyword"]

        return default_category_id, default_category_code, None

    def sync_once(self):
        """1회 실행: DB에서 캘린더 목록 읽고 → 일정 조회 → 카테고리 판정 로그."""
        cycle_start = time.time()

        # 읽기 범위: 오늘 00:00 ~ 23:59:59 KST (당일만)
        now_kst = datetime.now(KST)
        time_min = now_kst.replace(hour=0, minute=0, second=0, microsecond=0)
        time_max = now_kst.replace(hour=23, minute=59, second=59, microsecond=0)

        self.logger.info(
            f"=== 동기화 사이클 시작 (당일: {time_min.date()}) ==="
        )

        # 직원 매칭 맵 갱신
        email_map = self.db.get_employee_email_map()
        self.logger.info(f"직원 {len(email_map)}명 매칭 맵 로드")

        # 동기화 대상 캘린더 목록 (DB 동적 조회)
        try:
            calendar_sources = self.db.get_calendar_sources()
        except Exception as e:
            self.logger.exception(f"calendar_sources 조회 실패: {e}")
            return

        if not calendar_sources:
            self.logger.warning("calendar_sources에 등록된 캘린더 없음 (sync_enabled=true 0건)")
            return

        self.logger.info(f"동기화 대상 캘린더: {len(calendar_sources)}개")

        # 캘린더별 처리
        grand_all_day = 0
        grand_timed = 0
        grand_matched = 0

        for cs in calendar_sources:
            cs_id = cs["id"]
            cal_name = cs["calendar_name"]
            cal_id = cs["calendar_id"]
            default_cat_id = cs["default_category_id"]
            default_cat_code = cs["default_category_code"]

            # 이 캘린더에 적용되는 키워드 룰 로드 (priority 오름차순)
            try:
                keyword_rules = self.db.get_keyword_rules(cs_id)
            except Exception as e:
                self.logger.warning(f"  [{cal_name}] keyword_rules 조회 실패 (default만 사용): {e}")
                keyword_rules = []

            self.logger.info(
                f"  [{cal_name}] default={default_cat_code}, "
                f"키워드 룰 {len(keyword_rules)}개"
            )

            # 일정 조회
            try:
                events = self.client.list_events(cal_id, time_min, time_max)
            except Exception as e:
                self.logger.warning(f"  [{cal_name}] 일정 조회 실패: {e}")
                continue

            all_day_cnt = 0
            timed_cnt = 0
            matched_cnt = 0

            for event in events:
                p = self.client.parse_event(event)

                # 시스템 생성분은 스킵 (무한루프 방지)
                if p["ext_props"].get("vanam_source"):
                    self.logger.info(
                        f"  [{cal_name}] [SKIP-시스템생성] {p['summary']}"
                    )
                    continue

                if p["is_all_day"]:
                    all_day_cnt += 1
                    when_label = f"종일 {p['start_date_or_datetime']}"
                else:
                    timed_cnt += 1
                    when_label = f"시간 {p['start_date_or_datetime']}"

                # 직원 매칭
                creator = p["creator_email"]
                emp_id = None
                if creator:
                    emp_id = email_map.get(creator.lower().strip())
                if emp_id is not None:
                    matched_cnt += 1
                    emp_label = f"employee_id={emp_id}"
                else:
                    emp_label = "매칭 안 됨"

                # 카테고리 판정
                cat_id, cat_code, matched_kw = self._match_category(
                    p["summary"], keyword_rules, default_cat_id, default_cat_code
                )
                if matched_kw:
                    cat_label = f"category={cat_code} (키워드:{matched_kw})"
                else:
                    cat_label = f"category={cat_code} (default)"

                self.logger.info(
                    f"  [{cal_name}] {when_label} | {p['summary']} "
                    f"| creator={creator or '-'} ({emp_label}) | {cat_label}"
                )

            self.logger.info(
                f"  [{cal_name}] 요약 — 종일 {all_day_cnt}건 / "
                f"시간지정 {timed_cnt}건 / 직원매칭 {matched_cnt}건"
            )

            grand_all_day += all_day_cnt
            grand_timed += timed_cnt
            grand_matched += matched_cnt

        elapsed = time.time() - cycle_start
        self.logger.info(
            f"=== 사이클 종료: {elapsed:.2f}s "
            f"(전체 종일 {grand_all_day} / 시간지정 {grand_timed} / 매칭 {grand_matched}) ==="
        )

    def _should_run_now(self, now_kst: datetime) -> bool:
        """지금이 실행 시각(RUN_HOUR:RUN_MINUTE)이고, 오늘 아직 안 돌았으면 True."""
        if now_kst.hour != RUN_HOUR:
            return False
        # 같은 날 중복 방지
        today = now_kst.date()
        if self.last_run_date == today:
            return False
        return True

    def run(self):
        """메인 루프.

        - HTTP 서버를 별도 스레드(daemon)로 먼저 시작 (재고관리 연동용)
        - 부팅 직후 1회 즉시 sync_once 실행 (검증 편의)
        - 그 후 매 60초마다 깨어나서 04:00 도달 체크
        - 04:00이면 sync_once 실행, last_run_date 갱신
        """
        # HTTP 서버를 별도 스레드로 시작 (데몬 스레드, 메인 종료 시 함께 종료)
        # threaded=True: Flask 기본은 single-threaded, 동시 요청 처리 위해 활성화
        self.http_thread = threading.Thread(
            target=lambda: self.http_app.run(
                host="0.0.0.0",
                port=self.config.http_port,
                debug=False,
                use_reloader=False,
                threaded=True,
            ),
            daemon=True,
            name="HttpServer",
        )
        self.http_thread.start()
        self.logger.info(
            f"HTTP 서버 시작 (포트 {self.config.http_port}, 내부망 전용)"
        )

        # 부팅 즉시 1회 실행 (검증/디버깅 편의)
        try:
            self.logger.info("부팅 직후 즉시 1회 실행 (검증용)")
            self.sync_once()
            self.last_run_date = datetime.now(KST).date()
        except Exception as e:
            self.logger.exception(f"초기 sync_once 예외 (계속 진행): {e}")

        # 메인 루프: 1분마다 깨어나서 04:00 체크
        while self.running:
            now_kst = datetime.now(KST)
            if self._should_run_now(now_kst):
                self.logger.info(
                    f"실행 시각 도달 ({now_kst.strftime('%Y-%m-%d %H:%M:%S')} KST)"
                )
                try:
                    self.sync_once()
                except Exception as e:
                    self.logger.exception(f"sync_once 예외 (계속 진행): {e}")
                self.last_run_date = now_kst.date()

            if not self.running:
                break

            # 1초 단위로 끊어 자며 종료 신호에 빠르게 반응
            slept = 0
            while self.running and slept < CHECK_INTERVAL_SECONDS:
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

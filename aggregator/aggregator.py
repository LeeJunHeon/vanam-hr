"""presence_raw → attendance_daily 변환 데몬 (메인 entry point).

매 60초마다 활성 직원 각각의 오늘 presence_raw를 분석해 출퇴근 시각을 계산하고
attendance_daily에 UPSERT. is_overridden=true 인 row는 건드리지 않음.

출퇴근 정의 (단순 버전):
- 출근: 그날 첫 'online'
- 퇴근: 그날 마지막 'offline' (단, 그 후 'online'이 없을 때만)
- Grace 정책 적용 안 함 (auto_status NULL)
- 5분 디바운싱은 별도 로직 없이 위 정의로 자연 처리됨

sync 단순 루프. asyncio 의존성 없음.
"""

import signal
import sys
import time
from datetime import datetime
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
    ) -> tuple[Optional[datetime], Optional[datetime]]:
        """raw_records를 분석해 (check_in, check_out) 반환.

        - check_in: 첫 'online'의 checked_at
        - check_out: 마지막 'offline'의 checked_at (단, 그 후 'online'이 없을 때만)

        둘 다 없을 수 있음. raw_records는 checked_at 오름차순 정렬되어 있어야 함.
        """
        if not raw_records:
            return None, None

        # 첫 online
        check_in = None
        for r in raw_records:
            if r["status"] == "online":
                check_in = r["checked_at"]
                break

        # 마지막 offline (그 후 online 없을 때만)
        # raw_records를 뒤에서부터 보며, 'offline'을 만나는데 그 후 'online'이 없으면 그게 퇴근
        check_out = None
        for r in reversed(raw_records):
            if r["status"] == "online":
                # 마지막 record가 online이거나, offline 이후에 online이 있음
                # → check_out 없음 (아직 사무실에 있거나 외출 후 복귀)
                break
            if r["status"] == "offline":
                check_out = r["checked_at"]
                break

        return check_in, check_out

    def aggregate_today(self):
        """매 사이클 1회 실행. 활성 직원 각각 처리."""
        cycle_start = time.time()
        today = self.db.get_today_kst()
        self.logger.info(f"=== Aggregate 사이클 시작 (work_date={today}) ===")

        # 활성 직원 조회
        t0 = time.time()
        employees = self.db.get_active_employees()
        self.logger.info(
            f"  [1] 활성 직원 조회: {time.time()-t0:.3f}s ({len(employees)}건)"
        )

        if not employees:
            self.logger.debug("활성 직원 0건 — 사이클 건너뜀")
            return

        # 직원별 처리
        upsert_count = 0
        skip_no_data = 0
        skip_overridden = 0

        for emp in employees:
            emp_id = emp["id"]
            emp_no = emp.get("employee_no", "?")
            emp_name = emp.get("name", "?")

            raw = self.db.get_today_presence_raw(emp_id)
            if not raw:
                skip_no_data += 1
                continue

            check_in, check_out = self.compute_check_in_out(raw)

            # 둘 다 없으면 INSERT 의미 없음 (raw가 모두 status 이상값?)
            if check_in is None and check_out is None:
                skip_no_data += 1
                continue

            # work_minutes 계산
            work_minutes = None
            if check_in is not None and check_out is not None:
                delta = check_out - check_in
                work_minutes = int(delta.total_seconds() // 60)

            new_id = self.db.upsert_attendance_daily(
                employee_id=emp_id,
                work_date=today,
                check_in=check_in,
                check_out=check_out,
                work_minutes=work_minutes,
            )

            if new_id is None:
                skip_overridden += 1
                self.logger.debug(
                    f"  직원 {emp_id}({emp_no}/{emp_name}) — is_overridden=true 로 보호됨, 스킵"
                )
            else:
                upsert_count += 1
                self.logger.info(
                    f"  직원 {emp_id}({emp_no}/{emp_name}) — "
                    f"check_in={check_in}, check_out={check_out}, "
                    f"work_minutes={work_minutes}, id={new_id}"
                )

        total = time.time() - cycle_start
        self.logger.info(
            f"=== 사이클 종료: {total:.3f}s "
            f"(upsert {upsert_count}, no_data {skip_no_data}, overridden {skip_overridden}) ==="
        )

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

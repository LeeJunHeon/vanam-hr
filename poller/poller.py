"""ipTIME SNMP 폴링 데몬 (메인 entry point).

활성 디바이스의 MAC을 SNMP walk으로 조회 → presence_raw 적재.
online ↔ offline 전환 시에만 INSERT (중복 방지).

sync 단순 루프. asyncio 의존성 없음.
"""

import signal
import sys
import time
from datetime import datetime, timedelta

from config import load_config
from db import Database
from logger import mask_mac, setup_logger
from snmp_client import SnmpClient

# 정책 캐시 만료 시간 (5분)
POLICY_CACHE_TTL = timedelta(minutes=5)


class Poller:
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
        self.snmp_router_ip: str | None = None
        self.snmp: SnmpClient | None = None
        self.last_policy_load: datetime | None = None
        self.running = True
        self._consecutive_snmp_errors = 0
        # 메모리 상태 캐시: {device_id: 'online' or 'offline'}
        # 시작 시 1회만 DB에서 로드, 이후 메모리만 사용
        self.device_states: dict[int, str] = {}
        self._initial_states_loaded = False

    def _ensure_initial_states_loaded(self):
        """폴러 시작 후 첫 사이클에 활성 디바이스의 마지막 상태 로드."""
        if self._initial_states_loaded:
            return
        devices = self.db.get_active_devices()
        for d in devices:
            last = self.db.get_last_status(d["id"])
            # 초기 상태는 'offline' default (online은 명확한 evidence 있을 때만)
            self.device_states[d["id"]] = "online" if last == "online" else "offline"
        self.logger.info(
            f"초기 상태 로드: {len(self.device_states)}건 "
            f"(online {sum(1 for s in self.device_states.values() if s == 'online')}건)"
        )
        self._initial_states_loaded = True

    def reload_policies(self):
        """정책 5분마다 갱신. snmp_router_ip 변경 시 SnmpClient 재생성."""
        new_ip = self.db.get_policy("snmp_router_ip")
        if not new_ip:
            self.logger.error("snmp_router_ip 정책이 DB에 없습니다.")
            raise SystemExit(1)
        if new_ip != self.snmp_router_ip:
            self.logger.info(
                "라우터 IP 변경 감지 (또는 초기 설정). SnmpClient 재초기화."
            )
            self.snmp_router_ip = new_ip
            self.snmp = SnmpClient(new_ip, self.config.snmp_community)
        self.last_policy_load = datetime.now()

    def needs_policy_reload(self) -> bool:
        if self.last_policy_load is None:
            return True
        return datetime.now() - self.last_policy_load > POLICY_CACHE_TTL

    def run_once(self):
        """폴링 1회 실행: SNMP walk → MAC 매칭 → presence_raw 적재.

        각 단계별 소요 시간을 INFO 로그로 출력하여 병목 파악.
        """
        cycle_start = time.time()
        self.logger.info("=== 폴링 사이클 시작 ===")

        # [1] 정책 캐시 갱신 확인
        if self.needs_policy_reload():
            t0 = time.time()
            self.reload_policies()
            self.logger.info(f"  [1] 정책 reload: {time.time()-t0:.3f}s")

        # 첫 사이클에 초기 상태 로드 (DB에서 1회만)
        self._ensure_initial_states_loaded()

        # [2] DB에서 활성 디바이스 조회
        t0 = time.time()
        devices = self.db.get_active_devices()
        self.logger.info(
            f"  [2] 활성 디바이스 조회: {time.time()-t0:.3f}s ({len(devices)}건)"
        )

        if not devices:
            self.logger.debug("활성 디바이스 0건 — 폴링 건너뜀")
            return

        # 새 디바이스 발견 시 메모리에 추가 (offline default)
        for d in devices:
            if d["id"] not in self.device_states:
                self.device_states[d["id"]] = "offline"

        # [3] SNMP walk
        t0 = time.time()
        try:
            assert self.snmp is not None
            snmp_results = self.snmp.walk_mac_table()
            walk_time = time.time() - t0
            self.logger.info(
                f"  [3] SNMP walk: {walk_time:.3f}s ({len(snmp_results)}건 응답)"
            )
            self._consecutive_snmp_errors = 0
        except Exception as e:
            walk_time = time.time() - t0
            self._consecutive_snmp_errors += 1
            self.logger.warning(
                f"  [3] SNMP walk 실패: {walk_time:.3f}s "
                f"({self._consecutive_snmp_errors}회 연속): {e}"
            )
            if self._consecutive_snmp_errors >= 3:
                self.logger.warning("3회 연속 실패 — 30초 대기")
                time.sleep(30)
            return

        # 빈 응답 가드: ipTIME ARP 캐시 갱신 주기(약 120초)와 동조 시 빈 응답.
        # 5초 대기 후 1회 재시도 (실측 검증: 5초면 cool down 풀림).
        # 격행 패턴(XOXOXOXOXO)을 깨서 매 사이클 데이터 확보 보장.
        if not snmp_results:
            self.logger.info(
                "  빈 응답 — 5초 후 재시도 (ARP 갱신 주기 회피)"
            )
            time.sleep(5)
            t0 = time.time()
            try:
                snmp_results = self.snmp.walk_mac_table()
                self.logger.info(
                    f"  [3-retry] SNMP walk 재시도: {time.time()-t0:.3f}s "
                    f"({len(snmp_results)}건 응답)"
                )
            except Exception as e:
                self.logger.warning(f"  [3-retry] 재시도 실패: {e}")
                snmp_results = []

            if not snmp_results:
                self.logger.warning(
                    "  [⚠️ SKIP] 재시도 후에도 빈 응답 — 진짜 라우터 장애 추정, "
                    "이번 사이클 매칭/상태 변경 스킵"
                )
                return

        # [4-5] MAC 매칭 + DB (메모리 상태 기준)
        t0 = time.time()
        active_mac_to_device = {d["mac_address"]: d for d in devices}
        seen_macs: set[str] = set()
        matched_count = 0
        online_transitions = 0
        offline_transitions = 0
        db_inserts = 0
        db_updates = 0

        for result in snmp_results:
            normalized = result.get("mac", "")
            if not normalized:
                continue
            if normalized in active_mac_to_device:
                device = active_mac_to_device[normalized]
                seen_macs.add(normalized)
                matched_count += 1

                current_state = self.device_states.get(device["id"], "offline")

                if current_state == "online":
                    # 이미 online → last_seen_at만 갱신 (INSERT 없음)
                    if not self.config.dry_run:
                        self.db.update_last_seen(device["id"])
                        db_updates += 1
                else:
                    # offline → online 전환 → INSERT
                    online_transitions += 1
                    if not self.config.dry_run:
                        new_id = self.db.insert_presence(
                            device_id=device["id"],
                            employee_id=device["employee_id"],
                            status="online",
                            ssid=None,
                            raw_value=None,
                        )
                        self.db.update_last_seen(device["id"])
                        db_inserts += 1
                        db_updates += 1
                        self.device_states[device["id"]] = "online"
                        self.logger.info(
                            f"  → online: {mask_mac(normalized)} "
                            f"(device_id={device['id']}, employee_id={device['employee_id']}, "
                            f"presence_raw.id={new_id})"
                        )

        # offline 처리
        for mac, device in active_mac_to_device.items():
            if mac in seen_macs:
                continue
            current_state = self.device_states.get(device["id"], "offline")
            if current_state == "online":
                offline_transitions += 1
                if not self.config.dry_run:
                    new_id = self.db.insert_presence(
                        device_id=device["id"],
                        employee_id=device["employee_id"],
                        status="offline",
                        ssid=None,
                        raw_value=None,
                    )
                    db_inserts += 1
                    self.device_states[device["id"]] = "offline"
                    self.logger.info(
                        f"  → offline: {mask_mac(mac)} "
                        f"(device_id={device['id']}, employee_id={device['employee_id']}, "
                        f"presence_raw.id={new_id})"
                    )

        self.logger.info(
            f"  [4-5] MAC 매칭 + DB: {time.time()-t0:.3f}s "
            f"(매칭 {matched_count}건, INSERT {db_inserts}, UPDATE {db_updates}, "
            f"online↑ {online_transitions}, offline↓ {offline_transitions})"
        )

        total = time.time() - cycle_start
        self.logger.info(f"=== 사이클 종료: {total:.3f}s ===")

    def run(self):
        """메인 루프. time.monotonic() 기반 fixed-rate scheduling.

        run_once() 소요 시간이 sleep에 누적되지 않도록 다음 wake-up 시각을 절대값으로 계산.
        근태 기록은 분 단위 정확성이 필수이므로 정확히 polling_schedules의 interval을 유지.
        실측 drift 최대 100ms — 분 단위 정확성에 충분.
        """
        self.logger.info("Poller 시작")
        self.logger.info(
            f"DRY_RUN={self.config.dry_run}, LOG_LEVEL={self.config.log_level}"
        )

        next_run_at = time.monotonic()

        while self.running:
            try:
                now = time.monotonic()

                if now >= next_run_at:
                    # 다음 사이클 시각을 미리 계산 (run_once 시작 직전)
                    interval = self.db.get_current_polling_schedule(datetime.now())
                    next_run_at += interval

                    self.run_once()

                    # 만약 run_once가 너무 오래 걸려서 next_run_at이 이미 과거가 됐으면
                    # 즉시 다음 사이클 실행하지 않고 다음 주기로 재조정 (밀린 사이클 skip)
                    behind = time.monotonic() - next_run_at
                    if behind > 0:
                        skip_count = int(behind // interval) + 1
                        self.logger.warning(
                            f"사이클이 {behind:.1f}초 지연됨 — {skip_count}회 skip "
                            f"(run_once가 interval보다 오래 걸림)"
                        )
                        next_run_at += skip_count * interval
                else:
                    # 다음 시각까지 1초 단위로 sleep (시그널 응답성 유지)
                    sleep_time = min(1.0, next_run_at - now)
                    time.sleep(sleep_time)

            except Exception as e:
                self.logger.exception(f"폴링 루프 예외: {e}")
                time.sleep(60)
                next_run_at = time.monotonic()

        self.logger.info("Poller 정상 종료")

    def stop(self, sig=None, frame=None):
        self.logger.info(f"종료 시그널 수신 ({sig}) — 다음 루프에서 종료")
        self.running = False


def main():
    poller = Poller()
    signal.signal(signal.SIGINT, poller.stop)
    # Linux에선 SIGTERM 정상 동작
    if hasattr(signal, "SIGTERM"):
        try:
            signal.signal(signal.SIGTERM, poller.stop)
        except (ValueError, OSError):
            pass
    try:
        poller.run()
    except KeyboardInterrupt:
        sys.exit(0)


if __name__ == "__main__":
    main()

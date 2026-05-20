"""ipTIME SNMP 폴링 데몬 (메인 entry point).

활성 디바이스의 MAC을 SNMP walk으로 조회 → presence_raw 적재.
online ↔ offline 전환 시에만 INSERT (중복 방지).
"""

import asyncio
import platform
import signal
import sys
from datetime import datetime, timedelta

from config import load_config
from db import Database
from logger import mask_mac, setup_logger
from snmp_client import SnmpClient

# Windows에서 pysnmp asyncio 호환을 위한 이벤트 루프 정책 설정
if platform.system() == "Windows":
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

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

    async def run_once(self):
        """폴링 1회 실행: SNMP walk → MAC 매칭 → presence_raw 적재."""
        if self.needs_policy_reload():
            self.reload_policies()

        devices = self.db.get_active_devices()
        if not devices:
            self.logger.debug("활성 디바이스 0건 — 폴링 건너뜀")
            return

        # SNMP walk (자체 재시도 포함 — ipTIME cold start 3회까지 시도)
        try:
            assert self.snmp is not None
            snmp_results = await self.snmp.walk_mac_table()
            self._consecutive_snmp_errors = 0
        except Exception as e:
            self._consecutive_snmp_errors += 1
            self.logger.warning(
                f"SNMP walk 실패 ({self._consecutive_snmp_errors}회 연속): {e}"
            )
            if self._consecutive_snmp_errors >= 3:
                self.logger.warning("3회 연속 실패 — 30초 대기 후 재시도")
                await asyncio.sleep(30)
            return

        # 활성 디바이스 MAC → DB row 매핑
        # devices.mac_address는 lib/macAddress.ts 규칙으로 정규화된 lowercase 12자리
        active_mac_to_device = {d["mac_address"]: d for d in devices}
        seen_macs: set[str] = set()

        # online 처리 (SNMP 결과의 mac은 이미 walk_mac_table()에서 정규화된 12자리)
        for result in snmp_results:
            normalized = result.get("mac", "")
            if not normalized:
                continue

            if normalized not in active_mac_to_device:
                continue

            device = active_mac_to_device[normalized]
            seen_macs.add(normalized)

            # 이 펌웨어는 SSID 정보 없음
            ssid = None
            raw_value = None

            last_status = self.db.get_last_status(device["id"])
            if last_status == "online":
                # 이미 online — last_seen_at만 갱신
                if not self.config.dry_run:
                    self.db.update_last_seen(device["id"])
            else:
                # 신규 또는 offline → online 전환
                self.logger.info(
                    f"online: {mask_mac(normalized)} "
                    f"(device_id={device['id']}, employee_id={device['employee_id']})"
                )
                if not self.config.dry_run:
                    self.db.insert_presence(
                        device_id=device["id"],
                        employee_id=device["employee_id"],
                        status="online",
                        ssid=ssid,
                        raw_value=raw_value,
                    )
                    self.db.update_last_seen(device["id"])

        # offline 전환 (SNMP 응답에 없는 활성 디바이스)
        for mac, device in active_mac_to_device.items():
            if mac in seen_macs:
                continue
            last_status = self.db.get_last_status(device["id"])
            if last_status == "online":
                self.logger.info(
                    f"offline: {mask_mac(mac)} "
                    f"(device_id={device['id']}, employee_id={device['employee_id']})"
                )
                if not self.config.dry_run:
                    self.db.insert_presence(
                        device_id=device["id"],
                        employee_id=device["employee_id"],
                        status="offline",
                        ssid=None,
                        raw_value=None,
                    )
            # last_status가 offline 또는 None이면 아무 것도 안 함 (중복 방지)

    async def run(self):
        self.logger.info("Poller 시작")
        self.logger.info(
            f"DRY_RUN={self.config.dry_run}, LOG_LEVEL={self.config.log_level}"
        )

        # pysnmp cold start 워밍업: 첫 bulk_walk_cmd는 timeout이 정상 동작이므로 무시
        # 정책 1회 로드해서 SnmpClient 준비
        self.reload_policies()
        if self.snmp is not None:
            self.logger.info("SNMP dispatcher 워밍업 시작...")
            try:
                await self.snmp.walk_mac_table()
                self.logger.info("SNMP 워밍업 성공 (cold start 통과)")
            except RuntimeError as e:
                # 첫 호출 timeout은 예상된 동작. 무시하고 계속.
                self.logger.info(f"SNMP 워밍업 timeout (예상된 cold start): {e}")

        while self.running:
            try:
                await self.run_once()
                interval = self.db.get_current_polling_schedule(datetime.now())
                self.logger.debug(f"다음 폴링까지 {interval}초 대기")
                # 종료 시그널 응답성 위해 1초 단위로 sleep
                for _ in range(interval):
                    if not self.running:
                        break
                    await asyncio.sleep(1)
            except Exception as e:
                self.logger.exception(f"폴링 루프 예외: {e}")
                await asyncio.sleep(60)

        self.logger.info("Poller 정상 종료")

    def stop(self, sig=None, frame=None):
        self.logger.info(f"종료 시그널 수신 ({sig}) — 다음 루프에서 종료")
        self.running = False


def main():
    poller = Poller()
    signal.signal(signal.SIGINT, poller.stop)
    # Windows에서 SIGTERM은 없을 수 있음
    if hasattr(signal, "SIGTERM"):
        try:
            signal.signal(signal.SIGTERM, poller.stop)
        except (ValueError, OSError):
            pass
    try:
        asyncio.run(poller.run())
    except KeyboardInterrupt:
        sys.exit(0)


if __name__ == "__main__":
    main()

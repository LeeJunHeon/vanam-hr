"""ipTIME ICC HTTP 폴링 데몬 (메인 entry point).

공덕 사무실 라우터의 활성 디바이스 MAC을 ICC API로 조회 → presence_raw 적재.
online ↔ offline 전환 시에만 INSERT (중복 방지).

신도림 SNMP 폴러(poller/poller.py)와 동일한 패턴.
"""

import signal
import sys
import time
from datetime import datetime

from config import load_config
from db import Database
from icc_client import IccClient
from logger import mask_mac, setup_logger

# 폴링 location (presence_raw에 INSERT 시 사용)
POLLER_LOCATION = "공덕"


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
        self.icc = IccClient(
            url=self.config.icc_url,
            user=self.config.icc_user,
            password=self.config.icc_password,
            site_id=self.config.icc_site_id,
        )
        self.running = True
        self._consecutive_errors = 0
        # 메모리 상태 캐시: {device_id: 'online' or 'offline'}
        self.device_states: dict[int, str] = {}
        self._initial_states_loaded = False

    def _ensure_initial_states_loaded(self):
        """폴러 시작 후 첫 사이클에 활성 디바이스의 마지막 상태 로드."""
        if self._initial_states_loaded:
            return
        devices = self.db.get_active_devices()
        for d in devices:
            last = self.db.get_last_status(d["id"])
            self.device_states[d["id"]] = "online" if last == "online" else "offline"
        self.logger.info(
            f"초기 상태 로드: {len(self.device_states)}건 "
            f"(online {sum(1 for s in self.device_states.values() if s == 'online')}건)"
        )
        self._initial_states_loaded = True

    def run_once(self):
        """폴링 1회 실행: ICC API → MAC 매칭 → presence_raw 적재."""
        cycle_start = time.time()
        self.logger.info("=== ICC 폴링 사이클 시작 ===")

        # [1] 초기 상태 로드
        self._ensure_initial_states_loaded()

        # [2] 활성 디바이스 조회 + 메모리 캐시 동기화
        t0 = time.time()
        devices = self.db.get_active_devices()
        self.logger.info(
            f"  [2] 활성 디바이스 조회: {time.time()-t0:.3f}s ({len(devices)}건)"
        )

        # 새 디바이스(등록 직후) 기본값 offline
        for d in devices:
            if d["id"] not in self.device_states:
                self.device_states[d["id"]] = "offline"

        # [3] ICC API 호출
        t0 = time.time()
        try:
            current_macs = self.icc.get_macs()
            call_time = time.time() - t0
            self.logger.info(
                f"  [3] ICC API call: {call_time:.3f}s ({len(current_macs)}건 응답)"
            )
            self._consecutive_errors = 0
        except Exception as e:
            call_time = time.time() - t0
            self._consecutive_errors += 1
            self.logger.warning(
                f"  [3] ICC API 실패: {call_time:.3f}s "
                f"({self._consecutive_errors}회 연속): {e}"
            )
            if self._consecutive_errors >= 3:
                self.logger.warning("3회 연속 실패 — 30초 대기")
                time.sleep(30)
            return

        # 빈 응답 가드
        if not current_macs:
            self.logger.warning(
                "  [3] ICC가 빈 station 리스트 반환 — 이번 사이클 SKIP "
                "(false offline 방지)"
            )
            return

        # [4-5] MAC 매칭 + DB
        t0 = time.time()
        current_mac_set = set(current_macs)
        matched_count = 0
        db_inserts = 0
        db_updates = 0
        online_transitions = 0
        offline_transitions = 0

        for device in devices:
            device_mac = (device.get("mac_address") or "").replace(":", "").replace("-", "").lower()
            if not device_mac:
                continue

            is_online_now = device_mac in current_mac_set
            prev_state = self.device_states.get(device["id"], "offline")

            if is_online_now:
                matched_count += 1
                if prev_state == "online":
                    # 이미 online → last_seen_at만 갱신
                    if not self.config.dry_run:
                        self.db.update_last_seen(device["id"])
                        db_updates += 1
                else:
                    # offline → online 전환 → INSERT (location='공덕')
                    online_transitions += 1
                    if not self.config.dry_run:
                        new_id = self.db.insert_presence(
                            device_id=device["id"],
                            employee_id=device["employee_id"],
                            status="online",
                            ssid=None,
                            raw_value=None,
                            location=POLLER_LOCATION,
                        )
                        self.db.update_last_seen(device["id"])
                        db_inserts += 1
                        db_updates += 1
                        self.device_states[device["id"]] = "online"
                        self.logger.info(
                            f"  → online: {mask_mac(device_mac)} "
                            f"(device_id={device['id']}, employee_id={device['employee_id']}, "
                            f"presence_raw.id={new_id})"
                        )
            else:
                if prev_state == "online":
                    # online → offline 전환 → INSERT (location='공덕')
                    offline_transitions += 1
                    if not self.config.dry_run:
                        new_id = self.db.insert_presence(
                            device_id=device["id"],
                            employee_id=device["employee_id"],
                            status="offline",
                            ssid=None,
                            raw_value=None,
                            location=POLLER_LOCATION,
                        )
                        db_inserts += 1
                        self.device_states[device["id"]] = "offline"
                        self.logger.info(
                            f"  → offline: {mask_mac(device_mac)} "
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
        """메인 루프. time.monotonic() 기반 fixed-rate scheduling."""
        self.logger.info("ICC Poller 시작")
        self.logger.info(
            f"DRY_RUN={self.config.dry_run}, LOG_LEVEL={self.config.log_level}, "
            f"ICC_URL={self.config.icc_url}, SITE_ID={self.config.icc_site_id}"
        )

        # 기본 폴링 주기 60초 (신도림과 동일)
        # polling_schedules 정책 적용은 향후 작업 (현재는 고정)
        interval = 60
        next_wake = time.monotonic()

        while self.running:
            try:
                self.run_once()
            except Exception as e:
                self.logger.exception(f"run_once 예외: {e}")

            next_wake += interval
            sleep_for = next_wake - time.monotonic()
            if sleep_for > 0:
                time.sleep(sleep_for)
            else:
                # 사이클 지연 시 skip 보정 (다음 wake 시각 재설정)
                self.logger.warning(
                    f"사이클 지연 {-sleep_for:.1f}s — 다음 wake 시각 재설정"
                )
                next_wake = time.monotonic()

    def stop(self, signum, frame):
        self.logger.info(f"종료 신호 수신 ({signum})")
        self.running = False


def main():
    poller = Poller()
    signal.signal(signal.SIGTERM, poller.stop)
    signal.signal(signal.SIGINT, poller.stop)
    poller.run()


if __name__ == "__main__":
    main()

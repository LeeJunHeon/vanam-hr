"""통합 출퇴근 폴러 (신도림 SNMP + 공덕 ICC HTTP API).

활성 디바이스의 MAC을 두 소스에서 조회 → OR 연산 → presence_raw 적재.
online ↔ offline 전환 시에만 INSERT (중복 방지).

장애 대응:
- 한쪽 소스 실패: 다른 소스만으로 계속 동작 (부분 장애 허용)
- 양쪽 모두 실패: 사이클 SKIP (false offline 방지) + 알림
- Google Chat Webhook 알림: 상태 전환 시에만 발송 (스팸 방지)
"""

import signal
import sys
import time
from datetime import datetime, timedelta

from config import load_config
from db import Database
from icc_client import IccClient
from logger import mask_mac, setup_logger
from notifier import Notifier
from snmp_client import SnmpClient

# 정책 캐시 만료 시간 (5분)
POLICY_CACHE_TTL = timedelta(minutes=5)

# location 값 (DB 컬럼에 저장)
LOCATION_SINDORIM = "본사"
LOCATION_GONGDEOK = "공덕"


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
        self.icc = IccClient(
            url=self.config.icc_url,
            user=self.config.icc_user,
            password=self.config.icc_password,
            site_id=self.config.icc_site_id,
        )
        self.notifier = Notifier(
            webhook_url=self.config.notifier_webhook_url,
            logger=self.logger,
        )
        self.last_policy_load: datetime | None = None
        self.running = True
        # 메모리 상태 캐시: {device_id: 'online' or 'offline'}
        self.device_states: dict[int, str] = {}
        self._initial_states_loaded = False
        # 소스별 직전 상태 ('ok' or 'fail') + 최초 실패 시각 (다운타임 계산용)
        self.snmp_state: str = "ok"
        self.icc_state: str = "ok"
        self.snmp_fail_started_at: datetime | None = None
        self.icc_fail_started_at: datetime | None = None

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

    def reload_policies(self):
        """정책 reload (5분 캐시). 라우터 IP 변경 시 SnmpClient 재초기화."""
        new_ip = self.db.get_policy("snmp_router_ip")
        if not new_ip:
            self.logger.error("snmp_router_ip 정책이 DB에 없습니다.")
            raise SystemExit(1)
        if new_ip != self.snmp_router_ip:
            self.logger.info("라우터 IP 변경 감지 (또는 초기 설정). SnmpClient 재초기화.")
            self.snmp_router_ip = new_ip
            self.snmp = SnmpClient(new_ip, self.config.snmp_community)
        self.last_policy_load = datetime.now()

    def needs_policy_reload(self) -> bool:
        if self.last_policy_load is None:
            return True
        return datetime.now() - self.last_policy_load > POLICY_CACHE_TTL

    def _call_snmp(self) -> set[str] | None:
        """신도림 SNMP 호출. 성공 시 MAC set 반환, 실패 시 None.

        상태 전환 시 (ok→fail, fail→ok) 알림 발송.
        """
        try:
            t0 = time.time()
            snmp_results = self.snmp.walk_mac_table()
            walk_time = time.time() - t0
            # walk_mac_table 반환: list[dict] → mac만 추출
            macs = {r["mac"] for r in snmp_results if "mac" in r}
            self.logger.info(
                f"  [3a] 본사 SNMP: {walk_time:.3f}s ({len(macs)}건 응답)"
            )
            # 빈 응답은 라우터 장애로 간주 (표준 OID는 정상 시 응답 있음)
            if not macs:
                raise RuntimeError("SNMP walk 빈 응답 (라우터 장애 추정)")
            # 복구 알림
            if self.snmp_state == "fail":
                downtime = datetime.now() - self.snmp_fail_started_at if self.snmp_fail_started_at else None
                downtime_str = f"{downtime.total_seconds():.0f}초" if downtime else "?"
                self.notifier.send(
                    f"✅ [HR Poller] 본사 SNMP 복구\n"
                    f"시각: {datetime.now():%Y-%m-%d %H:%M:%S} KST\n"
                    f"다운타임: {downtime_str}"
                )
                self.snmp_state = "ok"
                self.snmp_fail_started_at = None
            return macs
        except Exception as e:
            self.logger.warning(f"  [3a] 본사 SNMP 실패: {e}")
            # 첫 실패 알림
            if self.snmp_state == "ok":
                self.snmp_state = "fail"
                self.snmp_fail_started_at = datetime.now()
                self.notifier.send(
                    f"🚨 [HR Poller] 본사 SNMP 실패\n"
                    f"시각: {datetime.now():%Y-%m-%d %H:%M:%S} KST\n"
                    f"에러: {e}\n"
                    f"조치: 라우터/SNMP 상태 확인 필요"
                )
            return None

    def _call_icc(self) -> set[str] | None:
        """공덕 ICC API 호출. 성공 시 MAC set 반환, 실패 시 None.

        상태 전환 시 (ok→fail, fail→ok) 알림 발송.
        """
        try:
            t0 = time.time()
            icc_macs_list = self.icc.get_macs()
            call_time = time.time() - t0
            macs = set(icc_macs_list)
            self.logger.info(
                f"  [3b] 공덕 ICC: {call_time:.3f}s ({len(macs)}건 응답)"
            )
            # 복구 알림
            if self.icc_state == "fail":
                downtime = datetime.now() - self.icc_fail_started_at if self.icc_fail_started_at else None
                downtime_str = f"{downtime.total_seconds():.0f}초" if downtime else "?"
                self.notifier.send(
                    f"✅ [HR Poller] 공덕 ICC 복구\n"
                    f"시각: {datetime.now():%Y-%m-%d %H:%M:%S} KST\n"
                    f"다운타임: {downtime_str}"
                )
                self.icc_state = "ok"
                self.icc_fail_started_at = None
            return macs
        except Exception as e:
            self.logger.warning(f"  [3b] 공덕 ICC 실패: {e}")
            if self.icc_state == "ok":
                self.icc_state = "fail"
                self.icc_fail_started_at = datetime.now()
                self.notifier.send(
                    f"🚨 [HR Poller] 공덕 ICC 실패\n"
                    f"시각: {datetime.now():%Y-%m-%d %H:%M:%S} KST\n"
                    f"에러: {e}\n"
                    f"조치: ICC 컨테이너/공덕 라우터 상태 확인 필요"
                )
            return None

    def run_once(self):
        """폴링 1회 실행: SNMP + ICC → OR 연산 → presence_raw 적재."""
        cycle_start = time.time()
        self.logger.info("=== 폴링 사이클 시작 ===")

        # [1] 정책 캐시 갱신 확인
        if self.needs_policy_reload():
            t0 = time.time()
            self.reload_policies()
            self.logger.info(f"  [1] 정책 reload: {time.time()-t0:.3f}s")

        # [2] 초기 상태 로드 (첫 사이클만)
        self._ensure_initial_states_loaded()

        # [2.5] 활성 디바이스 조회
        t0 = time.time()
        devices = self.db.get_active_devices()
        self.logger.info(
            f"  [2] 활성 디바이스 조회: {time.time()-t0:.3f}s ({len(devices)}건)"
        )

        # 새 디바이스(등록 직후) 기본값 offline
        for d in devices:
            if d["id"] not in self.device_states:
                self.device_states[d["id"]] = "offline"

        # [3a] 신도림 SNMP 호출
        snmp_macs = self._call_snmp()
        # [3b] 공덕 ICC 호출
        icc_macs = self._call_icc()

        # 둘 다 실패: 사이클 SKIP (false offline 방지)
        if snmp_macs is None and icc_macs is None:
            self.logger.warning(
                "  [⚠️ SKIP] 본사 + 공덕 모두 실패 — 이번 사이클 처리 안 함"
            )
            self.notifier.send(
                f"🚨 [HR Poller] 본사 + 공덕 동시 실패\n"
                f"시각: {datetime.now():%Y-%m-%d %H:%M:%S} KST\n"
                f"이번 사이클 SKIP. 모든 직원 offline 오판 방지를 위해 처리 안 함.\n"
                f"조치: 즉시 양쪽 네트워크 확인"
            )
            return

        # [4] OR 연산 + location 결정
        # snmp_macs / icc_macs는 set 또는 None
        snmp_set = snmp_macs if snmp_macs is not None else set()
        icc_set = icc_macs if icc_macs is not None else set()

        # 양쪽 동시 감지 체크 (이상 케이스, 알림)
        # 단, 운영 시작 초기에는 거의 발생 안 함. devices 테이블의 MAC 기준만 체크.
        device_macs_in_use = {
            (d.get("mac_address") or "").replace(":", "").replace("-", "").lower()
            for d in devices
        }
        both_visible_macs = (snmp_set & icc_set) & device_macs_in_use
        for mac in both_visible_macs:
            # device_id, employee_id 찾기
            target = next(
                (d for d in devices
                 if (d.get("mac_address") or "").replace(":", "").replace("-", "").lower() == mac),
                None,
            )
            if target:
                self.notifier.send(
                    f"⚠️ [HR Poller] 디바이스 양쪽 동시 감지\n"
                    f"device_id: {target['id']}\n"
                    f"employee_id: {target['employee_id']}\n"
                    f"시각: {datetime.now():%Y-%m-%d %H:%M:%S} KST\n"
                    f"원인 추정: MAC 중복 등록 또는 라우터 stale 캐시\n"
                    f"조치: hr.devices 테이블 + 양쪽 라우터 station 확인"
                )

        # [5] device 처리: OR 연산 + location 결정 + INSERT/UPDATE
        t0 = time.time()
        matched_count = 0
        db_inserts = 0
        db_updates = 0
        online_transitions = 0
        offline_transitions = 0

        for device in devices:
            mac = (device.get("mac_address") or "").replace(":", "").replace("-", "").lower()
            if not mac:
                continue

            in_snmp = mac in snmp_set
            in_icc = mac in icc_set
            is_online = in_snmp or in_icc  # OR 연산

            # location 결정: 본사(SNMP) 우선
            if in_snmp:
                location = LOCATION_SINDORIM
            elif in_icc:
                location = LOCATION_GONGDEOK
            else:
                # offline일 때는 마지막 본 location을 알 수 없음 → 기본 '본사' 사용
                # (offline INSERT는 location이 중요하지 않음, status만 의미)
                location = LOCATION_SINDORIM

            prev_state = self.device_states.get(device["id"], "offline")

            if is_online:
                matched_count += 1
                if prev_state == "online":
                    # 이미 online → last_seen_at만 갱신
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
                            location=location,
                        )
                        self.db.update_last_seen(device["id"])
                        db_inserts += 1
                        db_updates += 1
                        self.device_states[device["id"]] = "online"
                        self.logger.info(
                            f"  → online @ {location}: {mask_mac(mac)} "
                            f"(device_id={device['id']}, employee_id={device['employee_id']}, "
                            f"presence_raw.id={new_id})"
                        )
            else:
                # 어느 쪽에도 안 보임 → offline
                if prev_state == "online":
                    # online → offline 전환 → INSERT
                    offline_transitions += 1
                    if not self.config.dry_run:
                        new_id = self.db.insert_presence(
                            device_id=device["id"],
                            employee_id=device["employee_id"],
                            status="offline",
                            ssid=None,
                            raw_value=None,
                            location=location,
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
        """메인 루프. time.monotonic() 기반 fixed-rate scheduling."""
        self.logger.info("통합 Poller 시작 (본사 SNMP + 공덕 ICC)")
        self.logger.info(
            f"DRY_RUN={self.config.dry_run}, LOG_LEVEL={self.config.log_level}, "
            f"ICC_URL={self.config.icc_url}, SITE_ID={self.config.icc_site_id}, "
            f"NOTIFIER={'활성' if self.config.notifier_webhook_url else '비활성'}"
        )

        next_run_at = time.monotonic()

        while self.running:
            try:
                now = time.monotonic()

                if now >= next_run_at:
                    interval = self.db.get_current_polling_schedule(datetime.now())
                    next_run_at += interval

                    self.run_once()

                    behind = time.monotonic() - next_run_at
                    if behind > 0:
                        skip_count = int(behind // interval) + 1
                        self.logger.warning(
                            f"사이클이 {behind:.1f}초 지연됨 — {skip_count}회 skip "
                            f"(run_once가 interval보다 오래 걸림)"
                        )
                        next_run_at += skip_count * interval
                else:
                    sleep_time = min(1.0, next_run_at - now)
                    time.sleep(sleep_time)

            except Exception as e:
                self.logger.exception(f"폴링 루프 예외: {e}")
                time.sleep(60)
                next_run_at = time.monotonic()

        self.logger.info("Poller 정상 종료")

    def stop(self, signum, frame):
        self.logger.info(f"종료 신호 수신 ({signum}). 정리 중...")
        self.running = False


def main():
    poller = Poller()
    signal.signal(signal.SIGTERM, poller.stop)
    signal.signal(signal.SIGINT, poller.stop)
    poller.run()


if __name__ == "__main__":
    main()

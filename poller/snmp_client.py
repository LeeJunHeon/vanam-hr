"""ipTIME SNMP 클라이언트. easysnmp (net-snmp C 바인딩) 기반.

sync 호출. asyncio 의존성 없음.

참고: ipTIME 펌웨어 4.4.198에서 메인 OID (1.1.1)는 미지원.
MAC OID (1.1.2)만 사용. SSID/유선 구분 정보 없음.
"""

import time
from typing import Optional

from easysnmp import Session
from easysnmp.exceptions import EasySNMPTimeoutError


class SnmpClient:
    """ipTIME SNMP 클라이언트 (sync, Session 재사용)."""

    # 이 펌웨어는 응답하지 않지만 향후 다른 펌웨어/모델 대응 위해 보존
    MAIN_OID_PREFIX = "1.3.6.1.4.1.12874.1.3.1.1.1"
    MAC_OID_PREFIX = "1.3.6.1.4.1.12874.1.3.1.1.2"

    def __init__(
        self,
        host: str,
        community: str,
        port: int = 161,
        timeout: int = 5,
        retries: int = 5,
    ):
        self.host = host
        self.community = community
        self.port = port
        self.timeout = timeout
        self.retries = retries
        self._session: Optional[Session] = None

    def _get_session(self) -> Session:
        """Session 인스턴스 lazy 생성 + 재사용."""
        if self._session is None:
            self._session = Session(
                hostname=self.host,
                community=self.community,
                version=2,  # SNMPv2c
                remote_port=self.port,
                timeout=self.timeout,
                retries=self.retries,
                use_numeric=True,  # OID를 숫자 그대로 (MIB 변환 X)
            )
        return self._session

    def walk_mac_table(self) -> list[dict]:
        """
        MAC OID prefix를 walk해서 라우터에 연결된 모든 디바이스 MAC 반환.

        반환 형식: [
            {mac: 'aabbccddeeff' (정규화된 lowercase 12자리),
             oid_index: '34.0.168.192' or '1.118.43.116'},
            ...
        ]

        ipTIME 라우터의 cold start 대응: 첫 호출이 timeout 나면 즉시 재시도.
        snmpwalk CLI는 자체 재시도하지만 easysnmp의 retries 파라미터는
        walk()에서 동작 안 함 → 직접 구현. 최대 3회, 사이 0.5초 sleep.
        """
        last_err: EasySNMPTimeoutError | None = None
        for attempt in range(3):
            try:
                return self._walk_once()
            except EasySNMPTimeoutError as e:
                last_err = e
                if attempt < 2:
                    time.sleep(0.5)
        # 3회 모두 timeout
        assert last_err is not None
        raise last_err

    def _walk_once(self) -> list[dict]:
        """실제 walk 1회 수행. get_next 루프 사용 (ipTIME이 GETBULK 미응답하므로).

        Timeout 시 EasySNMPTimeoutError 발생.

        중요: easysnmp는 r.oid의 마지막 옥텟을 r.oid_index로 자동 분리함.
        walk 다음 단계로 진행하려면 r.oid + r.oid_index 조합 필수.
        안 그러면 잘린 OID로 next 호출되어 무한 루프 발생.
        """
        session = self._get_session()
        results: list[dict] = []

        # 시작 OID: MAC OID prefix
        current_oid = self.MAC_OID_PREFIX
        # 안전장치: 무한 루프 방지 (디바이스 256개까지 충분)
        max_iterations = 500
        seen_oids: set[str] = set()  # 안전장치: 같은 OID 두 번 등장 시 즉시 종료

        for _ in range(max_iterations):
            item = session.get_next(current_oid)

            # easysnmp는 마지막 옥텟을 oid_index로 분리하므로 둘을 조합해 완전한 OID 만듦
            base = str(item.oid).lstrip(".")
            idx = str(item.oid_index) if item.oid_index else ""
            item_oid = f"{base}.{idx}" if idx else base

            # 응답 OID가 더 이상 MAC_OID_PREFIX 하위가 아니면 walk 종료
            # (예: 1.3.6.1.4.1.12874.1.3.1.1.3.* 으로 넘어가면 prefix 벗어남)
            if not item_oid.startswith(self.MAC_OID_PREFIX):
                break

            # 무한 루프 안전장치: 같은 OID가 또 나오면 종료
            if item_oid in seen_oids:
                break
            seen_oids.add(item_oid)

            mac_value = item.value
            if mac_value and "No Such" not in str(mac_value):
                normalized = self.normalize_mac(mac_value)
                if normalized:
                    # prefix 제거 후 남은 인덱스 (예: '1.118.43.116' 또는 '13.0.168.192')
                    oid_index_full = item_oid[len(self.MAC_OID_PREFIX) :].lstrip(".")
                    results.append(
                        {
                            "mac": normalized,
                            "oid_index": oid_index_full,
                        }
                    )

            # 다음 OID로 진행 — 현재 응답 OID를 다음 get_next의 시작점으로
            current_oid = item_oid

        return results

    def normalize_mac(self, mac: str) -> str:
        """SNMP 응답 MAC을 정규화 (콜론/하이픈 제거, lowercase, 12자리).

        유효하지 않으면 빈 문자열 반환.
        """
        cleaned = (
            mac.replace(":", "")
            .replace("-", "")
            .replace(".", "")
            .replace(" ", "")
            .lower()
        )
        if len(cleaned) != 12:
            return ""
        if not all(c in "0123456789abcdef" for c in cleaned):
            return ""
        return cleaned

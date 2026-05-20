"""ipTIME SNMP 클라이언트. easysnmp (net-snmp C 바인딩) 기반.

sync 호출. asyncio 의존성 없음.

참고: ipTIME 펌웨어 4.4.198에서 메인 OID (1.1.1)는 미지원.
MAC OID (1.1.2)만 사용. SSID/유선 구분 정보 없음.
"""

from typing import Optional

from easysnmp import Session


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
        timeout: int = 3,
        retries: int = 2,
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

        easysnmp의 walk()는 내부적으로 SNMPv2c BULK_WALK 사용.
        timeout 시 EasySNMPTimeoutError 발생 → 호출자가 처리.
        """
        session = self._get_session()
        results: list[dict] = []

        items = session.walk(self.MAC_OID_PREFIX)

        for item in items:
            mac_value = item.value
            if not mac_value or "No Such" in str(mac_value):
                continue
            normalized = self.normalize_mac(mac_value)
            if not normalized:
                continue
            results.append(
                {
                    "mac": normalized,
                    "oid_index": item.oid_index,
                }
            )

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

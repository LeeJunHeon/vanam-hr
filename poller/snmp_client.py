"""ipTIME SNMP 클라이언트. easysnmp (net-snmp C 바인딩) 기반.

sync 호출. asyncio 의존성 없음.

표준 SNMP MIB ipNetToMediaPhysAddress 사용:
  OID: 1.3.6.1.2.1.4.22.1.2
  내용: ARP 테이블의 MAC 주소 (PhysAddress)

실측 (2026-05-21):
- 60초 간격 5회 walk 모두 52건 일관 응답
- 평균 0.033초 (vendor OID 4초의 120배 빠름)
- timeout 0회, 격행/cool down 없음
- 본인 폰 매칭률 100%

이전 vendor OID (1.3.6.1.4.1.12874.1.3.1.1.2)는 캐시 갱신 주기 때문에
격행으로 빈 응답 50% 발생 → 표준 OID로 모든 문제 해결.

OID 구조: 1.3.6.1.2.1.4.22.1.2.{ifIndex}.{IP옥텟1}.{IP옥텟2}.{IP옥텟3}.{IP옥텟4}
값 형식: raw bytes 6자 (MAC 주소 그대로 binary)
"""

from typing import Optional

from easysnmp import Session
from easysnmp.exceptions import EasySNMPTimeoutError


class SnmpClient:
    """표준 SNMP MIB 기반 ARP 테이블 클라이언트 (sync, Session 재사용)."""

    # 표준 ipNetToMediaPhysAddress (ARP 테이블의 MAC 주소)
    # 실측: ipTIME 펌웨어 4.4.198에서 timeout 없이 한 번에 다 응답
    MAC_OID_PREFIX = "1.3.6.1.2.1.4.22.1.2"

    def __init__(
        self,
        host: str,
        community: str,
        port: int = 161,
        timeout: int = 2,
        retries: int = 1,
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
        """표준 ARP OID walk. 한 번에 다 받음 (timeout 없음).

        반환 형식: [
            {mac: 'aabbccddeeff' (정규화된 lowercase 12자리),
             oid_index: '{ifIndex}.{IP옥텟1}.{IP옥텟2}.{IP옥텟3}.{IP옥텟4}'},
            ...
        ]
        """
        session = self._get_session()
        results: list[dict] = []
        current_oid = self.MAC_OID_PREFIX
        # 안전장치: 무한 루프 방지
        max_iterations = 500
        seen_oids: set[str] = set()

        for _ in range(max_iterations):
            try:
                item = session.get_next(current_oid)
            except EasySNMPTimeoutError:
                # 표준 OID는 정상 환경에서 timeout 발생 안 함.
                # 발생 시 라우터 진짜 장애 → 부분 결과 반환.
                break

            # easysnmp가 마지막 옥텟을 oid_index로 분리하므로 둘을 조합
            base = str(item.oid).lstrip(".")
            idx = str(item.oid_index) if item.oid_index else ""
            item_oid = f"{base}.{idx}" if idx else base

            # prefix 벗어나면 walk 종료
            if not item_oid.startswith(self.MAC_OID_PREFIX):
                break

            # 무한 루프 안전장치: 같은 OID가 또 나오면 종료
            if item_oid in seen_oids:
                break
            seen_oids.add(item_oid)

            normalized = self.normalize_mac(item.value)
            if normalized:
                oid_index_full = item_oid[
                    len(self.MAC_OID_PREFIX) :
                ].lstrip(".")
                results.append(
                    {
                        "mac": normalized,
                        "oid_index": oid_index_full,
                    }
                )

            current_oid = item_oid

        return results

    def normalize_mac(self, mac_value) -> str:
        """SNMP raw bytes MAC을 정규화 (lowercase 12자리 hex 문자열).

        표준 ipNetToMediaPhysAddress는 MAC을 6 바이트 raw binary로 반환.
        easysnmp가 str로 변환해서 주지만 실제로는 raw bytes 6개의 latin-1 표현.

        예: 'p0]\\x9a÷Í' (raw 6 bytes) → '70305d9af7cd'

        유효하지 않으면 빈 문자열 반환.
        """
        if mac_value is None:
            return ""

        try:
            # bytes 타입이면 그대로, str이면 latin-1로 인코딩 (1문자 = 1바이트 유지)
            if isinstance(mac_value, bytes):
                mac_bytes = mac_value
            else:
                mac_bytes = str(mac_value).encode("latin-1")

            if len(mac_bytes) != 6:
                return ""

            return mac_bytes.hex().lower()
        except (UnicodeDecodeError, ValueError):
            return ""

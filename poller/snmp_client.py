"""ipTIME SNMP 클라이언트. pysnmp 7.x asyncio API.

세션 재사용으로 응답 시간 1~2초 유지.

참고: ipTIME 펌웨어 4.4.198에서 메인 OID (1.1.1)는 미지원.
MAC OID (1.1.2)만 사용. SSID 구분 정보 없음.
"""

from typing import Optional

from pysnmp.hlapi.v3arch.asyncio import (
    CommunityData,
    ContextData,
    ObjectIdentity,
    ObjectType,
    SnmpEngine,
    UdpTransportTarget,
    bulk_walk_cmd,
)


class SnmpClient:
    """ipTIME SNMP 클라이언트. pysnmp 7.x asyncio API.

    세션 재사용으로 응답 시간 1~2초 유지.

    참고: ipTIME 펌웨어 4.4.198에서 메인 OID (1.1.1)는 미지원.
    MAC OID (1.1.2)만 사용. SSID 구분 정보 없음.
    """

    # 이 펌웨어는 응답하지 않지만 향후 다른 펌웨어/모델 대응 위해 보존
    MAIN_OID_PREFIX = "1.3.6.1.4.1.12874.1.3.1.1.1"
    MAC_OID_PREFIX = "1.3.6.1.4.1.12874.1.3.1.1.2"

    def __init__(
        self,
        host: str,
        community: str,
        port: int = 161,
        timeout: int = 3,
    ):
        self.host = host
        self.community = community
        self.port = port
        self.timeout = timeout
        self._engine: Optional[SnmpEngine] = None

    async def _get_engine(self) -> SnmpEngine:
        if self._engine is None:
            self._engine = SnmpEngine()
        return self._engine

    async def _walk_once(self) -> list[dict]:
        """실제 SNMP walk 1회 수행. timeout 시 RuntimeError 발생."""
        engine = await self._get_engine()
        transport = await UdpTransportTarget.create(
            (self.host, self.port), timeout=self.timeout, retries=1
        )
        results: list[dict] = []

        async for errInd, errStat, _errIdx, varBinds in bulk_walk_cmd(
            engine,
            CommunityData(self.community, mpModel=1),  # mpModel=1 = SNMPv2c
            transport,
            ContextData(),
            0,
            10,
            ObjectType(ObjectIdentity(self.MAC_OID_PREFIX)),
        ):
            if errInd or errStat:
                raise RuntimeError(
                    f"SNMP walk error: {errInd or errStat.prettyPrint()}"
                )
            for oid, value in varBinds:
                oid_str = str(oid)
                if not oid_str.startswith(self.MAC_OID_PREFIX + "."):
                    break
                oid_index = oid_str[len(self.MAC_OID_PREFIX) + 1 :]
                mac_value = str(value)
                if not mac_value or "No Such" in mac_value:
                    continue
                normalized = self.normalize_mac(mac_value)
                if not normalized:
                    continue
                results.append(
                    {
                        "mac": normalized,
                        "oid_index": oid_index,
                    }
                )

        return results

    async def walk_mac_table(self) -> list[dict]:
        """
        MAC OID prefix walk. 워밍업은 poller.py가 책임.

        반환 형식: [
            {mac: 'aabbccddeeff' (정규화된 lowercase 12자리),
             oid_index: '34.0.168.192' or '1.118.43.116'},
            ...
        ]

        이 펌웨어는 메인 OID 미지원 → SSID/유선 구분 불가.
        MAC 매칭만으로 디바이스 식별.
        """
        return await self._walk_once()

    def parse_ssid(self, conn_value: Optional[str]) -> Optional[str]:
        """현재 펌웨어는 SSID 정보 없음."""
        return None

    def is_wifi(self, conn_value: Optional[str]) -> bool:
        """현재 펌웨어는 SSID 구분 정보 없음. 모든 매칭을 통과시킴.

        회사 운영 정책상 직원은 휴대폰만 devices에 등록하므로
        LAN 연결 디바이스가 매칭될 가능성 낮음.
        """
        return True

    def normalize_mac(self, mac: str) -> str:
        """SNMP 응답 MAC을 정규화 (콜론/하이픈/점 제거, lowercase, 12자리 hex 검증)."""
        cleaned = (
            mac.replace(":", "")
            .replace("-", "")
            .replace(".", "")
            .replace(" ", "")
            .lower()
        )
        if len(cleaned) != 12 or not all(c in "0123456789abcdef" for c in cleaned):
            return ""
        return cleaned

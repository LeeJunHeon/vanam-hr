"""ipTIME SNMP 클라이언트. pysnmp-lextudio 6.x asyncio API.

세션 재사용으로 응답 시간 1~2초 유지.
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
    MAIN_OID_PREFIX = "1.3.6.1.4.1.12874.1.3.1.1.1"  # 무선 연결 상태
    MAC_OID_PREFIX = "1.3.6.1.4.1.12874.1.3.1.1.2"  # MAC 주소

    def __init__(
        self,
        host: str,
        community: str,
        port: int = 161,
        timeout: int = 5,
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

    async def walk_mac_table(self) -> list[dict]:
        """
        MAC OID prefix와 메인 OID prefix를 walk해서 라우터에 연결된 모든 디바이스 정보 반환.

        반환 형식: [
            {ip_reversed: '34.0.168.192', mac: 'aa:bb:cc:dd:ee:ff', conn: '5G VanaM_5G'},
            ...
        ]
        """
        engine = await self._get_engine()
        transport = await UdpTransportTarget.create(
            (self.host, self.port), timeout=self.timeout, retries=2
        )
        results: dict[str, dict] = {}

        # MAC 테이블 walk
        async for errInd, errStat, _errIdx, varBinds in bulk_walk_cmd(
            engine,
            CommunityData(self.community, mpModel=1),  # mpModel=1 = SNMPv2c
            transport,
            ContextData(),
            0,
            25,
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
                ip_part = oid_str[len(self.MAC_OID_PREFIX) + 1 :]
                mac_value = str(value)
                if not mac_value or "No Such" in mac_value:
                    continue
                results.setdefault(ip_part, {"ip_reversed": ip_part})
                results[ip_part]["mac"] = mac_value.lower()

        # 메인 OID walk (연결 상태/SSID)
        async for errInd, errStat, _errIdx, varBinds in bulk_walk_cmd(
            engine,
            CommunityData(self.community, mpModel=1),
            transport,
            ContextData(),
            0,
            25,
            ObjectType(ObjectIdentity(self.MAIN_OID_PREFIX)),
        ):
            if errInd or errStat:
                break  # 메인 OID 실패해도 MAC만으로 진행 가능
            for oid, value in varBinds:
                oid_str = str(oid)
                if not oid_str.startswith(self.MAIN_OID_PREFIX + "."):
                    break
                ip_part = oid_str[len(self.MAIN_OID_PREFIX) + 1 :]
                conn_value = str(value)
                if ip_part in results:
                    results[ip_part]["conn"] = conn_value

        return list(results.values())

    def parse_ssid(self, conn_value: Optional[str]) -> Optional[str]:
        """'5G VanaM_5G' → 'VanaM_5G'. LAN 등은 None."""
        if not conn_value:
            return None
        if conn_value.startswith("5G ") or conn_value.startswith("2.4G "):
            return conn_value.split(" ", 1)[1]
        return None

    def is_wifi(self, conn_value: Optional[str]) -> bool:
        """무선 연결인지 (LAN 제외)."""
        if not conn_value:
            return False
        return conn_value.startswith("5G ") or conn_value.startswith("2.4G ")

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

"""ipTIME SNMP 클라이언트. net-snmp CLI(snmpbulkwalk) subprocess 기반.

sync 호출. asyncio 의존성 없음.

표준 SNMP MIB ipNetToMediaPhysAddress 사용:
  OID: 1.3.6.1.2.1.4.22.1.2
  내용: ARP 테이블의 MAC 주소 (PhysAddress)

이전 easysnmp(C 바인딩)는 커널 소켓 I/O에 묶이면 GIL을 잡은 채 D-state로 빠져
파이썬 timeout/signal/예외/로그가 전부 무력화되는 장애가 있어, subprocess로
격리. 별도 프로세스이므로 SNMP가 묶여도 파이썬 메인 루프는 묶이지 않고,
OS `timeout`(SIGKILL)이 강제 종료를 보장.

OID 구조: 1.3.6.1.2.1.4.22.1.2.{ifIndex}.{IP옥텟1}.{IP옥텟2}.{IP옥텟3}.{IP옥텟4}
값 형식: snmpbulkwalk -On 출력 Hex-STRING 6바이트 (MAC 주소)
"""

import re
import subprocess


class SnmpClient:
    """표준 SNMP MIB 기반 ARP 테이블 클라이언트 (subprocess 격리)."""

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

    def walk_mac_table(self) -> list[dict]:
        """
        표준 ARP OID를 net-snmp CLI(snmpbulkwalk)로 walk.

        easysnmp(C 바인딩) 대신 subprocess로 격리:
        - C 레벨 블로킹이 나도 별도 프로세스라 파이썬 메인 루프는 묶이지 않음
        - OS `timeout`(SIGKILL)이 1차 강제 종료, subprocess timeout이 2차 안전장치

        반환 형식: [{"mac": "aabbccddeeff", "oid_index": "ifIndex.IP1.IP2.IP3.IP4"}, ...]
        실패 시 빈 리스트.
        """
        target = self.host if self.port == 161 else f"{self.host}:{self.port}"
        cmd = [
            "timeout", "--signal=KILL", "8",
            "snmpbulkwalk",
            "-v2c",
            "-c", self.community,
            "-t", str(self.timeout),
            "-r", str(self.retries),
            "-On",
            target,
            self.MAC_OID_PREFIX,
        ]

        try:
            proc = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=10,  # OS timeout(8s)이 1차, 이건 2차 안전장치
            )
        except subprocess.TimeoutExpired:
            # 메인 루프는 절대 묶이지 않음 — 이번 사이클만 빈 결과로 건너뜀
            return []
        except Exception:
            return []

        # returncode != 0 (timeout 124, SIGKILL 137, SNMP 오류 등)이어도
        # stdout에 부분 결과가 있을 수 있으니 그대로 파싱
        return self._parse_snmp_output(proc.stdout)

    def _parse_snmp_output(self, stdout: str) -> list[dict]:
        """snmpbulkwalk -On 출력을 파싱해서 [{mac, oid_index}, ...] 생성."""
        results: list[dict] = []
        seen_oids: set[str] = set()

        # 예: .1.3.6.1.2.1.4.22.1.2.10.192.168.0.13 = Hex-STRING: 5A 86 94 08 FB 98
        pattern = re.compile(
            r"^\.?" + re.escape(self.MAC_OID_PREFIX)
            + r"\.(\S+)\s+=\s+Hex-STRING:\s+([0-9A-Fa-f ]+?)\s*$"
        )

        for line in stdout.splitlines():
            m = pattern.match(line.strip())
            if not m:
                continue  # prefix 밖 / Hex-STRING 아닌 라인 / 에러 라인 무시

            oid_index = m.group(1)  # ifIndex.IP1.IP2.IP3.IP4
            if oid_index in seen_oids:
                continue
            seen_oids.add(oid_index)

            hex_clean = m.group(2).replace(" ", "")
            try:
                raw = bytes.fromhex(hex_clean)
            except ValueError:
                continue

            mac = self.normalize_mac(raw)  # 기존 함수 재사용 (6바이트 검증 + 소문자)
            if not mac:
                continue

            results.append({"mac": mac, "oid_index": oid_index})

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

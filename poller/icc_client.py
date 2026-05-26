"""ipTIME ICC HTTP API 클라이언트.

POST /cgi/service.cgi 엔드포인트로 station 리스트 조회.
세션 쿠키 자동 관리 (만료 시 재로그인).
"""

import requests
from typing import Optional


class IccClient:
    """ICC 세션 관리 + station 조회.

    사용:
        c = IccClient(url, user, pw, site_id)
        c.login()  # 초기 로그인
        stations = c.get_stations()  # 401 시 자동 재로그인
    """

    def __init__(self, url: str, user: str, password: str, site_id: int, timeout: int = 10):
        self.url = url
        self.user = user
        self.password = password
        self.site_id = site_id
        self.timeout = timeout
        self.session = requests.Session()
        self._logged_in = False

    def login(self) -> None:
        """ICC 로그인. 성공 시 세션 쿠키 자동 저장."""
        endpoint = f"{self.url}/cgi/service.cgi"
        payload = {
            "method": "session/login",
            "params": {"id": self.user, "pw": self.password},
        }
        r = self.session.post(endpoint, json=payload, timeout=self.timeout)
        r.raise_for_status()
        data = r.json()
        # 성공 응답: {"result":"done"}
        # 실패 응답: {"result":null, "error":{"code":..., "message":"..."}}
        if data.get("error") is not None:
            raise RuntimeError(f"ICC 로그인 실패: {data.get('error')}")
        if data.get("result") != "done":
            raise RuntimeError(f"ICC 로그인 응답 비정상: {data}")
        self._logged_in = True

    def get_stations(self) -> list[dict]:
        """현재 site_id에 연결된 station 리스트 조회.

        반환: list of {mac, info: {ip, name, ...}, connection: {type, upstream_mac, ...}}
        401 (Unauthenticated) 응답 시 자동 재로그인 후 1회 재시도.
        """
        if not self._logged_in:
            self.login()

        endpoint = f"{self.url}/cgi/service.cgi"
        payload = {
            "method": "site/query",
            "params": {
                "s_id": self.site_id,
                "data": {"method": "network/interface/lan/stations"},
                "direct": True,
            },
        }
        r = self.session.post(endpoint, json=payload, timeout=self.timeout)
        r.raise_for_status()
        data = r.json()

        # 인증 만료 패턴: {"result":null, "error":{"code":-31998, "message":"Unauthenticated"}}
        if self._is_auth_error(data):
            # 재로그인 후 1회 재시도
            self._logged_in = False
            self.login()
            r = self.session.post(endpoint, json=payload, timeout=self.timeout)
            r.raise_for_status()
            data = r.json()
            if self._is_auth_error(data):
                raise RuntimeError("ICC 재로그인 후에도 Unauthenticated 응답")

        # 응답 구조: {"result": {"result": [...stations...]}}
        result = data.get("result")
        if isinstance(result, dict):
            inner = result.get("result")
            if isinstance(inner, list):
                return inner
        # 비정상 응답
        raise RuntimeError(f"ICC station 응답 비정상: {str(data)[:200]}")

    @staticmethod
    def _is_auth_error(data: dict) -> bool:
        """Unauthenticated 패턴 식별."""
        err = data.get("error")
        if isinstance(err, dict):
            msg = err.get("message", "")
            if "Unauthenticated" in msg:
                return True
        # 또는 result.error 안에 있을 수도 있음
        result = data.get("result")
        if isinstance(result, dict):
            err = result.get("error")
            if isinstance(err, dict):
                msg = err.get("message", "")
                if "Unauthenticated" in msg:
                    return True
        return False

    def get_macs(self) -> list[str]:
        """station 리스트에서 MAC만 추출 (소문자 정규화).

        SNMP 폴러와 동일한 형태로 반환: ["aabbccddeeff", ...]
        """
        stations = self.get_stations()
        macs = []
        for s in stations:
            mac = s.get("mac", "")
            if mac:
                # "AA:BB:CC:DD:EE:FF" → "aabbccddeeff"
                normalized = mac.replace(":", "").replace("-", "").lower()
                if len(normalized) == 12:
                    macs.append(normalized)
        return macs

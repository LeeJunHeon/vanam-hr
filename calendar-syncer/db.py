"""psycopg2 DB 연결/쿼리. autocommit=True 패턴으로 트랜잭션 누수 차단.

1단계는 읽기 전용 — INSERT/UPDATE/DELETE 메서드 없음.
DB 연결 확인 + employees 매칭 맵 로드까지만 한다.
"""

import psycopg2
from psycopg2.extras import RealDictCursor


class Database:
    def __init__(self, host: str, port: int, dbname: str, user: str, password: str):
        self.conn_params = {
            "host": host,
            "port": port,
            "dbname": dbname,
            "user": user,
            "password": password,
        }
        self.conn = None
        self._connect()

    def _connect(self):
        """연결 + autocommit=True + 세션 timezone Asia/Seoul."""
        if self.conn:
            try:
                self.conn.close()
            except Exception:
                pass
        self.conn = psycopg2.connect(**self.conn_params)
        self.conn.autocommit = True

        with self.conn.cursor() as c:
            c.execute("SET TIME ZONE 'Asia/Seoul'")

    def _ensure_connected(self):
        """매 쿼리 전 ping. 끊겼으면 재연결."""
        try:
            with self.conn.cursor() as c:
                c.execute("SELECT 1")
        except psycopg2.Error:
            self._connect()

    def get_employee_email_map(self) -> dict:
        """활성 직원의 {email(소문자 정규화): id} dict 반환.

        email이 NULL인 직원은 제외. 캘린더 creator.email 매칭 테스트용.
        """
        self._ensure_connected()
        result: dict = {}
        with self.conn.cursor(cursor_factory=RealDictCursor) as c:
            c.execute(
                """
                SELECT id, email
                FROM hr.employees
                WHERE is_active = true AND email IS NOT NULL
                """
            )
            for row in c.fetchall():
                email = row.get("email")
                if not email:
                    continue
                normalized = email.lower().strip()
                if normalized:
                    result[normalized] = row["id"]
        return result

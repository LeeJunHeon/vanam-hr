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

    def get_calendar_sources(self) -> list[dict]:
        """동기화 대상 캘린더 목록 (sync_enabled=true만).

        반환: [
          {
            'id': int,
            'calendar_id': str,        # Google Calendar ID
            'calendar_name': str,
            'default_category_id': int,
            'default_category_code': str,  # 카테고리 코드 (편의)
          },
          ...
        ]
        """
        self._ensure_connected()
        result = []
        with self.conn.cursor(cursor_factory=RealDictCursor) as c:
            c.execute(
                """
                SELECT
                    cs.id, cs.calendar_id, cs.calendar_name,
                    cs.default_category_id, ac.code AS default_category_code
                FROM hr.calendar_sources cs
                JOIN hr.attendance_categories ac ON ac.id = cs.default_category_id
                WHERE cs.sync_enabled = true
                ORDER BY cs.id
                """
            )
            for row in c.fetchall():
                result.append({
                    "id": row["id"],
                    "calendar_id": row["calendar_id"],
                    "calendar_name": row["calendar_name"],
                    "default_category_id": row["default_category_id"],
                    "default_category_code": row["default_category_code"],
                })
        return result

    def get_keyword_rules(self, calendar_source_id: int) -> list[dict]:
        """해당 캘린더에 적용되는 키워드 룰 목록 (priority 오름차순).

        calendar_source_id가 일치하거나 NULL(글로벌)인 룰을 모두 반환.
        is_active=true만. priority 작은 값이 먼저 매칭 (긴 단어 우선 원칙).

        반환: [
          {
            'id': int,
            'keyword': str,
            'category_id': int,
            'category_code': str,
            'priority': int,
          },
          ...
        ]
        """
        self._ensure_connected()
        result = []
        with self.conn.cursor(cursor_factory=RealDictCursor) as c:
            c.execute(
                """
                SELECT
                    ckr.id, ckr.keyword, ckr.category_id,
                    ac.code AS category_code, ckr.priority
                FROM hr.calendar_keyword_rules ckr
                JOIN hr.attendance_categories ac ON ac.id = ckr.category_id
                WHERE ckr.is_active = true
                  AND (ckr.calendar_source_id = %s OR ckr.calendar_source_id IS NULL)
                ORDER BY ckr.priority ASC, ckr.id ASC
                """,
                (calendar_source_id,),
            )
            for row in c.fetchall():
                result.append({
                    "id": row["id"],
                    "keyword": row["keyword"],
                    "category_id": row["category_id"],
                    "category_code": row["category_code"],
                    "priority": row["priority"],
                })
        return result

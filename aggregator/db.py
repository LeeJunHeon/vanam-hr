"""psycopg2 DB 연결/쿼리. autocommit=True 패턴으로 트랜잭션 누수 차단."""

from datetime import date, datetime
from typing import Optional

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

    def get_active_employees(self) -> list[dict]:
        """활성 직원 목록. {id, code, name}."""
        self._ensure_connected()
        with self.conn.cursor(cursor_factory=RealDictCursor) as c:
            c.execute(
                """
                SELECT id, code, name
                FROM hr.employees
                WHERE is_active = true
                ORDER BY id
                """
            )
            return [dict(r) for r in c.fetchall()]

    def get_today_presence_raw(self, employee_id: int) -> list[dict]:
        """오늘 (Asia/Seoul 기준) 해당 직원의 presence_raw 모두. checked_at 오름차순.

        반환: [{checked_at: datetime, status: 'online'|'offline'}, ...]
        """
        self._ensure_connected()
        with self.conn.cursor(cursor_factory=RealDictCursor) as c:
            c.execute(
                """
                SELECT checked_at, status
                FROM hr.presence_raw
                WHERE employee_id = %s
                  AND (checked_at AT TIME ZONE 'Asia/Seoul')::date
                      = (NOW() AT TIME ZONE 'Asia/Seoul')::date
                ORDER BY checked_at ASC, id ASC
                """,
                (employee_id,),
            )
            return [dict(r) for r in c.fetchall()]

    def get_today_kst(self) -> date:
        """현재 시각 기준 KST 날짜."""
        self._ensure_connected()
        with self.conn.cursor() as c:
            c.execute("SELECT (NOW() AT TIME ZONE 'Asia/Seoul')::date")
            row = c.fetchone()
            return row[0]

    def upsert_attendance_daily(
        self,
        employee_id: int,
        work_date: date,
        check_in: Optional[datetime],
        check_out: Optional[datetime],
        work_minutes: Optional[int],
    ) -> Optional[int]:
        """attendance_daily UPSERT. is_overridden=true면 건드리지 않음.

        반환: 새/갱신된 row id. is_overridden=true로 막혀 변경 없으면 None.
        """
        self._ensure_connected()
        with self.conn.cursor() as c:
            c.execute(
                """
                INSERT INTO hr.attendance_daily
                    (employee_id, work_date, check_in, check_out, work_minutes,
                     created_at, updated_at)
                VALUES (%s, %s, %s, %s, %s, NOW(), NOW())
                ON CONFLICT (employee_id, work_date)
                DO UPDATE SET
                    check_in = EXCLUDED.check_in,
                    check_out = EXCLUDED.check_out,
                    work_minutes = EXCLUDED.work_minutes,
                    updated_at = NOW()
                WHERE hr.attendance_daily.is_overridden = false
                RETURNING id
                """,
                (employee_id, work_date, check_in, check_out, work_minutes),
            )
            row = c.fetchone()
            return row[0] if row else None

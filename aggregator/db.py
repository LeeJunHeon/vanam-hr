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

    def get_policy(self, key: str) -> Optional[str]:
        """hr.policy_settings에서 단일 정책 값 조회."""
        self._ensure_connected()
        with self.conn.cursor() as c:
            c.execute(
                "SELECT value FROM hr.policy_settings WHERE key = %s",
                (key,),
            )
            row = c.fetchone()
            return row[0] if row else None

    def get_active_employees(self) -> list[dict]:
        """활성 직원 목록. {id, employee_no, name}.

        hr.employees 실제 컬럼명은 employee_no (code 아님).
        """
        self._ensure_connected()
        with self.conn.cursor(cursor_factory=RealDictCursor) as c:
            c.execute(
                """
                SELECT id, employee_no, name
                FROM hr.employees
                WHERE is_active = true
                ORDER BY id
                """
            )
            return [dict(r) for r in c.fetchall()]

    def get_presence_raw_by_work_date(
        self,
        employee_id: int,
        work_date: date,
        cutoff_hour: int,
    ) -> list[dict]:
        """특정 work_date의 presence_raw 모두. checked_at 오름차순.

        work_date 귀속 규칙 (cutoff_hour=4 기준):
        - 5/26 04:00 ~ 5/27 03:59:59 → work_date=5/26
        - 5/27 04:00 ~ 5/28 03:59:59 → work_date=5/27

        반환: [{checked_at: datetime, status: 'online'|'offline'}, ...]
        """
        self._ensure_connected()
        with self.conn.cursor(cursor_factory=RealDictCursor) as c:
            c.execute(
                """
                SELECT checked_at, status
                FROM hr.presence_raw
                WHERE employee_id = %s
                  AND CASE
                      WHEN EXTRACT(HOUR FROM (checked_at AT TIME ZONE 'Asia/Seoul')) < %s
                      THEN ((checked_at AT TIME ZONE 'Asia/Seoul')::date - INTERVAL '1 day')::date
                      ELSE (checked_at AT TIME ZONE 'Asia/Seoul')::date
                  END = %s
                ORDER BY checked_at ASC, id ASC
                """,
                (employee_id, cutoff_hour, work_date),
            )
            return [dict(r) for r in c.fetchall()]

    def get_work_date_kst(self, cutoff_hour: int) -> date:
        """현재 시각의 work_date 반환 (cutoff_hour 이전이면 전일로 귀속).

        예: cutoff_hour=4 일 때
        - 03:59 → 어제 work_date
        - 04:00 → 오늘 work_date (정확히 4시 정각부터 새 날)
        - 23:59 → 오늘 work_date

        야간 근무자가 새벽까지 일하는 케이스를 위한 정책.
        """
        self._ensure_connected()
        with self.conn.cursor() as c:
            c.execute(
                """
                SELECT CASE
                    WHEN EXTRACT(HOUR FROM (NOW() AT TIME ZONE 'Asia/Seoul')) < %s
                    THEN ((NOW() AT TIME ZONE 'Asia/Seoul')::date - INTERVAL '1 day')::date
                    ELSE (NOW() AT TIME ZONE 'Asia/Seoul')::date
                END
                """,
                (cutoff_hour,),
            )
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

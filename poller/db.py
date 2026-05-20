"""psycopg2 DB 연결/쿼리. raw SQL 사용. 단일 연결 유지 + 끊김 시 재연결."""

from datetime import datetime
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
        if self.conn:
            try:
                self.conn.close()
            except Exception:
                pass
        # keyword args로 전달 — URL 파싱 우회, 특수문자(!, @ 등) 안전
        self.conn = psycopg2.connect(**self.conn_params)
        self.conn.autocommit = False

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

    def get_active_devices(self) -> list[dict]:
        """활성 디바이스 목록. {id, employee_id, mac_address(lowercase, no colons)}."""
        self._ensure_connected()
        with self.conn.cursor(cursor_factory=RealDictCursor) as c:
            c.execute(
                """
                SELECT id, employee_id, mac_address
                FROM hr.devices
                WHERE is_active = true
                """
            )
            return [dict(r) for r in c.fetchall()]

    def get_current_polling_schedule(self, now: datetime) -> int:
        """
        현재 시각에 매칭되는 polling_schedules 중 priority가 가장 높은 것의 intervalSeconds.
        매칭 없으면 기본 30초.
        dayOfWeek: 0=일, 1=월, ..., 6=토 (Python의 datetime.weekday()는 0=월, 6=일이므로 변환).
        """
        py_wday = now.weekday()  # 0=Mon ~ 6=Sun
        db_wday = (py_wday + 1) % 7  # 1=Mon, ..., 6=Sat, 0=Sun

        now_time = now.time()
        self._ensure_connected()
        with self.conn.cursor(cursor_factory=RealDictCursor) as c:
            c.execute(
                """
                SELECT interval_seconds, name, priority
                FROM hr.polling_schedules
                WHERE is_active = true
                  AND %s = ANY(day_of_week)
                  AND start_time <= %s
                  AND end_time >= %s
                ORDER BY priority DESC
                LIMIT 1
                """,
                (db_wday, now_time, now_time),
            )
            row = c.fetchone()
            return row["interval_seconds"] if row else 30

    def insert_presence(
        self,
        device_id: int,
        employee_id: int,
        status: str,
        ssid: Optional[str],
        raw_value: Optional[str],
    ):
        """hr.presence_raw에 한 행 INSERT."""
        self._ensure_connected()
        with self.conn.cursor() as c:
            c.execute(
                """
                INSERT INTO hr.presence_raw
                    (employee_id, device_id, checked_at, status, ssid, raw_value)
                VALUES (%s, %s, NOW(), %s, %s, %s)
                """,
                (employee_id, device_id, status, ssid, raw_value),
            )
            self.conn.commit()

    def get_last_status(self, device_id: int) -> Optional[str]:
        """이 디바이스의 가장 최근 presence_raw.status 조회 (중복 이벤트 방지용)."""
        self._ensure_connected()
        with self.conn.cursor() as c:
            c.execute(
                """
                SELECT status FROM hr.presence_raw
                WHERE device_id = %s
                ORDER BY checked_at DESC
                LIMIT 1
                """,
                (device_id,),
            )
            row = c.fetchone()
            return row[0] if row else None

    def update_last_seen(self, device_id: int):
        """devices.last_seen_at = NOW() 갱신."""
        self._ensure_connected()
        with self.conn.cursor() as c:
            c.execute(
                """
                UPDATE hr.devices SET last_seen_at = NOW(), updated_at = NOW()
                WHERE id = %s
                """,
                (device_id,),
            )
            self.conn.commit()

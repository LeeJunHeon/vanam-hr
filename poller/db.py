"""psycopg2 DB 연결/쿼리. autocommit=True 패턴으로 트랜잭션 누수 차단."""

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
        """연결 + autocommit=True + 세션 timezone Asia/Seoul.

        autocommit=True 이유:
        - psycopg2 기본은 False라 매 쿼리가 트랜잭션 안에서 실행됨
        - commit/rollback 안 하면 'idle in transaction' 상태 누적 → DB 일관성 위험
        - 출퇴근 폴러는 단순 SELECT/INSERT만 하므로 autocommit이 더 안전
        """
        if self.conn:
            try:
                self.conn.close()
            except Exception:
                pass
        self.conn = psycopg2.connect(**self.conn_params)
        self.conn.autocommit = True

        # 이 세션의 NOW(), CURRENT_TIMESTAMP를 KST 기준으로 (가독성)
        # TIMESTAMPTZ 컬럼은 어차피 UTC로 저장되니 데이터 영향 X
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

    def get_active_devices(self) -> list[dict]:
        """활성 디바이스 목록. {id, employee_id, mac_address}."""
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
        """현재 시각에 매칭되는 폴링 주기 (초). 기본 60."""
        py_wday = now.weekday()
        db_wday = (py_wday + 1) % 7

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
            return row["interval_seconds"] if row else 60

    def insert_presence(
        self,
        device_id: int,
        employee_id: int,
        status: str,
        ssid: Optional[str],
        raw_value: Optional[str],
    ) -> int:
        """presence_raw INSERT. RETURNING으로 새 id 반환 (INSERT 검증).

        autocommit=True 환경에서 INSERT는 즉시 영구 저장됨.
        새 id를 반환받지 못하면 INSERT 실패로 간주 (호출자에서 처리).
        """
        self._ensure_connected()
        with self.conn.cursor() as c:
            c.execute(
                """
                INSERT INTO hr.presence_raw
                    (employee_id, device_id, checked_at, status, ssid, raw_value)
                VALUES (%s, %s, NOW(), %s, %s, %s)
                RETURNING id
                """,
                (employee_id, device_id, status, ssid, raw_value),
            )
            row = c.fetchone()
            if row is None:
                raise RuntimeError("INSERT 실패: RETURNING id가 비어있음")
            return row[0]

    def get_last_status(self, device_id: int) -> Optional[str]:
        """이 디바이스의 가장 최근 presence_raw.status. 폴러 시작 시 1회만 사용 권장."""
        self._ensure_connected()
        with self.conn.cursor() as c:
            c.execute(
                """
                SELECT status FROM hr.presence_raw
                WHERE device_id = %s
                ORDER BY checked_at DESC, id DESC
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
                UPDATE hr.devices SET last_seen_at = NOW()
                WHERE id = %s
                """,
                (device_id,),
            )

"""psycopg2 DB 연결/쿼리. autocommit=True 패턴으로 트랜잭션 누수 차단.

Phase 6-2A: 캘린더 소스/키워드 룰 조회 추가 (읽기 전용).
Phase 6-2B: attendance_requests UPSERT 추가 (캘린더 일정 → 자동 결재 요청).
Phase 6-2L+ B-2: 공휴일 캘린더 → hr.holidays UPSERT.
"""

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

    def upsert_attendance_request(
        self,
        employee_id: int,
        category_id: int,
        start_date: str,        # "YYYY-MM-DD"
        end_date: str,          # "YYYY-MM-DD"
        external_event_id: str,
        reason: str,
        corrected_check_in: Optional[datetime] = None,    # 시간 지정 일정만
        corrected_check_out: Optional[datetime] = None,
    ) -> int:
        """Google Calendar 일정 → attendance_request UPSERT.

        UNIQUE (external_source, external_event_id)로 중복 방지.
        캘린더 일정 수정 시 자동 UPDATE (employee/category/날짜/이유 모두 갱신).

        Args:
            employee_id: 매칭된 직원 ID
            category_id: 판정된 카테고리 ID (ANNUAL, BUSINESS_TRIP, ETC 등)
            start_date: 일정 시작 날짜 "YYYY-MM-DD"
            end_date: 일정 종료 날짜 "YYYY-MM-DD" (inclusive)
            external_event_id: Google Calendar event id
            reason: 일정 제목 (캘린더 summary 그대로)
            corrected_check_in: 시간 지정 일정의 시작 시각 (TIMESTAMPTZ), 종일은 None
            corrected_check_out: 시간 지정 일정의 종료 시각 (TIMESTAMPTZ), 종일은 None

        Returns:
            INSERT/UPDATE된 attendance_request id
        """
        sql = """
            INSERT INTO hr.attendance_requests (
                employee_id, category_id, request_type,
                start_date, end_date, reason,
                corrected_check_in, corrected_check_out,
                external_source, external_event_id,
                status, requested_at, updated_at
            )
            VALUES (
                %s, %s, 'calendar_auto',
                %s, %s, %s,
                %s, %s,
                'google_calendar', %s,
                'auto_approved', NOW(), NOW()
            )
            ON CONFLICT (external_source, external_event_id, employee_id)
            DO UPDATE SET
                category_id = EXCLUDED.category_id,
                start_date = EXCLUDED.start_date,
                end_date = EXCLUDED.end_date,
                reason = EXCLUDED.reason,
                corrected_check_in = EXCLUDED.corrected_check_in,
                corrected_check_out = EXCLUDED.corrected_check_out,
                status = 'auto_approved',
                updated_at = NOW()
            RETURNING id
        """
        self._ensure_connected()
        with self.conn.cursor() as c:
            c.execute(sql, (
                employee_id, category_id,
                start_date, end_date, reason,
                corrected_check_in, corrected_check_out,
                external_event_id,
            ))
            row = c.fetchone()
            return row[0]

    def get_holiday_calendar_id(self) -> Optional[str]:
        """Phase 6-2L+ B-2: hr.policy_settings에서 'holiday_calendar_id' 값 조회.

        값이 없거나 빈 문자열이면 None 반환 → 공휴일 동기화 skip.
        """
        self._ensure_connected()
        with self.conn.cursor() as c:
            c.execute(
                "SELECT value FROM hr.policy_settings WHERE key = 'holiday_calendar_id'"
            )
            row = c.fetchone()
            if row is None:
                return None
            value = (row[0] or "").strip()
            return value if value else None

    def upsert_holiday(self, holiday_date: date, name: str) -> None:
        """Phase 6-2L+ B-2: hr.holidays UPSERT (source='calendar').

        같은 날짜에 다른 이름의 공휴일이 들어오면 마지막 동기화 값으로 갱신됨.
        """
        self._ensure_connected()
        with self.conn.cursor() as c:
            c.execute(
                """
                INSERT INTO hr.holidays
                    (holiday_date, name, source, created_at, updated_at)
                VALUES (%s, %s, 'calendar', NOW(), NOW())
                ON CONFLICT (holiday_date)
                DO UPDATE SET
                    name = EXCLUDED.name,
                    source = 'calendar',
                    updated_at = NOW()
                """,
                (holiday_date, name),
            )

    # ========================================================================
    # 데이터 보관기간 정리 (purge) — count/delete 쌍.
    # retention은 호출자가 '3 months' 같은 문자열로 넘기고 retention::interval로 사용.
    # 실제 삭제 여부는 syncer.purge_old_data()의 PURGE_ENABLED 가드가 결정한다.
    # ========================================================================

    def count_old_presence_raw(self, retention: str) -> tuple:
        """보관기간 지난 presence_raw 대상: (건수, MIN(checked_at), MAX(checked_at))."""
        self._ensure_connected()
        with self.conn.cursor() as c:
            c.execute(
                """
                SELECT COUNT(*), MIN(checked_at), MAX(checked_at)
                FROM hr.presence_raw
                WHERE checked_at < NOW() - %s::interval
                """,
                (retention,),
            )
            return c.fetchone()

    def delete_old_presence_raw(self, retention: str) -> int:
        """보관기간 지난 presence_raw 삭제 → 삭제 건수."""
        self._ensure_connected()
        with self.conn.cursor() as c:
            c.execute(
                """
                DELETE FROM hr.presence_raw
                WHERE checked_at < NOW() - %s::interval
                """,
                (retention,),
            )
            return c.rowcount

    def count_old_attendance_daily_unconfirmed(self, retention: str) -> tuple:
        """보관기간 지난 미확정 attendance_daily 대상:
        (건수, MIN(work_date), MAX(work_date)). ★ is_confirmed = false 가드."""
        self._ensure_connected()
        with self.conn.cursor() as c:
            c.execute(
                """
                SELECT COUNT(*), MIN(work_date), MAX(work_date)
                FROM hr.attendance_daily
                WHERE is_confirmed = false
                  AND work_date < (CURRENT_DATE - %s::interval)::date
                """,
                (retention,),
            )
            return c.fetchone()

    def delete_old_attendance_daily_unconfirmed(self, retention: str) -> int:
        """보관기간 지난 미확정 attendance_daily 삭제 → 삭제 건수. ★ is_confirmed = false."""
        self._ensure_connected()
        with self.conn.cursor() as c:
            c.execute(
                """
                DELETE FROM hr.attendance_daily
                WHERE is_confirmed = false
                  AND work_date < (CURRENT_DATE - %s::interval)::date
                """,
                (retention,),
            )
            return c.rowcount

    def count_old_attendance_daily_confirmed(self, retention: str) -> tuple:
        """보관기간 지난 확정 attendance_daily 대상:
        (건수, MIN(work_date), MAX(work_date)). ★ is_confirmed = true 가드."""
        self._ensure_connected()
        with self.conn.cursor() as c:
            c.execute(
                """
                SELECT COUNT(*), MIN(work_date), MAX(work_date)
                FROM hr.attendance_daily
                WHERE is_confirmed = true
                  AND work_date < (CURRENT_DATE - %s::interval)::date
                """,
                (retention,),
            )
            return c.fetchone()

    def delete_old_attendance_daily_confirmed(self, retention: str) -> int:
        """보관기간 지난 확정 attendance_daily 삭제 → 삭제 건수. ★ is_confirmed = true."""
        self._ensure_connected()
        with self.conn.cursor() as c:
            c.execute(
                """
                DELETE FROM hr.attendance_daily
                WHERE is_confirmed = true
                  AND work_date < (CURRENT_DATE - %s::interval)::date
                """,
                (retention,),
            )
            return c.rowcount

    def count_old_attendance_requests(self, retention: str) -> tuple:
        """보관기간 지난 attendance_requests 대상: (건수, MIN(end_date), MAX(end_date))."""
        self._ensure_connected()
        with self.conn.cursor() as c:
            c.execute(
                """
                SELECT COUNT(*), MIN(end_date), MAX(end_date)
                FROM hr.attendance_requests
                WHERE end_date < (CURRENT_DATE - %s::interval)::date
                """,
                (retention,),
            )
            return c.fetchone()

    def delete_old_attendance_requests(self, retention: str) -> int:
        """보관기간 지난 attendance_requests 삭제 → 삭제 건수.

        ★ 2단계 처리: trip_participant_dates의 링크를 먼저 NULL로 끊고(행은 보존),
        그 다음 attendance_requests를 삭제한다. (FK 제약 위반 방지)
        """
        self._ensure_connected()
        with self.conn.cursor() as c:
            # 1단계: 출장 참여일자의 신청서 링크만 끊는다 (trip_participant_dates 행은 절대 삭제 X)
            c.execute(
                """
                UPDATE hr.trip_participant_dates
                SET attendance_request_id = NULL
                WHERE attendance_request_id IN (
                    SELECT id FROM hr.attendance_requests
                    WHERE end_date < (CURRENT_DATE - %s::interval)::date
                )
                """,
                (retention,),
            )
            # 2단계: 신청서 삭제
            c.execute(
                """
                DELETE FROM hr.attendance_requests
                WHERE end_date < (CURRENT_DATE - %s::interval)::date
                """,
                (retention,),
            )
            return c.rowcount

    def count_old_monthly_confirmations(self, retention: str) -> tuple:
        """보관기간 지난 monthly_confirmations 대상:
        (건수, MIN(created_at), MAX(created_at))."""
        self._ensure_connected()
        with self.conn.cursor() as c:
            c.execute(
                """
                SELECT COUNT(*), MIN(created_at), MAX(created_at)
                FROM hr.monthly_confirmations
                WHERE created_at < NOW() - %s::interval
                """,
                (retention,),
            )
            return c.fetchone()

    def delete_old_monthly_confirmations(self, retention: str) -> int:
        """보관기간 지난 monthly_confirmations 삭제 → 삭제 건수."""
        self._ensure_connected()
        with self.conn.cursor() as c:
            c.execute(
                """
                DELETE FROM hr.monthly_confirmations
                WHERE created_at < NOW() - %s::interval
                """,
                (retention,),
            )
            return c.rowcount

"""psycopg2 DB 연결/쿼리. autocommit=True 패턴으로 트랜잭션 누수 차단."""

from datetime import date, datetime, timedelta
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
        """활성 직원 목록. {id, employee_no, name, email}.

        hr.employees 실제 컬럼명은 employee_no (code 아님).
        email은 끊김 알림 발송에 사용(없으면 알림 스킵).
        """
        self._ensure_connected()
        with self.conn.cursor(cursor_factory=RealDictCursor) as c:
            c.execute(
                """
                SELECT id, employee_no, name, email
                FROM hr.employees
                WHERE is_active = true
                ORDER BY id
                """
            )
            return [dict(r) for r in c.fetchall()]

    def get_active_absence_today(
        self, employee_id: int, work_date: date
    ) -> Optional[str]:
        """오늘(work_date)에 걸쳐 승인된 '회사 부재' 신청이 있으면 그 카테고리 code 반환.

        부재 = 휴가류(type IN 'leave','long_leave') 또는 회사 밖 근무
              (외근/출장/재택, code IN 'EXTERNAL_WORK','BUSINESS_TRIP','REMOTE_WORK').
        get_auto_approved_request는 external_source='google_calendar'만 잡아
        수동 결재된 연차/반차/병가가 누락되므로, attendance_requests를 직접 조회.
        """
        self._ensure_connected()
        with self.conn.cursor() as c:
            c.execute(
                """
                SELECT cat.code
                FROM hr.attendance_requests r
                JOIN hr.attendance_categories cat ON r.category_id = cat.id
                WHERE r.employee_id = %s
                  AND r.status IN ('approved', 'auto_approved', 'auto_delegated')
                  AND r.start_date <= %s
                  AND r.end_date >= %s
                  AND (cat.type IN ('leave', 'long_leave')
                       OR cat.code IN ('EXTERNAL_WORK', 'BUSINESS_TRIP', 'REMOTE_WORK'))
                ORDER BY r.requested_at DESC
                LIMIT 1
                """,
                (employee_id, work_date, work_date),
            )
            row = c.fetchone()
            return row[0] if row else None

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

    def get_employee_shift(
        self,
        employee_id: int,
        work_date: date,
    ) -> Optional[dict]:
        """직원의 work_date 기준 시프트 schedule point 반환.

        employee_shifts에서 (start_date <= work_date) AND (end_date IS NULL OR end_date >= work_date)
        인 row를 찾고, 그 패턴의 schedule에서 (work_date - start_date).days % cycle_days
        인덱스의 point를 반환.

        반환: {patternId, patternName, dayIndex, start: 'HH:MM' | None, end: 'HH:MM' | None, type: str} or None
        - type='off' 또는 start/end가 None이면 그 날은 휴무 — 호출자가 판정
        - 매칭되는 시프트가 없으면 None (시프트 미배정)
        """
        self._ensure_connected()
        with self.conn.cursor(cursor_factory=RealDictCursor) as c:
            c.execute(
                """
                SELECT es.pattern_id, sp.name AS pattern_name,
                       es.start_date, sp.cycle_days, sp.schedule
                FROM hr.employee_shifts es
                JOIN hr.shift_patterns sp ON sp.id = es.pattern_id
                WHERE es.employee_id = %s
                  AND es.start_date <= %s
                  AND (es.end_date IS NULL OR es.end_date >= %s)
                  AND sp.is_active = true
                ORDER BY es.start_date DESC
                LIMIT 1
                """,
                (employee_id, work_date, work_date),
            )
            row = c.fetchone()
            if not row:
                return None

            pattern_id = row["pattern_id"]
            pattern_name = row["pattern_name"]
            start_date = row["start_date"]
            cycle_days = row["cycle_days"]
            schedule = row["schedule"]

            if not isinstance(schedule, list) or cycle_days < 1:
                return None

            # day_offset 계산 (요일 고정: start_date가 속한 주의 월요일을 기준점으로)
            # weekday(): 월=0 … 일=6 → start_date를 그 주 월요일로 내린 뒤 사이클 계산
            anchor = start_date - timedelta(days=start_date.weekday())
            day_offset = (work_date - anchor).days % cycle_days

            # schedule에서 dayIndex == day_offset 인 point 찾기
            point = None
            for p in schedule:
                if isinstance(p, dict) and p.get("dayIndex") == day_offset:
                    point = p
                    break
            if point is None:
                return None

            return {
                "patternId": pattern_id,
                "patternName": pattern_name,
                "dayIndex": day_offset,
                "start": point.get("start"),
                "end": point.get("end"),
                "type": point.get("type", "day"),
            }

    def get_auto_approved_request(
        self,
        employee_id: int,
        work_date: date,
    ) -> Optional[dict]:
        """캘린더에서 자동 등록된 attendance_request 조회 (Phase 6-2B 보정용).

        work_date가 start_date~end_date 범위에 들어가는 가장 최근 요청 반환.
        external_source='google_calendar' AND status='auto_approved' 만 대상.

        반환: {
            'id': int,
            'category_id': int,
            'start_date': date,
            'end_date': date,
            'corrected_check_in': datetime or None,     # 종일 일정은 None
            'corrected_check_out': datetime or None,
            'reason': str,
          } 또는 None (없을 때)
        """
        self._ensure_connected()
        with self.conn.cursor() as c:
            c.execute(
                """
                SELECT id, category_id, start_date, end_date,
                       corrected_check_in, corrected_check_out, reason
                FROM hr.attendance_requests
                WHERE employee_id = %s
                  AND status = 'auto_approved'
                  AND external_source = 'google_calendar'
                  AND start_date <= %s
                  AND end_date >= %s
                ORDER BY requested_at DESC
                LIMIT 1
                """,
                (employee_id, work_date, work_date),
            )
            row = c.fetchone()
            if row is None:
                return None
            return {
                "id": row[0],
                "category_id": row[1],
                "start_date": row[2],
                "end_date": row[3],
                "corrected_check_in": row[4],
                "corrected_check_out": row[5],
                "reason": row[6],
            }

    def get_active_requests(self, employee_id, work_date):
        """그날 겹치는 모든 유효 근태 요청(소스 무관) 반환.
        status IN (approved, auto_approved, auto_delegated),
        start_date <= work_date <= end_date.
        없으면 [].
        """
        self._ensure_connected()
        with self.conn.cursor(cursor_factory=RealDictCursor) as c:
            c.execute(
                """
                SELECT r.id, r.category_id,
                       c.code AS category_code, c.type AS category_type,
                       r.corrected_check_in, r.corrected_check_out,
                       r.reason, r.external_source, r.requested_at
                FROM hr.attendance_requests r
                JOIN hr.attendance_categories c ON c.id = r.category_id
                WHERE r.employee_id = %s
                  AND r.status IN ('approved', 'auto_approved', 'auto_delegated')
                  AND r.start_date <= %s
                  AND r.end_date >= %s
                ORDER BY r.requested_at ASC
                """,
                (employee_id, work_date, work_date),
            )
            return [dict(r) for r in c.fetchall()]

    def upsert_attendance_daily(
        self,
        employee_id: int,
        work_date: date,
        check_in: Optional[datetime],
        check_out: Optional[datetime],
        work_minutes: Optional[int],
        auto_status: Optional[str] = None,
        category_id: Optional[int] = None,        # Phase 6-2B: 캘린더 보정 카테고리
        is_overridden: bool = False,              # Phase 6-2B: 캘린더 보정이면 True
        override_source: Optional[str] = None,    # Phase 6-2L+ C: 'calendar' | 'manual' | None
    ) -> Optional[int]:
        """attendance_daily UPSERT.

        auto_status: 자동 판정 결과 ('normal', 'absent' 등 또는 None).
        category_id: Phase 6-2B 캘린더 보정 시 카테고리 (ANNUAL, BUSINESS_TRIP 등).
        is_overridden: True면 이번 INSERT 자체가 is_overridden=true로 박힘.
        override_source: 보정 출처 — 'calendar'면 다음 사이클에 자기 자신을 갱신 가능,
                        'manual'(또는 NULL+is_overridden=true)이면 보호.

        WHERE 절 (Phase 6-2L+ C):
          - is_overridden=false → 일반 갱신 (기존 동작)
          - override_source='calendar' → 캘린더 보정 행은 매 사이클 재갱신 허용
            (캘린더 일정의 사후 수정이 근태에 반영되도록)
          - 그 외(수동정정, override_source='manual') → 보호
        반환: 새/갱신된 row id. WHERE 절에 막혀 변경 없으면 None.
        """
        self._ensure_connected()
        with self.conn.cursor() as c:
            c.execute(
                """
                INSERT INTO hr.attendance_daily
                    (employee_id, work_date, check_in, check_out, work_minutes,
                     auto_status, category_id, is_overridden, override_source,
                     created_at, updated_at)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, NOW(), NOW())
                ON CONFLICT (employee_id, work_date)
                DO UPDATE SET
                    check_in = EXCLUDED.check_in,
                    check_out = EXCLUDED.check_out,
                    work_minutes = EXCLUDED.work_minutes,
                    auto_status = EXCLUDED.auto_status,
                    category_id = EXCLUDED.category_id,
                    is_overridden = EXCLUDED.is_overridden,
                    override_source = EXCLUDED.override_source,
                    updated_at = NOW()
                WHERE hr.attendance_daily.is_overridden = false
                   OR hr.attendance_daily.override_source = 'calendar'
                RETURNING id
                """,
                (employee_id, work_date, check_in, check_out, work_minutes,
                 auto_status, category_id, is_overridden, override_source),
            )
            row = c.fetchone()
            return row[0] if row else None

    def get_holiday(self, work_date: date) -> Optional[str]:
        """Phase 6-2L+ B-3: 해당 날짜의 공휴일 이름 조회 (없으면 None).

        결근(absent) 판정 면제용. work_date당 1회만 호출(aggregate_today에서 캐싱).
        """
        self._ensure_connected()
        with self.conn.cursor() as c:
            c.execute(
                "SELECT name FROM hr.holidays WHERE holiday_date = %s",
                (work_date,),
            )
            row = c.fetchone()
            return row[0] if row else None

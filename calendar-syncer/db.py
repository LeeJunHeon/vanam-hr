"""psycopg2 DB 연결/쿼리. autocommit=True 패턴으로 트랜잭션 누수 차단.

Phase 6-2A: 캘린더 소스/키워드 룰 조회 추가 (읽기 전용).
Phase 6-2B: attendance_requests UPSERT 추가 (캘린더 일정 → 자동 결재 요청).
Phase 6-2L+ B-2: 공휴일 캘린더 → hr.holidays UPSERT.
B-다: 일정 동기화는 calendar_sync.py 가 판단하고, 여기는 작은 SQL 함수만 둔다.
      한 행의 신청 변경 + 근태 반영은 transaction() 으로 묶는다(끝나면 autocommit 복원).
"""

from contextlib import contextmanager
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
        self._in_tx = False
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
        """매 쿼리 전 ping. 끊겼으면 재연결. 트랜잭션 중에는 재연결하지 않는다."""
        if self._in_tx:
            return
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

    # ========================================================================
    # 일정 동기화 (B-다) — 판단은 calendar_sync.py. 여기는 SQL 만.
    # ========================================================================

    @contextmanager
    def transaction(self):
        """이 블록만 트랜잭션(autocommit=False). 끝나면 commit/rollback 후 autocommit 복원."""
        self._ensure_connected()
        self.conn.autocommit = False
        self._in_tx = True
        try:
            yield
            self.conn.commit()
        except Exception:
            self.conn.rollback()
            raise
        finally:
            self._in_tx = False
            self.conn.autocommit = True

    def get_policy(self, key: str) -> Optional[str]:
        """hr.policy_settings 단일 값. 없으면 None."""
        self._ensure_connected()
        with self.conn.cursor() as c:
            c.execute("SELECT value FROM hr.policy_settings WHERE key = %s", (key,))
            row = c.fetchone()
            return row[0] if row else None

    def get_category_types(self) -> dict:
        """{category_id: type} — 근태 반영 대상(휴가·외근) 판정용."""
        self._ensure_connected()
        with self.conn.cursor() as c:
            c.execute("SELECT id, type FROM hr.attendance_categories")
            return {r[0]: r[1] for r in c.fetchall()}

    def find_calendar_request(self, external_event_id: str, employee_id: int) -> Optional[dict]:
        """이 일정·직원의 google_calendar 신청 행 (없으면 None)."""
        self._ensure_connected()
        with self.conn.cursor(cursor_factory=RealDictCursor) as c:
            c.execute(
                """
                SELECT id, status, cancel_source, category_id, start_date, end_date,
                       reason, corrected_check_in, corrected_check_out
                FROM hr.attendance_requests
                WHERE external_source = 'google_calendar'
                  AND external_event_id = %s
                  AND employee_id = %s
                LIMIT 1
                """,
                (external_event_id, employee_id),
            )
            row = c.fetchone()
            return dict(row) if row else None

    def hr_overlap_exists(self, employee_id: int, category_id: int, start_date: date, end_date: date) -> bool:
        """같은 카테고리의 HR 신청과 기간이 겹치는가 (새로 만들거나 되살릴 때만 검사).

        연차를 HR 에 신청하고 구글 캘린더에도 적어두는 관행 때문에 같은 일정이
        2건이 되어 연차가 이중 차감됐다(215/224, 237/348). 2026-09 수정.
        카테고리가 같을 때만 중복으로 본다 — 연차 기간에 겹치는 출장·재택 등
        다른 종류의 일정까지 막으면 안 된다.
        """
        self._ensure_connected()
        with self.conn.cursor() as c:
            c.execute(
                """
                SELECT id FROM hr.attendance_requests
                WHERE employee_id = %s
                  AND category_id = %s
                  AND request_type <> 'calendar_auto'
                  AND status IN ('approved', 'auto_approved', 'auto_delegated', 'pending')
                  AND start_date <= %s::date
                  AND end_date   >= %s::date
                LIMIT 1
                """,
                (employee_id, category_id, end_date, start_date),
            )
            return c.fetchone() is not None

    def insert_calendar_request(self, employee_id: int, external_event_id: str, new: dict) -> int:
        """새 google_calendar 신청 (auto_approved). 반환: id."""
        self._ensure_connected()
        with self.conn.cursor() as c:
            c.execute(
                """
                INSERT INTO hr.attendance_requests (
                    employee_id, category_id, request_type,
                    start_date, end_date, reason,
                    corrected_check_in, corrected_check_out,
                    external_source, external_event_id,
                    status, requested_at, updated_at
                )
                VALUES (%s, %s, 'calendar_auto', %s, %s, %s, %s, %s,
                        'google_calendar', %s, 'auto_approved', NOW(), NOW())
                RETURNING id
                """,
                (
                    employee_id, new["category_id"],
                    new["start_date"], new["end_date"], new.get("reason"),
                    new.get("ci"), new.get("co"),
                    external_event_id,
                ),
            )
            return c.fetchone()[0]

    def update_calendar_request(
        self,
        request_id: int,
        expected_status: str,
        expected_cancel_source: Optional[str],
        new: dict,
        revive: bool,
    ) -> bool:
        """값 갱신(조건: 읽은 상태 그대로). revive=True 면 auto_approved + cancel_source NULL.
        0건(그 사이 웹 취소 등)이면 False."""
        self._ensure_connected()
        status_sql = ", status = 'auto_approved', cancel_source = NULL" if revive else ""
        cancel_cond = "AND cancel_source = %s" if expected_cancel_source is not None else ""
        params = [
            new["category_id"], new["start_date"], new["end_date"], new.get("reason"),
            new.get("ci"), new.get("co"), request_id, expected_status,
        ]
        if expected_cancel_source is not None:
            params.append(expected_cancel_source)
        with self.conn.cursor() as c:
            c.execute(
                f"""
                UPDATE hr.attendance_requests
                SET category_id = %s, start_date = %s, end_date = %s, reason = %s,
                    corrected_check_in = %s, corrected_check_out = %s,
                    updated_at = NOW(){status_sql}
                WHERE id = %s
                  AND external_source = 'google_calendar'
                  AND status = %s
                  {cancel_cond}
                """,
                params,
            )
            return c.rowcount == 1

    def list_live_calendar_requests_covering(self, today: date) -> list[dict]:
        """오늘을 덮는 살아 있는 google_calendar 신청 (정리 후보)."""
        self._ensure_connected()
        with self.conn.cursor(cursor_factory=RealDictCursor) as c:
            c.execute(
                """
                SELECT id, employee_id, external_event_id, start_date, end_date,
                       category_id, status, corrected_check_in, corrected_check_out
                FROM hr.attendance_requests
                WHERE external_source = 'google_calendar'
                  AND status IN ('approved', 'auto_approved', 'auto_delegated')
                  AND start_date <= %s
                  AND end_date >= %s
                ORDER BY id
                """,
                (today, today),
            )
            return [dict(r) for r in c.fetchall()]

    def has_trip_report(self, request_id: int) -> bool:
        self._ensure_connected()
        with self.conn.cursor() as c:
            c.execute(
                "SELECT 1 FROM hr.trip_reports WHERE attendance_request_id = %s LIMIT 1",
                (request_id,),
            )
            return c.fetchone() is not None

    def cancel_calendar_request(self, request_id: int, expected_status: str, expected_end: date) -> bool:
        """캘린더에서 빠진 오늘 시작 기록 취소 (cancel_source='calendar_sync'). 조건부."""
        self._ensure_connected()
        with self.conn.cursor() as c:
            c.execute(
                """
                UPDATE hr.attendance_requests
                SET status = 'cancelled', cancel_source = 'calendar_sync', updated_at = NOW()
                WHERE id = %s AND external_source = 'google_calendar'
                  AND status = %s AND end_date = %s
                """,
                (request_id, expected_status, expected_end),
            )
            return c.rowcount == 1

    def shorten_calendar_request(
        self, request_id: int, expected_status: str, expected_end: date, new_end: date
    ) -> bool:
        """캘린더에서 빠진 지난 시작 기록의 종료일을 어제로 단축(지난 날 보존). 조건부."""
        self._ensure_connected()
        with self.conn.cursor() as c:
            c.execute(
                """
                UPDATE hr.attendance_requests
                SET end_date = %s, updated_at = NOW()
                WHERE id = %s AND external_source = 'google_calendar'
                  AND status = %s AND end_date = %s
                """,
                (new_end, request_id, expected_status, expected_end),
            )
            return c.rowcount == 1

    # ── 근태(attendance_daily) 반영 — calendar_sync.reflect_removed_day 가 쓴다 ──

    def get_daily_row(self, employee_id: int, work_date: date) -> Optional[dict]:
        self._ensure_connected()
        with self.conn.cursor(cursor_factory=RealDictCursor) as c:
            c.execute(
                """
                SELECT id, is_overridden, override_source, category_id, check_in, check_out
                FROM hr.attendance_daily
                WHERE employee_id = %s AND work_date = %s
                """,
                (employee_id, work_date),
            )
            row = c.fetchone()
            return dict(row) if row else None

    def find_live_leave_work_requests(
        self, employee_id: int, work_date: date, exclude_request_id: Optional[int]
    ) -> list[dict]:
        """그 날을 덮는 살아 있는 휴가·외근(출처 무관), id 오름차순.
        lib/attendance-live-requests.ts findLiveLeaveWorkRequests 와 같은 조건."""
        self._ensure_connected()
        with self.conn.cursor(cursor_factory=RealDictCursor) as c:
            c.execute(
                """
                SELECT r.id, r.category_id
                FROM hr.attendance_requests r
                JOIN hr.attendance_categories cat ON cat.id = r.category_id
                WHERE r.employee_id = %s
                  AND r.status IN ('approved', 'auto_approved', 'auto_delegated')
                  AND r.start_date <= %s AND r.end_date >= %s
                  AND cat.type IN ('leave', 'long_leave', 'work')
                  AND (%s::int IS NULL OR r.id <> %s::int)
                ORDER BY r.id
                """,
                (employee_id, work_date, work_date, exclude_request_id, exclude_request_id),
            )
            return [dict(r) for r in c.fetchall()]

    def set_daily_category(self, daily_id: int, category_id: Optional[int]) -> None:
        self._ensure_connected()
        with self.conn.cursor() as c:
            c.execute(
                "UPDATE hr.attendance_daily SET category_id = %s, updated_at = NOW() WHERE id = %s",
                (category_id, daily_id),
            )

    def delete_daily_if_no_files(self, daily_id: int) -> bool:
        """사유 첨부가 없을 때만 행 삭제."""
        self._ensure_connected()
        with self.conn.cursor() as c:
            c.execute(
                """
                DELETE FROM hr.attendance_daily d
                WHERE d.id = %s
                  AND NOT EXISTS (SELECT 1 FROM hr.attendance_reason_files f WHERE f.daily_id = d.id)
                """,
                (daily_id,),
            )
            return c.rowcount == 1

    def mark_recalc(self, employee_id: int, work_date: date) -> None:
        """지난 날 재계산 표시 — lib/attendance-recalc.ts markAttendanceRecalc 와 같다
        (한쪽을 바꾸면 다른 쪽도). 호출자가 오늘 미만만 넘긴다.
        행이 있으면 needs_recalc=true, 없으면 needs_recalc 만 켠 빈 행."""
        self._ensure_connected()
        with self.conn.cursor() as c:
            c.execute(
                """
                INSERT INTO hr.attendance_daily
                    (employee_id, work_date, needs_recalc, created_at, updated_at)
                VALUES (%s, %s, true, NOW(), NOW())
                ON CONFLICT (employee_id, work_date)
                DO UPDATE SET needs_recalc = true
                """,
                (employee_id, work_date),
            )

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

    def reconcile_month_holidays(self, year: int, month: int, fresh: dict) -> tuple:
        """KASI 조회 성공한 '한 달'을 실제 공휴일로 맞춘다(reconcile).

        fresh = {'YYYY-MM-DD': 명칭}. 해당 월 범위 [month_start, next_month_start)에서:
          - source != 'manual' 이고 fresh에 없는 행 삭제
          - fresh의 각 날짜를 source='kasi'로 upsert (기존이 manual이면 건드리지 않음)
        반환 (upsert건수, 삭제건수). 삭제/upsert는 반드시 이 월 범위로만.

        조회 실패는 상위(_fetch_kasi_holidays)에서 걸러져 이 메서드가 호출되지 않으므로,
        여기 도달 = 조회 성공. fresh가 비어 있으면 그 달 non-manual 행을 비운다.

        autocommit=True 기본이므로, 삭제+upsert를 한 트랜잭션으로 묶기 위해
        일시적으로 autocommit을 끄고 commit 후 원복한다.
        """
        self._ensure_connected()
        month_start = date(year, month, 1)
        next_month_start = (
            date(year + 1, 1, 1) if month == 12 else date(year, month + 1, 1)
        )
        keep = [
            date(int(k[0:4]), int(k[5:7]), int(k[8:10])) for k in fresh.keys()
        ]

        self.conn.autocommit = False
        try:
            with self.conn.cursor() as c:
                if keep:
                    c.execute(
                        """
                        DELETE FROM hr.holidays
                        WHERE holiday_date >= %s AND holiday_date < %s
                          AND source <> 'manual'
                          AND holiday_date <> ALL(%s::date[])
                        """,
                        (month_start, next_month_start, keep),
                    )
                else:
                    c.execute(
                        """
                        DELETE FROM hr.holidays
                        WHERE holiday_date >= %s AND holiday_date < %s
                          AND source <> 'manual'
                        """,
                        (month_start, next_month_start),
                    )
                deleted = c.rowcount

                upserted = 0
                for ymd, name in fresh.items():
                    d = date(int(ymd[0:4]), int(ymd[5:7]), int(ymd[8:10]))
                    c.execute(
                        """
                        INSERT INTO hr.holidays
                            (holiday_date, name, source, created_at, updated_at)
                        VALUES (%s, %s, 'kasi', NOW(), NOW())
                        ON CONFLICT (holiday_date) DO UPDATE
                            SET name = EXCLUDED.name,
                                source = 'kasi',
                                updated_at = NOW()
                            WHERE hr.holidays.source <> 'manual'
                        """,
                        (d, name),
                    )
                    upserted += c.rowcount
            self.conn.commit()
            return upserted, deleted
        except Exception:
            self.conn.rollback()
            raise
        finally:
            self.conn.autocommit = True

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

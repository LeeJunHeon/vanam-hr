"""aggregator 하루 계산 테스트 — 근무일 창 출퇴근 + 04:00 을 넘긴 연결 나누기
(day_rules.day_presence / carry_end). 가짜 DB 로 바로 실행.

실행: python tests/aggregator/test_day_presence.py   (DB·네트워크 불필요, 실패 시 종료 코드 1)

규칙: 근무일 창 [S, E) (S = work_date 04:00, E = S + 1일). 출근이 없으면 퇴근도 쓰지 않는다.
이월(S 직전 마지막 기록 online — 04:00 에 연결 중)이면 그날 근무 시작 P(알림의 기준 출근)로 나눈다:
  P 없음 → 출근 S / P 전에 나감(offline 뒤 grace 넘게 재연결 없음) → 전날 퇴근 = 나간 시각, 그날은 나간 뒤 기록으로 /
  P 까지 안 나감 → 전날 퇴근 = 그날 출근 = P / 아직 모름 → 판단 보류(그날 출퇴근 없음, 전날 퇴근 비움,
  출근 전·출근 미감지 알림 생략).
"""

import logging
import os
import sys
from datetime import date, datetime, time, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "..", "aggregator"))

import aggregator as A  # noqa: E402
from day_rules import work_date_for  # noqa: E402

KST = timezone(timedelta(hours=9))
CUTOFF = 4
SHIFT_KANG = {"patternName": "주간", "start": "07:00", "end": "16:00", "type": "day"}
SHIFT_9_18 = {"patternName": "주간", "start": "09:00", "end": "18:00", "type": "day"}
SHIFT_NIGHT = {"patternName": "야간", "start": "15:00", "end": "23:00", "type": "night"}


def k(y, mo, d, h, mi=0):
    return datetime(y, mo, d, h, mi, tzinfo=KST)


def rec(dt, status):
    return {"checked_at": dt, "status": status}


class FakeDB:
    """presence_raw·attendance_daily 를 메모리로 흉내 낸다 (aggregator 가 쓰는 함수만)."""

    def __init__(self, records, shift=SHIFT_KANG, off_weekdays=(5, 6), rows=None, requests=None,
                 holidays=()):
        self.records = sorted(records, key=lambda r: r["checked_at"])
        self.shift = shift
        self.off_weekdays = off_weekdays
        self.rows = rows or {}          # work_date -> row
        self.requests = requests or {}  # work_date -> [request]
        self.holidays = set(holidays)
        self.policy = {}
        self.prestart = set()
        self.calls = []

    def _window(self, wd):
        s = datetime.combine(wd, time(CUTOFF), tzinfo=KST)
        return s, s + timedelta(days=1)

    def get_presence_raw_by_work_date(self, emp, wd, cutoff):
        s, e = self._window(wd)
        return [dict(r) for r in self.records if s <= r["checked_at"] < e]

    def has_presence_on_work_date(self, emp, wd, cutoff):
        return bool(self.get_presence_raw_by_work_date(emp, wd, cutoff))

    def get_last_presence_status(self, emp, before=None):
        self.calls.append(("last", before))
        c = [r for r in self.records if before is None or r["checked_at"] < before]
        return dict(c[-1]) if c else None

    def get_active_requests(self, emp, wd):
        return [dict(r) for r in self.requests.get(wd, [])]

    def get_employee_shift(self, emp, wd):
        if wd.weekday() in self.off_weekdays:
            return {**self.shift, "type": "off", "start": None, "end": None}
        return dict(self.shift)

    def get_policy(self, key):
        return self.policy.get(key)

    def get_holiday(self, wd):
        return "공휴일" if wd in self.holidays else None

    def clear_carry_times(self, emp, wd):
        """db.clear_carry_times 와 같은 조건·동작 — 자동·미확정 행의 출퇴근·근무시간·평가를 비운다."""
        r = self.rows.get(wd)
        if (not r or r.get("is_overridden") or r.get("is_confirmed")
                or (r.get("check_in") is None and r.get("check_out") is None)):
            return None
        old = (r.get("check_in"), r.get("check_out"))
        r.update(check_in=None, check_out=None, work_minutes=None, auto_status=None,
                 is_late=None, is_early_leave=None)
        return old

    def upsert_attendance_daily(self, employee_id, work_date, **kw):
        cur = self.rows.get(work_date)
        if cur and cur.get("is_overridden") and cur.get("override_source") != "calendar":
            return None
        self.rows[work_date] = {**(cur or {}), **kw}
        return 1

    def get_daily_for_backfill(self, emp, wd):
        r = self.rows.get(wd)
        if not r:
            return None
        return {x: r.get(x) for x in ("check_in", "check_out", "original_check_in",
                                     "original_check_out", "is_overridden", "override_source")}

    def has_correction_for_side(self, *a):
        return True

    def get_daily_check_in(self, emp, wd):
        return (self.rows.get(wd) or {}).get("check_in")

    def try_log_prestart_alert(self, emp, wd):
        if (emp, wd) in self.prestart:
            return False
        self.prestart.add((emp, wd))
        return True

    def cleanup_request_trace_row(self, emp, wd):
        r = self.rows.get(wd)
        if not r or not (r.get("is_overridden") and r.get("override_source") == "calendar"):
            return None
        if self.requests.get(wd):
            return None
        return "has_times" if (r.get("check_in") or r.get("check_out")) else "deleted"

    def delete_trace_row_with_times(self, emp, wd):
        r = self.rows.pop(wd, None)
        return (r.get("check_in"), r.get("check_out")) if r else None


def make(db):
    a = A.Aggregator.__new__(A.Aggregator)
    a.db = db
    a.logger = logging.getLogger("test")
    a.sent = []
    a._notify = lambda *x, **kw: a.sent.append(kw.get("type") or (x[1] if len(x) > 1 else None))
    a._no_show_notified = {}
    a._disconnect_notified = {}
    a._trace_times_warned = {}
    a._carry_pending = set()
    return a


def process(db, wd, now):
    a = make(db)
    return a._process_employee_work_date(
        {"id": 1, "employee_no": "E1", "name": "KANG"}, wd, 60, CUTOFF, 10, 0, now,
        cycle_today=work_date_for(now, CUTOFF),
        holiday_name="공휴일" if wd in db.holidays else None,
    )


def upto(records, now):
    """now 까지 쌓인 기록만 (그 시각의 presence_raw)."""
    return [r for r in records if r["checked_at"] <= now]


def cycle(db, now):
    """한 aggregator 로 어제·오늘(work_date_for(now))을 계산 — aggregate_today 의 직원 루프와 같은 순서."""
    a = make(db)
    today = work_date_for(now, CUTOFF)
    emp = {"id": 1, "employee_no": "E1", "name": "KANG"}
    a._carry_pending = set()
    for wd in (today - timedelta(days=1), today):
        r = a._process_employee_work_date(
            emp, wd, 60, CUTOFF, 10, 0, now, cycle_today=today,
            holiday_name="공휴일" if wd in db.holidays else None,
        )
        if r == "no_data":
            a._cleanup_request_trace_row(emp, wd, cutoff_hour=CUTOFF, allow_times_delete=True)
    return a


def show(db, wd):
    r = db.rows.get(wd)
    if not r:
        return "행 없음"
    f = lambda v: v.astimezone(KST).strftime("%m/%d %H:%M") if v else None
    return f"{f(r.get('check_in'))}~{f(r.get('check_out'))} {r.get('work_minutes')}분 {r.get('auto_status')}"


RESULTS = []


def check(name, got, expect):
    ok = got == expect
    RESULTS.append(ok)
    print(f"{'PASS' if ok else 'FAIL'} {name}: {got}" + ("" if ok else f"  (기대: {expect})"))


D29, D30, D1, D2, D3 = (date(2026, 9, 29), date(2026, 9, 30), date(2026, 10, 1),
                        date(2026, 10, 2), date(2026, 10, 3))
KANG = [
    rec(k(2026, 9, 30, 6, 55), "online"), rec(k(2026, 9, 30, 8, 18), "offline"),
    rec(k(2026, 9, 30, 8, 49), "online"), rec(k(2026, 9, 30, 11, 35), "offline"),
    rec(k(2026, 9, 30, 11, 45), "online"), rec(k(2026, 9, 30, 12, 22), "offline"),
    rec(k(2026, 9, 30, 13, 29), "online"), rec(k(2026, 10, 1, 1, 23), "offline"),
    rec(k(2026, 10, 1, 2, 31), "online"),
]


def scenario_a():
    db = FakeDB(list(KANG))
    process(db, D30, k(2026, 10, 1, 3, 59))
    check("a now 03:59 → 9/30 퇴근 비움(근무중)", show(db, D30), "09/30 06:55~None None분 working")

    db = FakeDB(list(KANG))
    a = cycle(db, k(2026, 10, 1, 4, 1))
    check("a now 04:01 → 9/30 퇴근 비움(다음 날 판단 보류)", show(db, D30),
          "09/30 06:55~None None분 working")
    check("a now 04:01 → 10/1 행 없음·판단 보류", (show(db, D1), 1 in a._carry_pending), ("행 없음", True))
    a = cycle(db, k(2026, 10, 1, 7))
    check("a now 07:00 → 9/30 06:55~10/01 07:00 (근무 시작에서 나눔)", show(db, D30),
          "09/30 06:55~10/01 07:00 1445분 normal")
    check("a now 07:00 → 10/1 출근 07:00 근무중·보류 풀림", (show(db, D1), 1 in a._carry_pending),
          ("10/01 07:00~None None분 working", False))

    db = FakeDB(KANG + [rec(k(2026, 10, 1, 18), "offline")])
    cycle(db, k(2026, 10, 1, 19, 30))
    check("a 18:00 끊김 → 10/1 07:00~18:00 660분 정상", show(db, D1), "10/01 07:00~10/01 18:00 660분 normal")
    now = k(2026, 10, 3, 9)
    process(db, D30, now)
    process(db, D1, now)
    check("a 10/03 재계산 → 같은 결과·결근 없음", (show(db, D30), show(db, D1)),
          ("09/30 06:55~10/01 07:00 1445분 normal", "10/01 07:00~10/01 18:00 660분 normal"))


def scenario_b():
    base = [rec(k(2026, 9, 30, 22), "online"), rec(k(2026, 10, 1, 5, 30), "offline")]
    db = FakeDB(list(base))
    cycle(db, k(2026, 10, 1, 7))
    check("b 밤샘 → 9/30 22:00~10/01 05:30 (근무 시작 전에 나감)", show(db, D30),
          "09/30 22:00~10/01 05:30 450분 late")
    check("b 10/1 행 없음 (나간 뒤 기록 없음)", show(db, D1), "행 없음")
    db = FakeDB(base + [rec(k(2026, 10, 1, 9), "online"), rec(k(2026, 10, 1, 18), "offline")])
    cycle(db, k(2026, 10, 1, 19, 30))
    check("b 09:00 연결·18:00 끊김 더 → 10/1 09:00~18:00 지각", show(db, D1),
          "10/01 09:00~10/01 18:00 540분 late")


def scenario_c():
    db = FakeDB([rec(k(2026, 9, 30, 6, 55), "online"), rec(k(2026, 10, 2, 15), "offline")])
    now = k(2026, 10, 2, 17)
    for d in (D30, D1, D2):
        process(db, d, now)
    check("c 며칠 연속", (show(db, D30), show(db, D1), show(db, D2)),
          ("09/30 06:55~10/01 07:00 1445분 normal", "10/01 07:00~10/02 07:00 1440분 normal",
           "10/02 07:00~10/02 15:00 480분 early_leave"))


def scenario_d():
    recs = [rec(k(2026, 9, 30, 8), "online"), rec(k(2026, 10, 1, 3, 50), "offline"),
            rec(k(2026, 10, 1, 4, 10), "online")]
    db = FakeDB(list(recs))
    process(db, D30, k(2026, 10, 1, 4, 30))
    check("d now 04:30 → 9/30 퇴근 비움(grace 전)", show(db, D30), "09/30 08:00~None None분 late")
    now = k(2026, 10, 1, 4, 50)
    process(db, D30, now)
    process(db, D1, now)
    check("d now 04:50 → 9/30 퇴근 03:50 / 10/1 출근 04:10(이월 아님)", (show(db, D30), show(db, D1)),
          ("09/30 08:00~10/01 03:50 1190분 late", "10/01 04:10~None None분 working"))


def scenario_e():
    recs = [rec(k(2026, 9, 29, 18), "offline"), rec(k(2026, 9, 30, 18), "offline")]  # 퇴근만
    db = FakeDB(list(recs))
    r_today = process(db, D30, k(2026, 9, 30, 20))
    check("e 퇴근만 — 오늘 → 행 없음", (r_today, show(db, D30)), ("no_data", "행 없음"))
    db = FakeDB(list(recs))
    process(db, D29, k(2026, 9, 30, 20))
    check("e 퇴근만 — 지난 근무일 → 결근", show(db, D29), "None~None None분 absent")


def scenario_f_note():
    """f) 경계를 넘지 않는 날·반차·외근·자유면 — 이전 코드(eeb4282)와 나란히 비교는 별도 실행(보고서 참고).
    여기서는 대표 값만 고정한다(이전 코드 결과와 같은 값)."""
    cases = {
        "정상": ([rec(k(2026, 9, 29, 8, 55), "online"), rec(k(2026, 9, 29, 18, 5), "offline")],
                "09/29 08:55~09/29 18:05 550분 normal"),
        "지각": ([rec(k(2026, 9, 29, 9, 20), "online"), rec(k(2026, 9, 29, 18, 30), "offline")],
                "09/29 09:20~09/29 18:30 550분 late"),
        "조퇴": ([rec(k(2026, 9, 29, 9), "online"), rec(k(2026, 9, 29, 17), "offline")],
                "09/29 09:00~09/29 17:00 480분 early_leave"),
        "점심 끊김": ([rec(k(2026, 9, 29, 9), "online"), rec(k(2026, 9, 29, 12), "offline"),
                     rec(k(2026, 9, 29, 12, 40), "online"), rec(k(2026, 9, 29, 18, 10), "offline")],
                    "09/29 09:00~09/29 18:10 550분 normal"),
        "01:00 퇴근": ([rec(k(2026, 9, 29, 9), "online"), rec(k(2026, 9, 30, 1), "offline")],
                      "09/29 09:00~09/30 01:00 960분 normal"),
    }
    for name, (recs, expect) in cases.items():
        db = FakeDB(list(recs), shift=SHIFT_9_18)
        process(db, D29, k(2026, 9, 30, 12))
        check(f"f {name}", show(db, D29), expect)


def scenario_g():
    db = FakeDB([])
    process(db, D29, k(2026, 9, 30, 12))
    check("g 지난 근무일 연결 없음 → 결근", show(db, D29), "None~None None분 absent")
    db = FakeDB([rec(k(2026, 9, 28, 9), "online")])  # 9/29 는 기록 0건이지만 이월
    process(db, D29, k(2026, 9, 30, 12))
    check("g 이월된 날 → 결근 아님(근무 시작 07:00 ~ 다음 날 07:00)", show(db, D29),
          "09/29 07:00~09/30 07:00 1440분 normal")
    db = FakeDB([], off_weekdays=(1,))
    r = process(db, D29, k(2026, 9, 30, 12))
    check("g 휴무 → 행 없음", (r, show(db, D29)), ("no_data", "행 없음"))
    db = FakeDB([], holidays=(D29,))
    r = process(db, D29, k(2026, 9, 30, 12))
    check("g 공휴일 → 행 없음", (r, show(db, D29)), ("no_data", "행 없음"))
    leave = {"id": 21, "category_id": 21, "category_code": "HALF_AM", "category_type": "leave",
             "corrected_check_in": k(2026, 9, 29, 7), "corrected_check_out": k(2026, 9, 29, 11),
             "reason": "", "external_source": None, "requested_at": k(2026, 9, 1, 0)}
    db = FakeDB([], requests={D29: [leave]})
    process(db, D29, k(2026, 9, 30, 12))
    check("g 시간형 휴가만·연결 없음 지난 날 → 결근", show(db, D29), "None~None None분 absent")


def scenario_h():
    now = k(2026, 10, 1, 7, 10)
    # 이월된 사람 (KANG) — 오늘(10/1) 행은 메인 계산이 만든다
    db = FakeDB(list(KANG))
    process(db, D1, now)
    a = make(db)
    a._check_no_show_alert({"id": 1, "name": "KANG", "email": "x@x"}, D1, None, now)
    no_show = len(a.sent)
    A.datetime = FixedDT
    FixedDT.fixed = k(2026, 10, 1, 6, 57)
    a2 = make(db)
    a2._check_prestart_alerts([{"id": 1, "name": "KANG", "email": "x@x"}], D1, None, 5)
    A.datetime = datetime
    a3 = make(db)
    a3._check_disconnect_alert({"id": 1, "name": "KANG", "email": "x@x"}, D1, CUTOFF, k(2026, 10, 1, 9))
    check("h 근무 시작까지 이어진 이월(출근 07:00) — 미감지·출근 전·끊김 알림 없음",
          (no_show, len(a2.sent), len(a3.sent)), (0, 0, 0))

    # 연결 없는 사람
    db = FakeDB([rec(k(2026, 9, 30, 18), "offline")])
    process(db, D1, now)
    a = make(db)
    a._check_no_show_alert({"id": 1, "name": "X", "email": "x@x"}, D1, None, now)
    A.datetime = FixedDT
    FixedDT.fixed = k(2026, 10, 1, 6, 57)
    a2 = make(db)
    a2._check_prestart_alerts([{"id": 1, "name": "X", "email": "x@x"}], D1, None, 5)
    A.datetime = datetime
    check("h 연결 없는 사람 — 미감지·출근 전 알림 보냄", (len(a.sent), len(a2.sent)), (1, 1))


def scenario_i():
    row = {"check_in": k(2026, 9, 29, 13), "check_out": k(2026, 9, 29, 15), "work_minutes": 120,
           "auto_status": "normal", "is_overridden": True, "override_source": "calendar", "category_id": 11}
    db = FakeDB([], rows={D29: dict(row)})
    a = make(db)
    a._cleanup_request_trace_row({"id": 1, "employee_no": "E1", "name": "KANG"}, D29,
                                 cutoff_hour=CUTOFF, allow_times_delete=True)
    check("i 신청 없는 no_data 날의 시각 있는 calendar 흔적 행 → 삭제", show(db, D29), "행 없음")


def scenario_j():
    """LEE 형 — 밤샘 뒤 새벽 퇴근, 오후 출근 (야간 시프트 15:00~23:00)."""
    recs = [rec(k(2026, 10, 1, 9), "online"), rec(k(2026, 10, 2, 5, 58), "offline"),
            rec(k(2026, 10, 2, 15, 56), "online"), rec(k(2026, 10, 2, 23, 19), "offline")]

    def at(now):
        db = FakeDB(upto(recs, now), shift=SHIFT_NIGHT)
        return db, cycle(db, now)

    db, a = at(k(2026, 10, 2, 4, 30))
    check("j 10/2 04:30 → 10/1 근무중·10/2 판단 보류", (show(db, D1), show(db, D2), 1 in a._carry_pending),
          ("10/01 09:00~None None분 working", "행 없음", True))
    db, a = at(k(2026, 10, 2, 6, 30))
    check("j 10/2 06:30 (05:58 끊김, grace 전) → 그대로 보류", (show(db, D1), show(db, D2), 1 in a._carry_pending),
          ("10/01 09:00~None None분 working", "행 없음", True))
    db, a = at(k(2026, 10, 2, 7))
    check("j 10/2 07:00 → 10/1 퇴근 05:58·보류 풀림", (show(db, D1), show(db, D2), 1 in a._carry_pending),
          ("10/01 09:00~10/02 05:58 1258분 normal", "행 없음", False))
    now = k(2026, 10, 2, 15, 5)
    db, a = at(now)
    a._check_no_show_alert({"id": 1, "name": "LEE", "email": "x@x"}, D2, None, now)
    check("j 10/2 15:05 → 출근 미감지 알림 보냄", a.sent, ["no_show"])
    db, a = at(k(2026, 10, 2, 16))
    check("j 10/2 16:00 → 10/2 출근 15:56 지각", show(db, D2), "10/02 15:56~None None분 late")
    db, a = at(k(2026, 10, 3, 0, 30))
    check("j 10/3 00:30 → 10/2 15:56~23:19", show(db, D2), "10/02 15:56~10/02 23:19 443분 late")


def scenario_k():
    db = FakeDB([rec(k(2026, 9, 30, 22), "online"), rec(k(2026, 10, 1, 5, 30), "offline")])
    now = k(2026, 10, 2, 9)
    process(db, D30, now)
    cycle(db, now)
    check("k 근무 시작 전에 나가고 그날 출근 없음 → 지난 날 결근", (show(db, D30), show(db, D1)),
          ("09/30 22:00~10/01 05:30 450분 late", "None~None None분 absent"))


def scenario_l():
    base = [rec(k(2026, 9, 30, 6, 55), "online"), rec(k(2026, 10, 1, 6, 30), "offline")]
    now = k(2026, 10, 1, 7, 5)
    db = FakeDB(list(base))
    a = cycle(db, now)
    a._check_no_show_alert({"id": 1, "name": "KANG", "email": "x@x"}, D1, None, now)
    check("l 07:05 (06:30 끊김, grace 전) → 보류·미감지 알림 없음", (show(db, D1), 1 in a._carry_pending, a.sent),
          ("행 없음", True, []))
    db = FakeDB(base + [rec(k(2026, 10, 1, 7, 10), "online")])
    cycle(db, k(2026, 10, 1, 7, 15))
    check("l 07:10 재연결(grace 안) → 잠깐 자리 비움, 07:00 에서 나눔", (show(db, D30), show(db, D1)),
          ("09/30 06:55~10/01 07:00 1445분 normal", "10/01 07:00~None None분 working"))
    db = FakeDB(base + [rec(k(2026, 10, 1, 7, 40), "online")])
    cycle(db, k(2026, 10, 1, 7, 45))
    check("l 07:40 재연결(grace 넘음) → 06:30 퇴근, 07:40 출근 지각", (show(db, D30), show(db, D1)),
          ("09/30 06:55~10/01 06:30 1415분 normal", "10/01 07:40~None None분 late"))


def scenario_m():
    half_am = {"id": 21, "category_id": 21, "category_code": "HALF_AM", "category_type": "leave",
               "corrected_check_in": k(2026, 10, 1, 9), "corrected_check_out": k(2026, 10, 1, 13),
               "reason": "", "external_source": None, "requested_at": k(2026, 9, 1, 0)}
    db = FakeDB([rec(k(2026, 9, 30, 9), "online"), rec(k(2026, 10, 1, 10), "offline"),
                 rec(k(2026, 10, 1, 13, 5), "online"), rec(k(2026, 10, 1, 18), "offline")],
                shift=SHIFT_9_18, requests={D1: [half_am]})
    cycle(db, k(2026, 10, 1, 19, 30))
    check("m 오전반차 날 — 근무 시작 13:00 전에 나감(10:00)", (show(db, D30), show(db, D1)),
          ("09/30 09:00~10/01 10:00 1500분 normal", "10/01 13:05~10/01 18:00 295분 normal"))


def scenario_n():
    db = FakeDB([rec(k(2026, 10, 2, 22), "online"), rec(k(2026, 10, 3, 5, 30), "offline")])
    cycle(db, k(2026, 10, 3, 8))
    check("n 다음 날 휴무 → 04:00 에서 나눔", (show(db, D2), show(db, D3)),
          ("10/02 22:00~10/03 04:00 360분 late", "10/03 04:00~10/03 05:30 90분 normal"))
    base = [rec(k(2026, 9, 30, 22), "online"), rec(k(2026, 10, 1, 5, 30), "offline")]
    db = FakeDB(list(base), holidays=(D1,))
    cycle(db, k(2026, 10, 1, 8))
    check("n 다음 날 공휴일 → 04:00 에서 나눔", (show(db, D30), show(db, D1)),
          ("09/30 22:00~10/01 04:00 360분 late", "10/01 04:00~10/01 05:30 90분 normal"))
    annual = {"id": 41, "category_id": 41, "category_code": "ANNUAL", "category_type": "leave",
              "corrected_check_in": None, "corrected_check_out": None,
              "reason": "", "external_source": None, "requested_at": k(2026, 9, 1, 0)}
    db = FakeDB(list(base), requests={D1: [annual]})
    cycle(db, k(2026, 10, 1, 8))
    check("n 다음 날 종일 연차 → 04:00 에서 나눔", (show(db, D30), show(db, D1)),
          ("09/30 22:00~10/01 04:00 360분 late", "10/01 04:00~10/01 05:30 90분 normal"))


def scenario_o():
    db = FakeDB(list(KANG))
    a = cycle(db, k(2026, 10, 1, 6, 57))
    A.datetime = FixedDT
    FixedDT.fixed = k(2026, 10, 1, 6, 57)
    try:
        a._check_prestart_alerts([{"id": 1, "name": "KANG", "email": "x@x"}], D1, None, 5)
    finally:
        A.datetime = datetime
    check("o 판단 보류 중 06:57 → 출근 전 알림 없음", (show(db, D1), a.sent), ("행 없음", []))


def scenario_p():
    base = [rec(k(2026, 9, 30, 22), "online"), rec(k(2026, 10, 1, 5, 30), "offline")]
    auto_row = {"check_in": k(2026, 10, 1, 4), "check_out": k(2026, 10, 1, 5, 30), "work_minutes": 90,
                "auto_status": "early_leave", "is_overridden": False}
    db = FakeDB(list(base), rows={D1: dict(auto_row)})
    cycle(db, k(2026, 10, 1, 8))
    check("p 남은 04:00 이월 자동 행 → 출퇴근 비움", show(db, D1), "None~None None분 None")
    db = FakeDB(list(base), rows={D1: {**auto_row, "is_overridden": True, "override_source": "manual"}})
    cycle(db, k(2026, 10, 1, 8))
    check("p 수동 정정 행 → 그대로", show(db, D1), "10/01 04:00~10/01 05:30 90분 early_leave")
    db = FakeDB(list(KANG), rows={D1: {"check_in": k(2026, 10, 1, 4), "check_out": None, "work_minutes": None,
                                       "auto_status": "working", "is_overridden": False}})
    cycle(db, k(2026, 10, 1, 5))
    check("p 판단 보류 중 남은 04:00 출근 행 → 비움", show(db, D1), "None~None None분 None")


class FixedDT(datetime):
    fixed = None

    @classmethod
    def now(cls, tz=None):
        return cls.fixed.astimezone(tz) if tz else cls.fixed


if __name__ == "__main__":
    logging.basicConfig(level=logging.WARNING)
    for fn in (scenario_a, scenario_b, scenario_c, scenario_d, scenario_e, scenario_f_note,
               scenario_g, scenario_h, scenario_i, scenario_j, scenario_k, scenario_l, scenario_m,
               scenario_n, scenario_o, scenario_p):
        fn()
    print(f"\n{sum(RESULTS)}/{len(RESULTS)} 통과")
    sys.exit(0 if all(RESULTS) else 1)

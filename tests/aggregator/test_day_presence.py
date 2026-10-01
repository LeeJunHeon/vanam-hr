"""aggregator 하루 계산 테스트 — 근무일 04:00 에서 자르는 규칙 (day_rules.day_presence). 가짜 DB 로 바로 실행.

실행: python tests/aggregator/test_day_presence.py   (DB·네트워크 불필요, 실패 시 종료 코드 1)

규칙: 근무일 창 [S, E) (S = work_date 04:00, E = S + 1일). 이월(S 직전 마지막 기록 online)이면 출근 = S.
마지막 상태가 online 이면 E 가 지난 뒤 퇴근 = E. 출근이 없으면 퇴근도 쓰지 않는다. 다음 날 기록은 보지 않는다.
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
    return a


def process(db, wd, now):
    a = make(db)
    return a._process_employee_work_date(
        {"id": 1, "employee_no": "E1", "name": "KANG"}, wd, 60, CUTOFF, 10, 0, now,
        cycle_today=work_date_for(now, CUTOFF),
        holiday_name="공휴일" if wd in db.holidays else None,
    )


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
    now = k(2026, 10, 1, 4, 1)
    process(db, D30, now)
    process(db, D1, now)
    check("a now 04:01 → 9/30 06:55~10/01 04:00 1265분 정상", show(db, D30),
          "09/30 06:55~10/01 04:00 1265분 normal")
    check("a now 04:01 → 10/1 출근 04:00 근무중(행 있음)", show(db, D1), "10/01 04:00~None None분 working")

    db = FakeDB(KANG + [rec(k(2026, 10, 1, 18), "offline")])
    now = k(2026, 10, 1, 19, 30)
    process(db, D30, now)
    process(db, D1, now)
    check("a 18:00 끊김 → 10/1 04:00~18:00 840분 정상", show(db, D1), "10/01 04:00~10/01 18:00 840분 normal")
    now = k(2026, 10, 3, 9)
    process(db, D30, now)
    process(db, D1, now)
    check("a 10/03 재계산 → 같은 결과·결근 없음", (show(db, D30), show(db, D1)),
          ("09/30 06:55~10/01 04:00 1265분 normal", "10/01 04:00~10/01 18:00 840분 normal"))


def scenario_b():
    base = [rec(k(2026, 9, 30, 22), "online"), rec(k(2026, 10, 1, 5, 30), "offline")]
    db = FakeDB(list(base))
    now = k(2026, 10, 1, 7)
    process(db, D30, now)
    process(db, D1, now)
    check("b 밤샘 → 9/30 22:00~10/01 04:00", show(db, D30), "09/30 22:00~10/01 04:00 360분 late")
    check("b 10/1 04:00~05:30", show(db, D1), "10/01 04:00~10/01 05:30 90분 early_leave")
    db = FakeDB(base + [rec(k(2026, 10, 1, 9), "online"), rec(k(2026, 10, 1, 18), "offline")])
    process(db, D1, k(2026, 10, 1, 19, 30))
    check("b 09:00 연결·18:00 끊김 더 → 10/1 04:00~18:00", show(db, D1), "10/01 04:00~10/01 18:00 840분 normal")


def scenario_c():
    db = FakeDB([rec(k(2026, 9, 30, 6, 55), "online"), rec(k(2026, 10, 2, 15), "offline")])
    now = k(2026, 10, 2, 17)
    for d in (D30, D1, D2):
        process(db, d, now)
    check("c 며칠 연속", (show(db, D30), show(db, D1), show(db, D2)),
          ("09/30 06:55~10/01 04:00 1265분 normal", "10/01 04:00~10/02 04:00 1440분 normal",
           "10/02 04:00~10/02 15:00 660분 normal"))


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
    check("g 이월된 날 → 결근 아님(04:00~04:00)", show(db, D29), "09/29 04:00~09/30 04:00 1440분 normal")
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
    check("h 이월된 사람 — 미감지·출근 전·끊김 알림 없음", (no_show, len(a2.sent), len(a3.sent)), (0, 0, 0))

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


class FixedDT(datetime):
    fixed = None

    @classmethod
    def now(cls, tz=None):
        return cls.fixed.astimezone(tz) if tz else cls.fixed


if __name__ == "__main__":
    logging.basicConfig(level=logging.WARNING)
    for fn in (scenario_a, scenario_b, scenario_c, scenario_d, scenario_e, scenario_f_note,
               scenario_g, scenario_h, scenario_i):
        fn()
    print(f"\n{sum(RESULTS)}/{len(RESULTS)} 통과")
    sys.exit(0 if all(RESULTS) else 1)

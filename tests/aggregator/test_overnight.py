"""aggregator 테스트 — 근무일 경계(cutoff)를 넘긴 연결 (F). 가짜 DB 로 바로 실행한다.

실행: python tests/aggregator/test_overnight.py   (DB·네트워크 불필요, 실패 시 종료 코드 1)

KANG 실제 사례 등 경계를 넘긴 세션을 _process_employee_work_date 로 돌려 출퇴근·평가·행 생성/삭제를 확인한다.
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


def k(y, mo, d, h, mi=0):
    return datetime(y, mo, d, h, mi, tzinfo=KST)


class FakeDB:
    """presence_raw·attendance_daily 를 메모리로 흉내 낸다 (aggregator 가 쓰는 함수만)."""

    def __init__(self, records, shift=None, off_weekdays=(5, 6), policy=None, rows=None):
        self.records = sorted(records, key=lambda r: r["checked_at"])
        self.shift = shift or {"patternName": "주간", "start": "07:00", "end": "16:00", "type": "day"}
        self.off_weekdays = off_weekdays
        self.policy = policy or {}
        self.rows = rows or {}  # work_date -> row
        self.deleted = []
        self.prestart = set()

    def _window(self, wd):
        s = datetime.combine(wd, time(CUTOFF), tzinfo=KST)
        return s, s + timedelta(days=1)

    def get_presence_raw_by_work_date(self, emp, wd, cutoff):
        s, e = self._window(wd)
        return [dict(r) for r in self.records if s <= r["checked_at"] < e]

    def get_presence_raw_between(self, emp, start, end):
        return [dict(r) for r in self.records if start <= r["checked_at"] < end]

    def get_last_presence_status(self, emp, before=None):
        c = [r for r in self.records if before is None or r["checked_at"] < before]
        return dict(c[-1]) if c else None

    def get_active_requests(self, emp, wd):
        return []

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

    def delete_auto_daily_row(self, emp, wd):
        r = self.rows.get(wd)
        if (r and not r.get("is_overridden") and r.get("category_id") is None
                and (r.get("check_in") or r.get("check_out")) and not r.get("note")):
            del self.rows[wd]
            self.deleted.append(wd)
            return (r.get("check_in"), r.get("check_out"))
        return None

    def get_daily_check_in(self, emp, wd):
        return (self.rows.get(wd) or {}).get("check_in")

    def try_log_prestart_alert(self, emp, wd):
        if (emp, wd) in self.prestart:
            return False
        self.prestart.add((emp, wd))
        return True


def make(db):
    a = A.Aggregator.__new__(A.Aggregator)
    a.db = db
    a.logger = logging.getLogger("test")
    a.sent = []
    a._notify = lambda *x, **kw: a.sent.append(kw.get("type") or x[1])
    return a


def process(db, wd, now, enabled=True, max_hours=6):
    a = make(db)
    today = work_date_for(now, CUTOFF)
    return a._process_employee_work_date(
        {"id": 1, "employee_no": "E1", "name": "KANG"}, wd, 60, CUTOFF, 10, 0, now,
        cycle_today=today, overnight_extend_enabled=enabled,
        overnight_extend_max_hours=max_hours if enabled else 0,
    )


def show(db, wd):
    r = db.rows.get(wd)
    if not r:
        return "행 없음"
    f = lambda v: v.astimezone(KST).strftime("%m/%d %H:%M") if v else None
    return f"{f(r.get('check_in'))}~{f(r.get('check_out'))} {r.get('work_minutes')}분 {r.get('auto_status')}"


def rec(dt, status):
    return {"checked_at": dt, "status": status}


RESULTS = []


def check(name, got, expect):
    ok = got == expect
    RESULTS.append(ok)
    print(f"{'PASS' if ok else 'FAIL'} {name}: {got}" + ("" if ok else f"  (기대: {expect})"))


D30, D1, D3 = date(2026, 9, 30), date(2026, 10, 1), date(2026, 10, 3)
KANG = [
    rec(k(2026, 9, 30, 6, 55), "online"), rec(k(2026, 9, 30, 8, 18), "offline"),
    rec(k(2026, 9, 30, 8, 49), "online"), rec(k(2026, 9, 30, 11, 35), "offline"),
    rec(k(2026, 9, 30, 11, 45), "online"), rec(k(2026, 9, 30, 12, 22), "offline"),
    rec(k(2026, 9, 30, 13, 29), "online"), rec(k(2026, 10, 1, 1, 23), "offline"),
    rec(k(2026, 10, 1, 2, 31), "online"),
]


def scenario_a():
    db = FakeDB(list(KANG))
    now = k(2026, 10, 1, 10, 49)
    process(db, D30, now)
    check("a 9/30 (now 10/01 10:49)", show(db, D30), "09/30 06:55~10/01 04:00 1265분 normal")
    r = process(db, D1, now)
    check("a 10/1 이월 출근·기록 0건", (r, show(db, D1)), ("no_data", "행 없음"))

    db = FakeDB(list(KANG))
    now = k(2026, 10, 1, 9)
    process(db, D30, now)
    process(db, D1, now)
    check("a now 10/01 09:00 → 9/30 근무중, 10/1 행 없음",
          (show(db, D30), show(db, D1)), ("09/30 06:55~None None분 working", "행 없음"))

    recs = KANG + [rec(k(2026, 10, 1, 5), "offline"), rec(k(2026, 10, 1, 5, 10), "online")]
    db = FakeDB(recs)
    now = k(2026, 10, 1, 10, 30)
    process(db, D30, now)
    process(db, D1, now)
    check("a 05:00 끊김·05:10 연결 → 10/1 출근 04:00 근무중", show(db, D1), "10/01 04:00~None None분 working")

    recs = recs + [rec(k(2026, 10, 1, 18), "offline")]
    db = FakeDB(recs)
    now = k(2026, 10, 1, 19, 30)
    process(db, D30, now)
    process(db, D1, now)
    check("a 18:00 끊김 → 10/1 04:00~18:00 840분 정상", show(db, D1), "10/01 04:00~10/01 18:00 840분 normal")

    now = k(2026, 10, 3, 9)
    process(db, D30, now)
    process(db, D1, now)
    check("a 10/03 재계산 → 같은 결과",
          (show(db, D30), show(db, D1)),
          ("09/30 06:55~10/01 04:00 1265분 normal", "10/01 04:00~10/01 18:00 840분 normal"))

    # 이월 출근 + 기록 0건인 10/1 을 지난 날로 재계산 → 결근 행 없음
    db = FakeDB(list(KANG))
    r = process(db, D1, k(2026, 10, 3, 9))
    check("a 10/1 기록 0건 재계산 → 결근 없음", (r, show(db, D1)), ("no_data", "행 없음"))


B_RECS = [
    rec(k(2026, 9, 30, 9), "online"), rec(k(2026, 9, 30, 18), "offline"), rec(k(2026, 9, 30, 22), "online"),
    rec(k(2026, 10, 1, 5, 30), "offline"), rec(k(2026, 10, 1, 9), "online"), rec(k(2026, 10, 1, 18), "offline"),
]


def scenario_b_c():
    db = FakeDB(list(B_RECS))
    now = k(2026, 10, 1, 19, 30)
    process(db, D30, now)
    process(db, D1, now)
    check("b 9/30 퇴근 10/01 05:30", show(db, D30), "09/30 09:00~10/01 05:30 1230분 late")
    check("b 10/1 09:00 지각·18:00 퇴근", show(db, D1), "10/01 09:00~10/01 18:00 540분 late")

    recs = [r for r in B_RECS if r["checked_at"] <= k(2026, 10, 1, 5, 30)]
    db = FakeDB(list(recs))
    now = k(2026, 10, 1, 6)
    process(db, D30, now)
    r = process(db, D1, now)
    check("c now 06:00 → 9/30 퇴근 비움, 10/1 행 없음",
          (show(db, D30), r, show(db, D1)), ("09/30 09:00~None None분 late", "no_data", "행 없음"))
    now = k(2026, 10, 1, 6, 31)
    process(db, D30, now)
    check("c now 06:31 → 9/30 퇴근 05:30", show(db, D30), "09/30 09:00~10/01 05:30 1230분 late")


def scenario_d():
    recs = [rec(k(2026, 9, 30, 7), "online"), rec(k(2026, 9, 30, 23), "online"),
            rec(k(2026, 10, 1, 5), "offline"), rec(k(2026, 10, 1, 5, 20), "online"),
            rec(k(2026, 10, 1, 6), "offline"), rec(k(2026, 10, 1, 9), "online")]
    db = FakeDB(recs)
    now = k(2026, 10, 1, 12)
    process(db, D30, now)
    process(db, D1, now)
    check("d 9/30 퇴근 06:00 / 10/1 출근 09:00",
          (show(db, D30), show(db, D1)),
          ("09/30 07:00~10/01 06:00 1380분 normal", "10/01 09:00~None None분 late"))


def scenario_e():
    base = [rec(k(2026, 9, 30, 7), "online"), rec(k(2026, 10, 1, 9, 50), "offline")]
    db = FakeDB(base + [rec(k(2026, 10, 1, 10, 20), "online")])
    now = k(2026, 10, 1, 11)
    process(db, D30, now)
    process(db, D1, now)
    check("e 09:50 끊김·10:20 연결 → 9/30 퇴근 04:00, 10/1 이월 출근",
          (show(db, D30), show(db, D1)),
          ("09/30 07:00~10/01 04:00 1260분 normal", "10/01 04:00~None None분 working"))
    db = FakeDB(list(base))
    process(db, D30, k(2026, 10, 1, 10, 30))
    check("e 10:20 없음, now 10:30 → 판단 대기", show(db, D30), "09/30 07:00~None None분 working")
    now = k(2026, 10, 1, 10, 51)
    process(db, D30, now)
    r = process(db, D1, now)
    check("e now 10:51 → 9/30 퇴근 09:50, 10/1 행 없음",
          (show(db, D30), r, show(db, D1)),
          ("09/30 07:00~10/01 09:50 1610분 normal", "no_data", "행 없음"))


def scenario_f():
    recs = [rec(k(2026, 9, 30, 7), "online"), rec(k(2026, 9, 30, 22), "online")]
    db = FakeDB(list(recs))
    now = k(2026, 10, 1, 4, 30)
    process(db, D30, now, enabled=False)
    check("f 정책 꺼짐 → 9/30 퇴근 04:00", show(db, D30), "09/30 07:00~10/01 04:00 1260분 normal")
    db = FakeDB(recs + [rec(k(2026, 10, 1, 12), "offline"), rec(k(2026, 10, 1, 13), "online")])
    process(db, D1, k(2026, 10, 1, 13, 30), enabled=False)
    check("f 10/1 그날 기록 생기면 출근 04:00", show(db, D1), "10/01 04:00~None None분 working")


def scenario_g():
    fri, sat, sun, mon = date(2026, 10, 2), date(2026, 10, 3), date(2026, 10, 4), date(2026, 10, 5)
    recs = [rec(k(2026, 10, 2, 8, 50), "online"), rec(k(2026, 10, 5, 18, 30), "offline")]
    db = FakeDB(recs)
    now = k(2026, 10, 5, 20)
    rs = [process(db, d, now) for d in (fri, sat, sun, mon)]
    check("g 금 퇴근 토 04:00", show(db, fri), "10/02 08:50~10/03 04:00 1150분 late")
    check("g 토·일 행 없음", (rs[1], rs[2], show(db, sat), show(db, sun)), ("no_data", "no_data", "행 없음", "행 없음"))
    check("g 월 04:00~18:30", show(db, mon), "10/05 04:00~10/05 18:30 870분 normal")


def scenario_h():
    """경계를 넘지 않는 날 — 이전 코드(dff847b)로 같은 입력을 돌려 얻은 결과와 같아야 한다."""
    d = date(2026, 9, 29)  # 화요일
    shift = {"patternName": "주간", "start": "09:00", "end": "18:00", "type": "day"}
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
        for enabled in (True, False):
            db = FakeDB(list(recs), shift=shift)
            process(db, d, k(2026, 9, 30, 12), enabled=enabled)
            check(f"h {name} (연장 {'켬' if enabled else '끔'})", show(db, d), expect)


def scenario_i():
    recs = [rec(k(2026, 9, 30, 7), "online"), rec(k(2026, 9, 30, 23), "online"),
            rec(k(2026, 10, 1, 5), "offline"), rec(k(2026, 10, 1, 5, 20), "online"),
            rec(k(2026, 10, 1, 6), "offline")]
    old_row = {"check_in": k(2026, 10, 1, 5, 20), "check_out": k(2026, 10, 1, 6), "work_minutes": 40,
               "auto_status": "early_leave", "is_overridden": False, "category_id": None}
    now = k(2026, 10, 3, 9)
    # 휴무일 (10/1 을 휴무로)
    db = FakeDB(list(recs), off_weekdays=(3,), rows={D1: dict(old_row)})
    r = process(db, D1, now)
    check("i 휴무일 → 남은 자동 행 지워짐", (r, D1 in db.deleted, show(db, D1)), ("no_data", True, "행 없음"))
    # 근무일 → 결근 행으로 덮임
    db = FakeDB(list(recs), rows={D1: dict(old_row)})
    process(db, D1, now)
    check("i 근무일 → 결근 행", show(db, D1), "None~None None분 absent")
    # 정정 행 → 그대로
    corr = {**old_row, "is_overridden": True, "override_source": "manual", "original_check_in": None,
            "original_check_out": None}
    db = FakeDB(list(recs), rows={D1: dict(corr)})
    process(db, D1, now)
    check("i 정정 행 → 그대로", show(db, D1), "10/01 05:20~10/01 06:00 40분 early_leave")


def scenario_j():
    def run(last_status):
        recs = [rec(k(2026, 10, 1, 2, 31), last_status)]
        db = FakeDB(recs)
        a = make(db)
        A.datetime = FixedDT
        FixedDT.fixed = k(2026, 10, 1, 6, 57)
        a._check_prestart_alerts([{"id": 1, "name": "KANG", "email": "x@x"}], D1, None, 5, CUTOFF)
        A.datetime = datetime
        return len(a.sent)
    check("j 지금 연결 중 → 출근 전 알림 안 보냄", run("online"), 0)
    check("j 연결 중 아님 → 보냄", run("offline"), 1)


class FixedDT(datetime):
    fixed = None

    @classmethod
    def now(cls, tz=None):
        return cls.fixed.astimezone(tz) if tz else cls.fixed


if __name__ == "__main__":
    logging.basicConfig(level=logging.WARNING)
    for fn in (scenario_a, scenario_b_c, scenario_d, scenario_e, scenario_f, scenario_g,
               scenario_h, scenario_i, scenario_j):
        fn()
    print(f"\n{sum(RESULTS)}/{len(RESULTS)} 통과")
    sys.exit(0 if all(RESULTS) else 1)

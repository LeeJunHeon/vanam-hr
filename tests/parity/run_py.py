"""parity Python 실행기 — cases.json 을 aggregator/day_rules.py·calendar-syncer/calendar_sync.py 로 계산해
JSON 으로 출력한다. 비교는 tests/parity/run.mjs (npm run parity) 가 한다. DB 없이 돈다."""

import json
import os
import sys
from datetime import date, datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
sys.path.insert(0, os.path.join(ROOT, "aggregator"))
sys.path.insert(0, os.path.join(ROOT, "calendar-syncer"))

import day_rules  # noqa: E402
import calendar_sync  # noqa: E402

KST = timezone(timedelta(hours=9))


def dt(s):
    return None if s is None else datetime.fromisoformat(s.replace("Z", "+00:00"))


def d(s):
    return date.fromisoformat(s)


def iso(v):
    if v is None:
        return None
    return v.astimezone(KST).isoformat()


JUDGE_DEFAULTS = {
    "work_date": "2026-09-29",
    "cutoff": 4,
    "shift": {"start": "09:00", "end": "18:00", "type": "day"},
    "holiday": False,
    "now": "2026-09-29T23:00:00+09:00",
}
POLICY_DEFAULTS = {
    "grace_in_minutes": 10,
    "grace_out_minutes": 0,
    "lunch_deduct_enabled": False,
    "lunch_start": "12:00",
    "lunch_end": "13:00",
    "timed_trip_exempt": False,
    "timed_event_margin_hours": 0,
}


def main():
    cases = json.load(open(os.path.join(HERE, "cases.json"), encoding="utf-8"))
    out = {}

    out["eval_keys"] = [
        day_rules.eval_keys(c["auto"], c["late"], c["early"], c["has_out"]) for c in cases["eval_keys"]
    ]
    out["all_day"] = [
        day_rules.is_all_day_request({"corrected_check_in": dt(c["ci"]), "corrected_check_out": dt(c["co"])})
        for c in cases["all_day"]
    ]

    out["window"] = []
    for c in cases["window"]:
        w = day_rules.effective_work_window(
            dt(c["shift"][0]), dt(c["shift"][1]), [(dt(a), dt(b)) for a, b in c["leaves"]]
        )
        out["window"].append(
            {"full_cover": True} if w["full_cover"] else {
                "ref_in": iso(w["ref_in"]), "ref_out": iso(w["ref_out"]), "full_cover": False,
                "window_minutes": w["window_minutes"], "middle_minutes": w["middle_minutes"],
            }
        )

    out["judge_day"] = []
    for c in cases["judge_day"]:
        cc = {**JUDGE_DEFAULTS, **c}
        pol = {**POLICY_DEFAULTS, **(c.get("policy") or {})}
        reqs = [
            {"category_type": r["type"], "corrected_check_in": dt(r["ci"]), "corrected_check_out": dt(r["co"])}
            for r in (c.get("requests") or [])
        ]
        ctx = day_rules.build_judge_ctx(
            reqs, cc["shift"], d(cc["work_date"]), cc["cutoff"], bool(cc["holiday"]), dt(cc["now"]),
            grace_in_minutes=pol["grace_in_minutes"], grace_out_minutes=pol["grace_out_minutes"],
            lunch_deduct_enabled=pol["lunch_deduct_enabled"],
            lunch_start_str=pol["lunch_start"], lunch_end_str=pol["lunch_end"],
            timed_trip_exempt=pol["timed_trip_exempt"],
            timed_event_margin_hours=float(pol["timed_event_margin_hours"]),
        )
        j = day_rules.judge_day(dt(c["check_in"]), dt(c["check_out"]), ctx)
        out["judge_day"].append([j["status"], j["is_late"], j["is_early_leave"]])

    out["shift_point"] = []
    for c in cases["shift_point"]:
        schedule = [{"dayIndex": i, "type": "day", "start": "09:00", "end": "18:00"} for i in range(c["cycle_days"])]
        p = day_rules.resolve_shift_point(d(c["start_date"]), c["cycle_days"], schedule, d(c["work_date"]))
        out["shift_point"].append(p["dayIndex"] if p else None)

    out["research_meeting"] = [
        day_rules.is_research_meeting_day(d(c["date"]), c["weekday"], c["interval"], d(c["anchor"]))
        for c in cases["research_meeting"]
    ]
    out["work_date"] = [
        day_rules.work_date_for(dt(c["now"]), c["cutoff"]).isoformat() for c in cases["work_date"]
    ]

    out["constants"] = {
        "aggregator": {
            "live_statuses": list(day_rules.LIVE_STATUSES),
            "leave_types": list(day_rules.LEAVE_TYPES),
            "work_types": list(day_rules.WORK_TYPES),
            "leave_work_types": list(day_rules.LEAVE_WORK_TYPES),
        },
        "syncer": {
            "live_statuses": list(calendar_sync.LIVE_STATUSES),
            "leave_work_types": list(calendar_sync.LEAVE_WORK_TYPES),
        },
    }
    sys.stdout.write(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    main()

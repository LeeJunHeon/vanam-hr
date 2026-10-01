"""구글 캘린더 일정 → 근태 신청(attendance_requests) 동기화 규칙.

syncer.py 의 sync_events 가 이 모듈의 함수를 부른다. DB 접근은 db.Database 의 작은 함수들만
쓰므로(가짜 DB 로 그대로 검증 가능), 판단 규칙은 모두 여기 있다.

- 대상 직원: select_target_emails
- 행 업서트(생성·갱신·되살림·유지): apply_event_for_employee
- 캘린더에서 빠진 기록 정리(오늘 시작=취소, 지난 시작=어제로 단축): plan_cleanup / execute_cleanup
- 근태 반영(빠진 날 원복, 들어온 지난 날 재계산 표시): reflect_request_change

syncer 가 바꾸는 신청 행은 external_source='google_calendar' 만이다. 출장(trip)·HR 신청은 건드리지 않는다.
"""

from datetime import date, datetime, timedelta, timezone
from typing import Callable, Optional

KST = timezone(timedelta(hours=9))

# 규칙을 바꾸면 npm run parity — 아래 상수는 웹(lib/attendance-live-requests.ts, lib/category-kind.ts)·
# aggregator(day_rules.py)와 같아야 한다.
# 살아 있는 신청 상태 — lib/attendance-live-requests.ts LIVE_REQUEST_STATUSES 와 같다.
LIVE_STATUSES = ("approved", "auto_approved", "auto_delegated")
# 근태에 반영하는 구분 type — lib/attendance-live-requests.ts LEAVE_WORK_CATEGORY_TYPES 와 같다.
LEAVE_WORK_TYPES = ("leave", "long_leave", "work")

# 일정 동기화 주기(분) — policy_settings 'calendar_sync_interval_minutes'
SYNC_INTERVAL_DEFAULT = 10
SYNC_INTERVAL_MIN = 5
SYNC_INTERVAL_MAX = 1440

# 정리(취소+단축) 한 사이클 상한 — 넘으면 버그·조회 이상으로 보고 아무것도 하지 않는다.
CLEANUP_SAFETY_CAP = 30


def resolve_sync_interval(raw) -> int:
    """정책 값 → 동기화 주기(분). 없거나 숫자가 아니면 10, 5~1440 으로 자른다."""
    try:
        n = int(str(raw).strip())
    except (TypeError, ValueError):
        return SYNC_INTERVAL_DEFAULT
    return max(SYNC_INTERVAL_MIN, min(SYNC_INTERVAL_MAX, n))


def _norm_email(e) -> str:
    return (e or "").lower().strip()


def select_target_emails(parsed: dict, email_map: dict) -> list[str]:
    """일정 1건의 근태 대상 직원 이메일(정규화).

    - 직원 참석자 = attendees 중 이메일이 email_map(활성·이메일 있는 직원)에 있는 참석자.
      회의실·외부인·캘린더 주소는 직원 참석자가 아니다.
    - 직원 참석자가 1명이라도 있으면: 그중 responseStatus='accepted' 인 직원만.
      만든 사람은 참석자로 올라 있고 수락했을 때만 대상.
    - 직원 참석자가 없으면(참석자 없음, 회의실·외부인·캘린더만): 만든 사람 1명.
    """
    employee_attendees = []
    for a in parsed.get("attendees") or []:
        email = _norm_email(a.get("email"))
        if email and email in email_map:
            employee_attendees.append((email, a.get("response_status")))
    if employee_attendees:
        return sorted({e for e, status in employee_attendees if status == "accepted"})
    creator = _norm_email(parsed.get("creator_email"))
    return [creator] if creator else []


def parse_event_times(event: dict, parsed: dict):
    """일정 날짜·시각 → (start_date, end_date, corrected_check_in, corrected_check_out).

    종일: end.date 는 Google API exclusive(다음날) → -1일. 시각은 None.
    시간 지정: start/end.dateTime(TZ 포함) — 날짜는 그 시각의 KST 달력 날짜.
    실패하면 예외.
    """
    end_raw = event.get("end") or {}
    if parsed["is_all_day"]:
        start_d = datetime.strptime(parsed["start_date_or_datetime"], "%Y-%m-%d").date()
        end_exclusive = end_raw.get("date")
        if end_exclusive:
            end_d = datetime.strptime(end_exclusive, "%Y-%m-%d").date() - timedelta(days=1)
        else:
            end_d = start_d
        return start_d, end_d, None, None
    start_iso = parsed["start_date_or_datetime"]
    end_iso = end_raw.get("dateTime")
    if not start_iso or not end_iso:
        raise ValueError("start/end.dateTime 없음")
    ci = datetime.fromisoformat(start_iso.replace("Z", "+00:00"))
    co = datetime.fromisoformat(end_iso.replace("Z", "+00:00"))
    # 날짜는 KST 로 바꾼 뒤 잡는다 — 구글이 UTC 로 주면 새벽 일정이 하루 앞 날짜로 잡히던 문제
    return ci.astimezone(KST).date(), co.astimezone(KST).date(), ci, co


def _as_date(v) -> Optional[date]:
    if v is None:
        return None
    if isinstance(v, datetime):
        return v.date()
    if isinstance(v, date):
        return v
    return datetime.strptime(str(v)[:10], "%Y-%m-%d").date()


def _days(start: date, end: date) -> list[date]:
    out = []
    d = start
    while d <= end:
        out.append(d)
        d += timedelta(days=1)
    return out


def _snapshot(row: dict, cat_types: dict) -> dict:
    return {
        "start": _as_date(row["start_date"]),
        "end": _as_date(row["end_date"]),
        "category_id": row["category_id"],
        "type": cat_types.get(row["category_id"]),
        "ci": row.get("corrected_check_in"),
        "co": row.get("corrected_check_out"),
    }


def apply_event_for_employee(
    db,
    employee_id: int,
    event_id: str,
    new: dict,
    today: date,
    cat_types: dict,
) -> dict:
    """행 1개(external_source 'google_calendar' + event_id + employee_id) 업서트 + 근태 반영.

    new = {category_id, start_date(date), end_date(date), reason, ci, co}
    한 행의 신청 변경과 근태 반영은 한 트랜잭션이다.

    결과 kind:
      created / updated / revived — 바꿈 (info 로그 대상)
      unchanged                  — 살아 있고 같음(쓰지 않음)
      skipped_hr_overlap         — 새로 만들거나 되살리려는데 같은 카테고리 HR 신청과 겹침
      kept_cancelled             — 사람 취소('user')·이전 취소(NULL)·반려 등 → 손대지 않음
      conflict                   — 읽은 뒤 상태가 바뀜(웹 취소 등) → 이번 사이클 건너뜀
    """
    new_snap = {
        "start": new["start_date"],
        "end": new["end_date"],
        "category_id": new["category_id"],
        "type": cat_types.get(new["category_id"]),
        "ci": new.get("ci"),
        "co": new.get("co"),
    }
    with db.transaction():
        row = db.find_calendar_request(event_id, employee_id)

        if row is None:
            if db.hr_overlap_exists(employee_id, new["category_id"], new["start_date"], new["end_date"]):
                return {"kind": "skipped_hr_overlap", "request_id": None, "old": None, "new": new_snap}
            rid = db.insert_calendar_request(employee_id, event_id, new)
            reflect_request_change(db, employee_id, rid, None, new_snap, today)
            return {"kind": "created", "request_id": rid, "old": None, "new": new_snap}

        old_snap = _snapshot(row, cat_types)
        status = row["status"]

        if status in LIVE_STATUSES:
            same = (
                row["category_id"] == new["category_id"]
                and old_snap["start"] == new["start_date"]
                and old_snap["end"] == new["end_date"]
                and (row.get("reason") or "") == (new.get("reason") or "")
                and row.get("corrected_check_in") == new.get("ci")
                and row.get("corrected_check_out") == new.get("co")
            )
            if same:
                return {"kind": "unchanged", "request_id": row["id"], "old": old_snap, "new": new_snap}
            ok = db.update_calendar_request(row["id"], status, None, new, revive=False)
            if not ok:
                return {"kind": "conflict", "request_id": row["id"], "old": old_snap, "new": new_snap}
            reflect_request_change(db, employee_id, row["id"], old_snap, new_snap, today)
            return {"kind": "updated", "request_id": row["id"], "old": old_snap, "new": new_snap}

        if status == "cancelled" and row.get("cancel_source") == "calendar_sync":
            if db.hr_overlap_exists(employee_id, new["category_id"], new["start_date"], new["end_date"]):
                return {"kind": "skipped_hr_overlap", "request_id": row["id"], "old": old_snap, "new": new_snap}
            ok = db.update_calendar_request(row["id"], "cancelled", "calendar_sync", new, revive=True)
            if not ok:
                return {"kind": "conflict", "request_id": row["id"], "old": old_snap, "new": new_snap}
            # 되살림 = 새로 들어온 것과 같다(취소 때 빠진 날은 이미 원복됐다)
            reflect_request_change(db, employee_id, row["id"], None, new_snap, today)
            return {"kind": "revived", "request_id": row["id"], "old": old_snap, "new": new_snap}

        return {"kind": "kept_cancelled", "request_id": row["id"], "old": old_snap, "new": new_snap}


def reflect_request_change(db, employee_id: int, request_id: int, old: Optional[dict], new: Optional[dict], today: date) -> None:
    """신청 변경의 근태 반영. old/new = {start, end, category_id, type, ci, co} 또는 None(없음·취소).

    - 빠진 날(이전 범위에만 있던 날, 이전 구분 type 이 휴가·외근일 때) → reflect_removed_day
    - 들어온 날 중 지난 날(새 구분 type 이 휴가·외근일 때) → 재계산 표시
      들어온 날 = 새로 생긴 범위 / 늘어난 날 / category·시각이 바뀌었으면 새 범위 전체
    """
    old_days = set(_days(old["start"], old["end"])) if old else set()
    new_days = set(_days(new["start"], new["end"])) if new else set()

    if old and old.get("type") in LEAVE_WORK_TYPES:
        for d in sorted(old_days - new_days):
            reflect_removed_day(db, employee_id, d, today, request_id)

    if new and new.get("type") in LEAVE_WORK_TYPES:
        if old is None:
            added = new_days
        else:
            changed_kind = (
                old["category_id"] != new["category_id"]
                or old.get("ci") != new.get("ci")
                or old.get("co") != new.get("co")
            )
            added = new_days if changed_kind else (new_days - old_days)
        for d in sorted(added):
            if d < today:
                db.mark_recalc(employee_id, d)


def _is_protected_manual_row(row: dict) -> bool:
    # lib/attendance-live-requests.ts isProtectedManualRow 와 같다.
    return bool(row["is_overridden"]) and (row.get("override_source") or "") != "calendar"


def reflect_removed_day(db, employee_id: int, day: date, today: date, request_id: int) -> None:
    """신청에서 빠진 하루의 근태 원복.

    lib/finalize-approval.ts revertCancelledRequestFromDaily 와 같은 규칙 — 한쪽을 바꾸면 다른 쪽도.
    - 수동 보호 행: 시각·상태 그대로. 그 날을 덮는 다른 살아 있는 휴가·외근이 없고 category 가 있으면
      category_id=NULL. 지난 날이면 재계산 표시.
    - 일반 행, 지난 날: 재계산 표시.
    - 일반 행, 오늘: 건드리지 않는다(aggregator 가 1분 안에 다시 계산).
    - 일반 행, 앞날: 출퇴근이 없을 때만 — 다른 살아 있는 신청이 있으면 id 가 가장 작은 것의 category 로,
      없으면 사유 첨부가 없을 때 행 삭제.
    """
    row = db.get_daily_row(employee_id, day)
    if row is not None and _is_protected_manual_row(row):
        others = db.find_live_leave_work_requests(employee_id, day, request_id)
        if not others and row.get("category_id") is not None:
            db.set_daily_category(row["id"], None)
        if day < today:
            db.mark_recalc(employee_id, day)
        return
    if day < today:
        db.mark_recalc(employee_id, day)
        return
    if day == today:
        return
    if row is None or row.get("check_in") is not None or row.get("check_out") is not None:
        return
    others = db.find_live_leave_work_requests(employee_id, day, request_id)
    if others:
        if row.get("category_id") != others[0]["category_id"]:
            db.set_daily_category(row["id"], others[0]["category_id"])
        return
    db.delete_daily_if_no_files(row["id"])


def plan_cleanup(
    rows: list[dict],
    seen: set,
    uncertain: set,
    today: date,
    target_employee_ids: set,
    has_trip_report: Callable[[int], bool],
) -> dict:
    """캘린더에서 빠진 기록 정리 계획.

    rows = 오늘을 덮는 살아 있는 google_calendar 행(id, employee_id, external_event_id,
           start_date, end_date, category_id, status).
    - 이메일 매칭 맵에 있는 직원 행 중, 이번 사이클에 본 (event_id, employee_id) 가 아니고
      불확실(파싱 실패) event_id 도 아닌 행이 후보.
    - 시작 = 오늘 → 취소, 시작 < 오늘 → 어제로 단축(지난 날 보존).
    - 취소 대상인데 출장보고서가 있으면 취소하지 않는다(trip_blocked).
    """
    cancels, shortens, trip_blocked = [], [], []
    for r in rows:
        if r["employee_id"] not in target_employee_ids:
            continue
        if r["external_event_id"] in uncertain:
            continue
        if (r["external_event_id"], r["employee_id"]) in seen:
            continue
        start = _as_date(r["start_date"])
        if start >= today:
            if has_trip_report(r["id"]):
                trip_blocked.append(r)
            else:
                cancels.append(r)
        else:
            shortens.append(r)
    return {
        "cancels": cancels,
        "shortens": shortens,
        "trip_blocked": trip_blocked,
        "total": len(cancels) + len(shortens),
    }


def execute_cleanup(db, plan: dict, today: date, cat_types: dict, logger) -> dict:
    """정리 실행. 행마다 신청 변경 + 근태 반영을 한 트랜잭션으로. 결과 건수 반환."""
    done = {"cancelled": 0, "shortened": 0, "conflict": 0}
    yesterday = today - timedelta(days=1)
    for kind, rows in (("cancel", plan["cancels"]), ("shorten", plan["shortens"])):
        for r in rows:
            old = _snapshot(r, cat_types)
            try:
                with db.transaction():
                    if kind == "cancel":
                        ok = db.cancel_calendar_request(r["id"], r["status"], old["end"])
                        new = None
                    else:
                        ok = db.shorten_calendar_request(r["id"], r["status"], old["end"], yesterday)
                        new = {**old, "end": yesterday}
                    if not ok:
                        done["conflict"] += 1
                        continue
                    reflect_request_change(db, r["employee_id"], r["id"], old, new, today)
            except Exception as e:
                logger.exception(f"  [정리] req#{r['id']} 처리 실패: {e}")
                continue
            if kind == "cancel":
                done["cancelled"] += 1
                logger.info(
                    f"  [정리] 취소(캘린더에서 빠짐) req#{r['id']} emp={r['employee_id']} "
                    f"event={r['external_event_id']} {old['start']}~{old['end']} → cancelled(calendar_sync)"
                )
            else:
                done["shortened"] += 1
                logger.info(
                    f"  [정리] 단축(캘린더에서 빠짐) req#{r['id']} emp={r['employee_id']} "
                    f"event={r['external_event_id']} {old['start']}~{old['end']} → {old['start']}~{yesterday}"
                )
    return done

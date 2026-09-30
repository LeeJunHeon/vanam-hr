"""하루 판정·알림 공용 규칙 (순수 함수 — DB 접근 없음).

- 유효 근무 구간(반차 등 시간형 휴가를 뺀 시프트 구간): effective_work_window
  웹 lib/attendance-correction.ts effectiveWorkWindow 와 같은 규칙 — 한쪽을 바꾸면 다른 쪽도.
- 알림 공용 판단(출근 전·출근 미감지·근무 중 끊김): day_alert_context
- 평가 키(지각·조퇴 플래그 우선, 둘 다 NULL 인 옛 행은 auto_status): eval_keys
  웹 lib/attendanceLabels.ts evalKeys 와 같은 규칙 — 한쪽을 바꾸면 다른 쪽도.

용어
- 대상 신청 = 살아 있는(approved·auto_approved·auto_delegated) 휴가·근무 신청. 정정·결재 대기 제외.
- 종일 = 시각이 하나라도 없거나, 두 시각의 KST 날짜가 다른 신청.
- 시간형 휴가 = type leave·long_leave 이면서 시각 둘 다 있고 KST 날짜가 같은 신청(반차 등).
- 시간형 근무 = type work(외근·출장·재택)이면서 같은 조건인 신청.
"""

from datetime import date, datetime, time, timedelta, timezone
from typing import Optional

KST = timezone(timedelta(hours=9))

LEAVE_TYPES = ("leave", "long_leave")
WORK_TYPES = ("work",)


def is_all_day_request(r: dict) -> bool:
    ci, co = r.get("corrected_check_in"), r.get("corrected_check_out")
    if ci is None or co is None:
        return True
    return ci.astimezone(KST).date() != co.astimezone(KST).date()


def split_requests(requests: list[dict]) -> dict:
    """대상 신청을 종일 / 시간형 휴가 / 시간형 근무로 나눈다 (정정·그 밖 type 은 버림)."""
    allday, timed_leave, timed_work = [], [], []
    for r in requests:
        t = r.get("category_type")
        if t not in LEAVE_TYPES and t not in WORK_TYPES:
            continue
        if is_all_day_request(r):
            allday.append(r)
        elif t in LEAVE_TYPES:
            timed_leave.append(r)
        else:
            timed_work.append(r)
    return {"allday": allday, "timed_leave": timed_leave, "timed_work": timed_work}


def shift_bounds(work_date: date, shift_info: Optional[dict]):
    """그날 시프트(연구미팅 대체 반영 후)의 [시작, 종료] (KST aware). 근무 시프트가 아니면 None.
    종료 <= 시작이면 자정 넘김(+1일)."""
    if (
        not shift_info
        or shift_info.get("type") == "off"
        or not shift_info.get("start")
        or not shift_info.get("end")
    ):
        return None
    try:
        sh_h, sh_m = map(int, str(shift_info["start"]).split(":"))
        eh_h, eh_m = map(int, str(shift_info["end"]).split(":"))
    except (ValueError, AttributeError):
        return None
    start = datetime.combine(work_date, time(sh_h, sh_m), tzinfo=KST)
    end = datetime.combine(work_date, time(eh_h, eh_m), tzinfo=KST)
    if end <= start:
        end += timedelta(days=1)
    return start, end


def effective_work_window(shift_start: datetime, shift_end: datetime, leaves: list[tuple]) -> dict:
    """시프트 [시작, 종료]에서 시간형 휴가를 뺀 유효 근무 구간.

    - 휴가가 시프트 시작을 덮으면(휴가 시작 <= 기준 출근 < 휴가 끝): 기준 출근 = 휴가 끝
      (바로 이어지는 휴가가 있으면 그 끝까지).
    - 휴가가 시프트 종료를 덮으면(휴가 시작 < 기준 퇴근 <= 휴가 끝): 기준 퇴근 = 휴가 시작.
    - 가운데 휴가: 기준 출퇴근은 그대로, 의무 근무시간에서 겹치는 만큼 뺀다(middle_minutes).
    - 휴가가 시프트 전체를 덮으면 full_cover=True (종일과 같게 처리).
    leaves: [(start, end)] aware.
    """
    ref_in, ref_out = shift_start, shift_end
    changed = True
    while changed:
        changed = False
        for s, e in leaves:
            if s <= ref_in < e:
                ref_in = e
                changed = True
    changed = True
    while changed:
        changed = False
        for s, e in leaves:
            if s < ref_out <= e:
                ref_out = s
                changed = True
    if ref_in >= ref_out:
        return {
            "ref_in": ref_in, "ref_out": ref_out, "full_cover": True,
            "window_minutes": 0, "middle_minutes": 0,
            "shift_start": shift_start, "shift_end": shift_end,
        }
    middle = 0
    for s, e in leaves:
        ov_s, ov_e = max(s, ref_in), min(e, ref_out)
        if ov_e > ov_s:
            middle += int((ov_e - ov_s).total_seconds() // 60)
    return {
        "ref_in": ref_in,
        "ref_out": ref_out,
        "full_cover": False,
        "window_minutes": int((ref_out - ref_in).total_seconds() // 60),
        "middle_minutes": middle,
        "shift_start": shift_start,
        "shift_end": shift_end,
    }


def leave_intervals(timed_leave: list[dict]) -> list[tuple]:
    return [(r["corrected_check_in"], r["corrected_check_out"]) for r in timed_leave]


def day_alert_context(requests: list[dict], shift_info: Optional[dict], work_date: date, now: datetime) -> dict:
    """알림 공용 판단 — 출근 전 알림·출근 미감지·근무 중 끊김이 같이 쓴다.

    requests: 그날 살아 있는 신청(get_active_requests). 정정·그 밖 type 은 여기서 버린다.
    결재 대기는 get_active_requests 가 애초에 돌려주지 않는다.
    반환:
      no_alert_today — 종일 휴가·근무, 또는 시프트 전체를 덮는 시간형 휴가
      ref_in / ref_out — 기준 출근·퇴근 (유효 근무 구간, 시프트 없으면 None)
      exempt_now — 지금 시간형 휴가 중이거나, 시간형 근무가 이미 시작됨
      window — effective_work_window 결과 (시프트 없으면 None)
    """
    parts = split_requests(requests)
    bounds = shift_bounds(work_date, shift_info)
    window = None
    if bounds is not None:
        window = effective_work_window(bounds[0], bounds[1], leave_intervals(parts["timed_leave"]))
    no_alert_today = bool(parts["allday"]) or bool(window and window["full_cover"])
    exempt_now = any(
        r["corrected_check_in"] <= now < r["corrected_check_out"] for r in parts["timed_leave"]
    ) or any(r["corrected_check_in"] <= now for r in parts["timed_work"])
    return {
        "no_alert_today": no_alert_today,
        "ref_in": window["ref_in"] if window else None,
        "ref_out": window["ref_out"] if window else None,
        "exempt_now": exempt_now,
        "window": window,
        "timed_leave": parts["timed_leave"],
    }


def eval_keys(auto_status, is_late, is_early_leave, has_check_out: bool) -> list[str]:
    """평가 키 — lib/attendanceLabels.ts evalKeys 와 같은 규칙 (한쪽을 바꾸면 다른 쪽도)."""
    has_flags = isinstance(is_late, bool) or isinstance(is_early_leave, bool)
    if has_flags:
        keys = []
        if is_late:
            keys.append("late")
        if is_early_leave:
            keys.append("early_leave")
        if keys:
            return keys
        if auto_status == "absent":
            return ["absent"]
        if auto_status == "normal":
            return ["normal"]
        return ["normal"] if has_check_out else []
    if auto_status in ("late", "early_leave", "absent", "normal"):
        return [auto_status]
    return ["normal"] if has_check_out else []

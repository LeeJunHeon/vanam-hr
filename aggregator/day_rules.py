"""하루 판정·알림 공용 규칙 (순수 함수 — DB 접근 없음).

규칙을 바꾸면 npm run parity — 웹(TS)과 같은 케이스 파일(tests/parity/cases.json)로 결과를 비교한다.

- 하루 판정: judge_day(check_in, check_out, ctx) — 메인 경로·자유면 동기화·재계산이 모두 이 함수를 쓴다.
  ctx 는 build_judge_ctx 로 (직원, work_date)마다 한 번 만든다.
  웹 lib/attendance-judge.ts judgeDay 와 같은 규칙 — 한쪽을 바꾸면 다른 쪽도.
- 시프트 주기 dayIndex(resolve_shift_point), 연구미팅일(is_research_meeting_day),
  오늘 근무일(work_date_for) — 웹 shift-schedule.ts / researchMeeting.ts / kst-date.ts 와 같다.

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

# 살아 있는 신청 상태 — 웹 lib/attendance-live-requests.ts LIVE_REQUEST_STATUSES 와 같다.
LIVE_STATUSES = ("approved", "auto_approved", "auto_delegated")
# 휴가·근무 종류 — 웹 lib/category-kind.ts LEAVE_CATEGORY_TYPES / WORK_CATEGORY_TYPES 와 같다.
LEAVE_TYPES = ("leave", "long_leave")
WORK_TYPES = ("work",)
LEAVE_WORK_TYPES = LEAVE_TYPES + WORK_TYPES


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


def floor_minute(dt: Optional[datetime]) -> Optional[datetime]:
    """분 단위 절삭 — 화면 표시(HH:MM)와 동일 기준으로 판정/계산하기 위함."""
    return dt.replace(second=0, microsecond=0) if dt is not None else None


# ── 오늘 근무일 · 시프트 주기 · 연구미팅일 (DB 없이) ─────────────────────────

def work_date_for(now: datetime, cutoff_hour: int) -> date:
    """현재 시각의 work_date (KST, cutoff_hour 이전이면 전날). 웹 kst-date.ts kstWorkDateMidnightUtc 와 같다."""
    k = now.astimezone(KST)
    d = k.date()
    if k.hour < cutoff_hour:
        d = d - timedelta(days=1)
    return d


def resolve_shift_point(start_date: date, cycle_days: int, schedule, work_date: date) -> Optional[dict]:
    """배정 시작일이 속한 주의 월요일을 기준점으로 (경과일 % cycle_days) 번째 dayIndex point.
    웹 shift-schedule.ts resolveShiftPoint 와 같다."""
    if not isinstance(schedule, list) or cycle_days < 1:
        return None
    anchor = start_date - timedelta(days=start_date.weekday())
    day_offset = (work_date - anchor).days % cycle_days
    for p in schedule:
        if isinstance(p, dict) and p.get("dayIndex") == day_offset:
            return p
    return None


def is_research_meeting_day(work_date: date, weekday: int, interval_weeks: int, anchor: date) -> bool:
    """연구미팅일 — 웹 researchMeeting.ts isResearchMeetingDay 와 같다(ISO 요일, N주 1회)."""
    if interval_weeks < 1:
        return False
    if work_date.isoweekday() != weekday:
        return False

    def monday(d: date) -> date:
        return d - timedelta(days=d.isoweekday() - 1)

    week_diff = (monday(work_date) - monday(anchor)).days // 7
    return week_diff % interval_weeks == 0


# ── 하루 판정 ─────────────────────────────────────────────────────────────

def judge_shift(
    check_in: Optional[datetime],
    check_out: Optional[datetime],
    shift_info: Optional[dict],
    grace_in_minutes: int,
    grace_out_minutes: int,
    lunch_deduct_enabled: bool = False,
    lunch_start_str: str = "12:00",
    lunch_end_str: str = "13:00",
    trip_minutes: int = 0,
    margin_hours: float = 0.0,
    is_holiday: bool = False,
    ref_window: Optional[dict] = None,
) -> tuple:
    """정책 A 기반 auto_status 판정 (시프트·반차 구간). 반환: (auto_status, is_late, is_early_leave)

    (aggregator._determine_auto_status 본문을 그대로 옮김)
    1) 시프트 정보 없거나 휴무이거나 공휴일(is_holiday): 둘 다 → normal / 출근만 → working /
       둘 다 NULL → absent (플래그 False)
    2) 시프트 있음 + 둘 다 NULL → absent
    3) 시프트 있음 + check_out만 → None (판정 보류)
    4) 시프트 있음 + check_in 있음:
       - 출근 > 시프트 시작 + grace_in → late (퇴근 전에도 확정)
       - check_out 없음 + 지각 아님 → working
       - 근무시간 < 시프트 총 - grace_out(점심·여유시간 차감) + 퇴근 < 시프트 종료 - grace_out → early_leave
       - 그 외 → normal
    ref_window(반차 등, effective_work_window): 기준 출퇴근·의무 근무시간(유효 구간 − 가운데 휴가
    − grace_out − 유효 구간 안 점심)으로 같은 식.
    """
    check_in = floor_minute(check_in)
    check_out = floor_minute(check_out)

    if (
        shift_info is None
        or shift_info.get("type") == "off"
        or not shift_info.get("start")
        or not shift_info.get("end")
        or is_holiday
    ):
        if check_in is not None and check_out is not None:
            return "normal", False, False
        elif check_in is not None and check_out is None:
            return "working", False, False
        elif check_in is None and check_out is None:
            return "absent", False, False
        else:
            return None, False, False

    if check_in is None and check_out is None:
        return "absent", None, None
    if check_in is None and check_out is not None:
        return None, None, None

    if ref_window is not None:
        return _judge_window(
            check_in, check_out, ref_window, grace_in_minutes, grace_out_minutes,
            lunch_deduct_enabled, lunch_start_str, lunch_end_str,
            trip_minutes, margin_hours,
        )

    try:
        sh_h, sh_m = map(int, shift_info["start"].split(":"))
        eh_h, eh_m = map(int, shift_info["end"].split(":"))
    except (ValueError, AttributeError):
        return ("working" if check_out is None else "normal"), None, None

    shift_minutes = (eh_h * 60 + eh_m) - (sh_h * 60 + sh_m)
    if shift_minutes <= 0:
        shift_minutes += 24 * 60

    # 시프트 시작 시각을 check_in 날짜 기준 datetime으로 변환
    shift_start_dt = check_in.replace(hour=sh_h, minute=sh_m, second=0, microsecond=0)
    late_threshold = shift_start_dt + timedelta(minutes=grace_in_minutes)
    is_late = check_in > late_threshold

    if check_out is None:
        return ("late" if is_late else "working"), is_late, None

    actual_minutes = int((check_out - check_in).total_seconds() / 60)

    # 점심 차감 — check_in~check_out과 점심시간이 겹치는 만큼 근무시간에서 제외(켜졌을 때만)
    lunch_overlap = 0
    if lunch_deduct_enabled:
        try:
            ls_h, ls_m = map(int, str(lunch_start_str).split(":"))
            le_h, le_m = map(int, str(lunch_end_str).split(":"))
            lunch_start_dt = check_in.replace(hour=ls_h, minute=ls_m, second=0, microsecond=0)
            lunch_end_dt = check_in.replace(hour=le_h, minute=le_m, second=0, microsecond=0)
            ov_start = max(check_in, lunch_start_dt)
            ov_end = min(check_out, lunch_end_dt)
            if ov_end > ov_start:
                lunch_overlap = int((ov_end - ov_start).total_seconds() // 60)
        except (ValueError, AttributeError):
            lunch_overlap = 0
    actual_minutes -= lunch_overlap

    required_minutes = shift_minutes - grace_out_minutes
    if lunch_deduct_enabled:
        try:
            ls_h, ls_m = map(int, str(lunch_start_str).split(":"))
            le_h, le_m = map(int, str(lunch_end_str).split(":"))
            lunch_len = (le_h * 60 + le_m) - (ls_h * 60 + ls_m)
            if lunch_len > 0:
                required_minutes -= lunch_len
        except (ValueError, AttributeError):
            pass

    # 여유시간(margin_hours) — 출장 시간 + 앞뒤 마진만큼 의무시간 차감 (0 이면 차감 없음)
    if margin_hours > 0:
        margin_minutes = int(margin_hours * 60)
        required_minutes -= (trip_minutes + 2 * margin_minutes)

    if required_minutes < 0:
        required_minutes = 0

    shift_end_dt = shift_start_dt + timedelta(minutes=shift_minutes)
    early_threshold = shift_end_dt - timedelta(minutes=grace_out_minutes)
    is_early_leave = actual_minutes < required_minutes and check_out < early_threshold
    auto_status = "late" if is_late else ("early_leave" if is_early_leave else "normal")
    return auto_status, is_late, is_early_leave


def _judge_window(
    check_in, check_out, win, grace_in_minutes, grace_out_minutes,
    lunch_deduct_enabled, lunch_start_str, lunch_end_str, trip_minutes, margin_hours,
):
    """유효 근무 구간 기준 판정 (반차 등). (aggregator._determine_with_window 본문을 그대로 옮김)"""
    ref_in, ref_out = win["ref_in"], win["ref_out"]
    is_late = check_in > ref_in + timedelta(minutes=grace_in_minutes)
    if check_out is None:
        return ("late" if is_late else "working"), is_late, None

    def _lunch_bounds(base):
        ls_h, ls_m = map(int, str(lunch_start_str).split(":"))
        le_h, le_m = map(int, str(lunch_end_str).split(":"))
        b = base.astimezone(KST)
        return (b.replace(hour=ls_h, minute=ls_m, second=0, microsecond=0),
                b.replace(hour=le_h, minute=le_m, second=0, microsecond=0))

    def _overlap(a_s, a_e, b_s, b_e):
        s_, e_ = max(a_s, b_s), min(a_e, b_e)
        return int((e_ - s_).total_seconds() // 60) if e_ > s_ else 0

    actual_minutes = int((check_out - check_in).total_seconds() / 60)
    required_minutes = win["window_minutes"] - win["middle_minutes"] - grace_out_minutes
    if lunch_deduct_enabled:
        try:
            l_s, l_e = _lunch_bounds(check_in)
            actual_minutes -= _overlap(check_in, check_out, l_s, l_e)
            w_s, w_e = _lunch_bounds(ref_in)
            required_minutes -= _overlap(ref_in, ref_out, w_s, w_e)
        except (ValueError, AttributeError):
            pass
    if margin_hours > 0:
        required_minutes -= (trip_minutes + 2 * int(margin_hours * 60))
    if required_minutes < 0:
        required_minutes = 0
    early_threshold = ref_out - timedelta(minutes=grace_out_minutes)
    is_early_leave = actual_minutes < required_minutes and check_out < early_threshold
    auto_status = "late" if is_late else ("early_leave" if is_early_leave else "normal")
    return auto_status, is_late, is_early_leave


def build_judge_ctx(
    requests: list[dict],
    shift_info: Optional[dict],
    work_date: date,
    cutoff_hour: int,
    is_holiday: bool,
    now: datetime,
    grace_in_minutes: int = 10,
    grace_out_minutes: int = 0,
    lunch_deduct_enabled: bool = False,
    lunch_start_str: str = "12:00",
    lunch_end_str: str = "13:00",
    timed_trip_exempt: bool = False,
    timed_event_margin_hours: float = 0.0,
) -> dict:
    """그날 판정 맥락 — (직원, work_date)마다 한 번 만든다.

    requests: 그날 살아 있는 신청(get_active_requests). 근태 정정은 여기서 뺀다.
    - 여러 날에 걸친 시간형 → 종일(is_all_day_request)
    - 이 work_date 창 [cutoff, +1일) 에 시작하는 시간형만 시간형 휴가 / 시간형 근무로 나눈다
    """
    reqs = []
    for r in requests:
        if r.get("category_type") == "correction":
            continue
        if r.get("corrected_check_in") is not None and r.get("corrected_check_out") is not None \
                and is_all_day_request(r):
            r = {**r, "corrected_check_in": None, "corrected_check_out": None}
        reqs.append(r)

    day_start = datetime.combine(work_date, time(hour=cutoff_hour), tzinfo=KST)
    day_end = day_start + timedelta(days=1)

    def _in_work_date(ts):
        if ts is None:
            return False
        ts_kst = ts.astimezone(KST) if ts.tzinfo is not None else ts.replace(tzinfo=KST)
        return day_start <= ts_kst < day_end

    in_range_timed = [
        r for r in reqs
        if r["corrected_check_in"] is not None
        and r["corrected_check_out"] is not None
        and _in_work_date(r["corrected_check_in"])
    ]
    in_range_leave = [r for r in in_range_timed if r.get("category_type") in LEAVE_TYPES]
    in_range_work = [r for r in in_range_timed if r.get("category_type") not in LEAVE_TYPES]
    leave_window = None
    if in_range_leave:
        bounds = shift_bounds(work_date, shift_info)
        if bounds is not None:
            leave_window = effective_work_window(bounds[0], bounds[1], leave_intervals(in_range_leave))
    has_allday = any(
        r["corrected_check_in"] is None or r["corrected_check_out"] is None for r in reqs
    )
    return {
        "requests": reqs,
        "has_requests": bool(reqs),
        "has_allday": has_allday,
        "in_range_timed": in_range_timed,
        "in_range_leave": in_range_leave,
        "in_range_work": in_range_work,
        "leave_window": leave_window,
        "started_leave": [r for r in in_range_leave if r["corrected_check_in"] <= now],
        "shift_info": shift_info,
        "is_holiday": is_holiday,
        "now": now,
        "grace_in": grace_in_minutes,
        "grace_out": grace_out_minutes,
        "lunch_deduct_enabled": lunch_deduct_enabled,
        "lunch_start": lunch_start_str,
        "lunch_end": lunch_end_str,
        "timed_trip_exempt": timed_trip_exempt,
        "margin_hours": timed_event_margin_hours,
    }


def judge_day(check_in: Optional[datetime], check_out: Optional[datetime], ctx: dict) -> dict:
    """하루 판정 — 메인 경로와 같은 순서.

    신청이 없는 날: 시프트 판정(점심 포함, 여유시간 없음).
    신청이 있는 날:
      1) 종일 → 정상   2) 휴가가 시프트 전체를 덮음 → 정상
      3) timed_trip_exempt 켜짐 + 시간형 근무 있음 → 정상
      4) 시간형 근무 진행 중 → 판정 보류(working, 플래그 NULL) — reason 'ongoing'
         (메인 경로는 퇴근을 비우고, 자유면 동기화는 그 사이클을 건너뛴다)
      5) 출근 있고 (퇴근 있음 또는 반차 구간 있음) → 반차 구간 판정 또는 시프트 판정(점심·여유시간 포함)
      6) 출근만 → working(플래그 NULL)
      7) 출근 없음 → 정상 — reason 'no_checkin' (반차만 있는 날의 행 만들기·결근은 호출자 흐름)
    반환: {status, is_late, is_early_leave, reason}
    """
    def _r(st, l, e, reason):
        return {"status": st, "is_late": l, "is_early_leave": e, "reason": reason}

    shift = ctx["shift_info"]
    if not ctx["has_requests"]:
        st, l, e = judge_shift(
            check_in, check_out, shift, ctx["grace_in"], ctx["grace_out"],
            lunch_deduct_enabled=ctx["lunch_deduct_enabled"],
            lunch_start_str=ctx["lunch_start"], lunch_end_str=ctx["lunch_end"],
            is_holiday=ctx["is_holiday"],
        )
        return _r(st, l, e, "shift")

    win = ctx["leave_window"]
    now = ctx["now"]
    work = ctx["in_range_work"]
    if ctx["has_allday"]:
        return _r("normal", False, False, "allday")
    if win is not None and win["full_cover"]:
        return _r("normal", False, False, "full_cover")
    if ctx["timed_trip_exempt"] and work:
        return _r("normal", False, False, "exempt")
    if any(r["corrected_check_in"] <= now < r["corrected_check_out"] for r in work):
        return _r("working", None, None, "ongoing")
    if check_in is not None and (check_out is not None or win is not None):
        trip_minutes = 0
        for r in work:
            ci, co = r["corrected_check_in"], r["corrected_check_out"]
            if co > ci:
                trip_minutes += int((co - ci).total_seconds() // 60)
        st, l, e = judge_shift(
            check_in, check_out, shift, ctx["grace_in"], ctx["grace_out"],
            lunch_deduct_enabled=ctx["lunch_deduct_enabled"],
            lunch_start_str=ctx["lunch_start"], lunch_end_str=ctx["lunch_end"],
            # 여유시간은 그날 시간형 근무가 있을 때만 (출장 시간 + 앞뒤 이동 여유) — 웹 judgeDay 와 같게
            trip_minutes=trip_minutes, margin_hours=ctx["margin_hours"] if work else 0.0,
            is_holiday=ctx["is_holiday"], ref_window=win,
        )
        return _r(st, l, e, "judged")
    if check_in is not None:
        return _r("working", None, None, "working")
    return _r("normal", False, False, "no_checkin")


# ── 근무일 경계(cutoff)를 넘긴 연결 ─────────────────────────────────────────

OVERNIGHT_MAX_HOURS_DEFAULT = 6
OVERNIGHT_MAX_HOURS_LIMIT = 12


def overnight_max_hours(enabled, raw_value) -> tuple:
    """경계를 넘긴 세션을 기다리는 연장 시간 M(시간). 반환: (M, 범위를 벗어나 잘랐는가).

    - 정책(overnight_extend_enabled)이 꺼져 있으면 0 — 경계에서 바로 나눈다.
    - 켜져 있으면 overnight_extend_max_hours (없거나 파싱 실패 시 6).
    - 0~12 시간으로 자른다(판단 대기가 다음 근무일까지 이어지지 않게). 잘랐으면 호출자가 경고 로그.
    """
    if str(enabled).strip().lower() != "true":
        return 0, False
    try:
        m = int(str(raw_value).strip())
    except (TypeError, ValueError):
        return OVERNIGHT_MAX_HOURS_DEFAULT, False
    if m < 0:
        return 0, True
    if m > OVERNIGHT_MAX_HOURS_LIMIT:
        return OVERNIGHT_MAX_HOURS_LIMIT, True
    return m, False


def boundary_session(records: list, boundary: datetime, max_hours: int, grace_minutes: int, now: datetime) -> tuple:
    """근무일 경계 B 에 열려 있던(연결된 채 넘어온) 세션이 어떻게 끝났는지.

    records: B 이후 presence 기록(checked_at 오름차순, 직원 단위). [B, B + M + grace) 면 충분하다.
    반환:
      ("closed", C) — 연장 시간 M 안에 끝남. 전날 퇴근 = C, B~C 기록은 전날 몫(다음 날 출근으로 세지 않음)
      ("open", None) — M 이 지나도록 끝나지 않음. 경계에서 나눈다: 전날 퇴근 = B, 다음 날 출근 = B(이월 출근)
      ("pending", None) — 아직 판단할 수 없음. 전날 퇴근은 비워 두고, 다음 날은 그 기록을 아직 쓰지 않는다
    끝 = 뒤로 grace 이상 재연결이 없는 offline. [B, B + M) 안의 offline 을 차례로 보고, 다음 기록이
    grace 안이면 잠깐 끊김이므로 계속 본다. 다음 기록이 없으면 now − offline ≥ grace 일 때 끝.
    M = 0 이면 경계를 지나는 순간 open.

    알려진 한계: 폰을 회사에 두고 가면 연결이 이어져 밤샘처럼 보인다(데이터로 구별할 수 없음 —
    근태 정정으로 고친다).
    """
    limit = boundary + timedelta(hours=max_hours)
    grace = timedelta(minutes=grace_minutes)
    for i, rec in enumerate(records):
        t = rec["checked_at"]
        if t < boundary:
            continue
        if t >= limit:
            break
        if rec["status"] != "offline":
            continue
        nxt = next((r for r in records[i + 1:] if r["checked_at"] > t), None)
        if nxt is None:
            if now - t >= grace:
                return "closed", t
            return "pending", None
        if nxt["checked_at"] - t >= grace:
            return "closed", t
        # grace 안 재연결 — 잠깐 끊김, 계속 본다
    if now >= limit:
        return "open", None
    return "pending", None

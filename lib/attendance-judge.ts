// 하루 근태 판정 — 순수 함수 (DB·서버 전용 import 없음).
// aggregator/day_rules.py judge_day·judge_shift·build_judge_ctx·effective_work_window 와 같은 규칙
// — 한쪽을 바꾸면 다른 쪽도. 규칙을 바꾸면 npm run parity (tests/parity/cases.json 으로 두 언어 비교).
//
// 웹 정정 계산(lib/attendance-correction computeCorrectedDaily)이 이 함수로 판정한다.
// 정정한 시각은 사람이 넣은 값이므로 외근 시각과 합치지 않는다(합치기는 aggregator 흐름).
import { LEAVE_CATEGORY_TYPES } from "@/lib/category-kind";

const KST_MS = 9 * 60 * 60 * 1000;
const MIN_MS = 60 * 1000;

function floorMinute(d: Date | null): Date | null {
  if (!d) return null;
  const c = new Date(d);
  c.setSeconds(0, 0);
  return c;
}

// KST 달력 날짜(y, m, d)의 hh:mm → Date
function kstAt(y: number, m: number, d: number, hh: number, mm: number): Date {
  return new Date(Date.UTC(y, m, d, hh, mm) - KST_MS);
}

// ts 의 KST 달력 날짜를 기준으로 hh:mm (Python dt.replace(hour, minute) 와 같음 — dt 는 KST)
function sameKstDayAt(ts: Date, hh: number, mm: number): Date {
  const k = new Date(ts.getTime() + KST_MS);
  return kstAt(k.getUTCFullYear(), k.getUTCMonth(), k.getUTCDate(), hh, mm);
}

function parseHHMM(s: string | null | undefined): [number, number] | null {
  if (typeof s !== "string") return null;
  const parts = s.split(":");
  if (parts.length !== 2) return null;
  const h = Number(parts[0]);
  const m = Number(parts[1]);
  if (!Number.isInteger(h) || !Number.isInteger(m) || parts[0].trim() === "" || parts[1].trim() === "") {
    return null;
  }
  return [h, m];
}

function kstYmd(d: Date): string {
  return new Date(d.getTime() + KST_MS).toISOString().slice(0, 10);
}

// ── 종일 판정 · 유효 근무 구간 ───────────────────────────────────────────────

// 종일 — 시각 한쪽이라도 없거나, 두 시각의 KST 날짜가 다르면(다일 시간형) 종일.
export function isAllDayRequest(
  correctedCheckIn: Date | null,
  correctedCheckOut: Date | null
): boolean {
  if (!correctedCheckIn || !correctedCheckOut) return true;
  return kstYmd(correctedCheckIn) !== kstYmd(correctedCheckOut);
}

export interface EffectiveWorkWindow {
  refIn: Date;
  refOut: Date;
  fullCover: boolean;
  windowMinutes: number;
  middleMinutes: number;
}

// 시프트 [시작, 종료]에서 시간형 휴가를 뺀 유효 근무 구간 (day_rules.effective_work_window)
// - 휴가가 시프트 시작을 덮으면: 기준 출근 = 휴가 끝(이어지는 휴가까지)
// - 휴가가 시프트 종료를 덮으면: 기준 퇴근 = 휴가 시작
// - 가운데 휴가: 기준 출퇴근 그대로, 의무 근무시간에서 겹치는 만큼(middleMinutes) 뺀다
// - 휴가가 시프트 전체를 덮으면 fullCover
export function effectiveWorkWindow(
  shiftStart: Date,
  shiftEnd: Date,
  leaves: { start: Date; end: Date }[]
): EffectiveWorkWindow {
  let refIn = shiftStart.getTime();
  let refOut = shiftEnd.getTime();
  let changed = true;
  while (changed) {
    changed = false;
    for (const l of leaves) {
      if (l.start.getTime() <= refIn && refIn < l.end.getTime()) {
        refIn = l.end.getTime();
        changed = true;
      }
    }
  }
  changed = true;
  while (changed) {
    changed = false;
    for (const l of leaves) {
      if (l.start.getTime() < refOut && refOut <= l.end.getTime()) {
        refOut = l.start.getTime();
        changed = true;
      }
    }
  }
  if (refIn >= refOut) {
    return { refIn: new Date(refIn), refOut: new Date(refOut), fullCover: true, windowMinutes: 0, middleMinutes: 0 };
  }
  let middle = 0;
  for (const l of leaves) {
    const s = Math.max(l.start.getTime(), refIn);
    const e = Math.min(l.end.getTime(), refOut);
    if (e > s) middle += Math.floor((e - s) / MIN_MS);
  }
  return {
    refIn: new Date(refIn),
    refOut: new Date(refOut),
    fullCover: false,
    windowMinutes: Math.floor((refOut - refIn) / MIN_MS),
    middleMinutes: middle,
  };
}

export interface ShiftInfo {
  start: string | null;
  end: string | null;
  type?: string | null;
}

function isWorkShift(s: ShiftInfo | null): s is ShiftInfo & { start: string; end: string } {
  return !!(s && s.type !== "off" && s.start && s.end);
}

// 근무일(UTC 자정 date) + 시프트 → KST 기준 [시작, 종료]. 종료 <= 시작이면 +1일. (day_rules.shift_bounds)
export function shiftBoundsKst(
  workDate: Date,
  startHHMM: string | null,
  endHHMM: string | null
): { start: Date; end: Date } | null {
  const sh = parseHHMM(startHHMM);
  const eh = parseHHMM(endHHMM);
  if (!sh || !eh) return null;
  const y = workDate.getUTCFullYear();
  const m = workDate.getUTCMonth();
  const d = workDate.getUTCDate();
  const start = kstAt(y, m, d, sh[0], sh[1]);
  const end = kstAt(y, m, d, eh[0], eh[1]);
  if (end <= start) end.setUTCDate(end.getUTCDate() + 1);
  return { start, end };
}

// ── 판정 ──────────────────────────────────────────────────────────────────

export type JudgeResult = [string | null, boolean | null, boolean | null];

export interface JudgeShiftOptions {
  lunchDeductEnabled?: boolean;
  lunchStart?: string;
  lunchEnd?: string;
  tripMinutes?: number;
  marginHours?: number;
  isHoliday?: boolean;
  refWindow?: EffectiveWorkWindow | null;
}

// 시프트·반차 구간 판정 (day_rules.judge_shift). 반환: [auto_status, is_late, is_early_leave]
//   시프트 없음·휴무·공휴일: 둘 다 → normal / 출근만 → working / 둘 다 없음 → absent (플래그 false)
//   시프트 있음: 둘 다 없음 → absent / 퇴근만 → null
//   지각 = 출근 > 시프트 시작 + grace_in (퇴근 전에도 확정; 퇴근 전이면 late 아니면 working, 조퇴 null)
//   조퇴 = 근무시간 < 시프트 총 − grace_out(점심·여유시간 차감) 이면서 퇴근 < 시프트 종료 − grace_out
export function judgeShift(
  checkIn: Date | null,
  checkOut: Date | null,
  shift: ShiftInfo | null,
  graceIn: number,
  graceOut: number,
  opt: JudgeShiftOptions = {}
): JudgeResult {
  const lunchDeduct = !!opt.lunchDeductEnabled;
  const lunchStart = opt.lunchStart ?? "12:00";
  const lunchEnd = opt.lunchEnd ?? "13:00";
  const tripMinutes = opt.tripMinutes ?? 0;
  const marginHours = opt.marginHours ?? 0;
  checkIn = floorMinute(checkIn);
  checkOut = floorMinute(checkOut);

  if (!isWorkShift(shift) || opt.isHoliday) {
    if (checkIn && checkOut) return ["normal", false, false];
    if (checkIn && !checkOut) return ["working", false, false];
    if (!checkIn && !checkOut) return ["absent", false, false];
    return [null, false, false];
  }
  if (!checkIn && !checkOut) return ["absent", null, null];
  if (!checkIn) return [null, null, null];

  if (opt.refWindow) {
    return judgeWindow(checkIn, checkOut, opt.refWindow, graceIn, graceOut, lunchDeduct, lunchStart, lunchEnd, tripMinutes, marginHours);
  }

  const sh = parseHHMM(shift.start);
  const eh = parseHHMM(shift.end);
  if (!sh || !eh) return [checkOut ? "normal" : "working", null, null];

  let shiftMinutes = eh[0] * 60 + eh[1] - (sh[0] * 60 + sh[1]);
  if (shiftMinutes <= 0) shiftMinutes += 24 * 60;

  // 시프트 시작 = 출근 시각의 KST 날짜 기준
  const shiftStart = sameKstDayAt(checkIn, sh[0], sh[1]);
  const isLate = checkIn.getTime() > shiftStart.getTime() + graceIn * MIN_MS;
  if (!checkOut) return [isLate ? "late" : "working", isLate, null];

  let actual = Math.trunc((checkOut.getTime() - checkIn.getTime()) / MIN_MS);
  let required = shiftMinutes - graceOut;
  if (lunchDeduct) {
    const ls = parseHHMM(lunchStart);
    const le = parseHHMM(lunchEnd);
    if (ls && le) {
      const lS = sameKstDayAt(checkIn, ls[0], ls[1]).getTime();
      const lE = sameKstDayAt(checkIn, le[0], le[1]).getTime();
      const ovS = Math.max(checkIn.getTime(), lS);
      const ovE = Math.min(checkOut.getTime(), lE);
      if (ovE > ovS) actual -= Math.floor((ovE - ovS) / MIN_MS);
      const lunchLen = le[0] * 60 + le[1] - (ls[0] * 60 + ls[1]);
      if (lunchLen > 0) required -= lunchLen;
    }
  }
  if (marginHours > 0) required -= tripMinutes + 2 * Math.trunc(marginHours * 60);
  if (required < 0) required = 0;
  const shiftEnd = shiftStart.getTime() + shiftMinutes * MIN_MS;
  const isEarlyLeave = actual < required && checkOut.getTime() < shiftEnd - graceOut * MIN_MS;
  return [isLate ? "late" : isEarlyLeave ? "early_leave" : "normal", isLate, isEarlyLeave];
}

// 유효 근무 구간 기준 판정 (day_rules._judge_window)
function judgeWindow(
  checkIn: Date,
  checkOut: Date | null,
  w: EffectiveWorkWindow,
  graceIn: number,
  graceOut: number,
  lunchDeduct: boolean,
  lunchStart: string,
  lunchEnd: string,
  tripMinutes: number,
  marginHours: number
): JudgeResult {
  const isLate = checkIn.getTime() > w.refIn.getTime() + graceIn * MIN_MS;
  if (!checkOut) return [isLate ? "late" : "working", isLate, null];
  const overlap = (aS: number, aE: number, bS: number, bE: number) => {
    const s = Math.max(aS, bS);
    const e = Math.min(aE, bE);
    return e > s ? Math.floor((e - s) / MIN_MS) : 0;
  };
  let actual = Math.trunc((checkOut.getTime() - checkIn.getTime()) / MIN_MS);
  let required = w.windowMinutes - w.middleMinutes - graceOut;
  if (lunchDeduct) {
    const ls = parseHHMM(lunchStart);
    const le = parseHHMM(lunchEnd);
    if (ls && le) {
      actual -= overlap(
        checkIn.getTime(), checkOut.getTime(),
        sameKstDayAt(checkIn, ls[0], ls[1]).getTime(), sameKstDayAt(checkIn, le[0], le[1]).getTime()
      );
      required -= overlap(
        w.refIn.getTime(), w.refOut.getTime(),
        sameKstDayAt(w.refIn, ls[0], ls[1]).getTime(), sameKstDayAt(w.refIn, le[0], le[1]).getTime()
      );
    }
  }
  if (marginHours > 0) required -= tripMinutes + 2 * Math.trunc(marginHours * 60);
  if (required < 0) required = 0;
  const isEarlyLeave = actual < required && checkOut.getTime() < w.refOut.getTime() - graceOut * MIN_MS;
  return [isLate ? "late" : isEarlyLeave ? "early_leave" : "normal", isLate, isEarlyLeave];
}

// ── 그날 판정 맥락 + 하루 판정 ─────────────────────────────────────────────

export interface JudgeRequest {
  categoryType: string | null;
  correctedCheckIn: Date | null;
  correctedCheckOut: Date | null;
}

export interface JudgePolicy {
  graceInMinutes: number;
  graceOutMinutes: number;
  lunchDeductEnabled: boolean;
  lunchStart: string;
  lunchEnd: string;
  timedTripExempt: boolean;
  timedEventMarginHours: number;
}

export interface JudgeCtx {
  hasRequests: boolean;
  hasAllDay: boolean;
  inRangeWork: { start: Date; end: Date }[];
  leaveWindow: EffectiveWorkWindow | null;
  shift: ShiftInfo | null;
  isHoliday: boolean;
  now: Date;
  policy: JudgePolicy;
}

// 그날 판정 맥락 (day_rules.build_judge_ctx). requests: 그날 살아 있는 신청 — 정정은 여기서 뺀다.
// 여러 날 시간형 → 종일, 이 work_date 창 [cutoff, +1일) 에 시작하는 시간형만 휴가/근무로 나눈다.
export function buildJudgeCtx(
  requests: JudgeRequest[],
  shift: ShiftInfo | null,
  workDate: Date,
  cutoffHour: number,
  isHoliday: boolean,
  now: Date,
  policy: JudgePolicy
): JudgeCtx {
  const reqs = requests
    .filter((r) => r.categoryType !== "correction")
    .map((r) =>
      r.correctedCheckIn && r.correctedCheckOut && isAllDayRequest(r.correctedCheckIn, r.correctedCheckOut)
        ? { ...r, correctedCheckIn: null, correctedCheckOut: null }
        : r
    );
  const dayStart = kstAt(workDate.getUTCFullYear(), workDate.getUTCMonth(), workDate.getUTCDate(), cutoffHour, 0).getTime();
  const dayEnd = dayStart + 24 * 60 * MIN_MS;
  const timed = reqs.filter(
    (r) =>
      r.correctedCheckIn &&
      r.correctedCheckOut &&
      r.correctedCheckIn.getTime() >= dayStart &&
      r.correctedCheckIn.getTime() < dayEnd
  ) as (JudgeRequest & { correctedCheckIn: Date; correctedCheckOut: Date })[];
  const isLeave = (t: string | null) => !!t && LEAVE_CATEGORY_TYPES.includes(t);
  const leaves = timed.filter((r) => isLeave(r.categoryType));
  const work = timed.filter((r) => !isLeave(r.categoryType));
  let leaveWindow: EffectiveWorkWindow | null = null;
  if (leaves.length > 0 && isWorkShift(shift)) {
    const b = shiftBoundsKst(workDate, shift.start, shift.end);
    if (b) {
      leaveWindow = effectiveWorkWindow(
        b.start,
        b.end,
        leaves.map((r) => ({ start: r.correctedCheckIn, end: r.correctedCheckOut }))
      );
    }
  }
  return {
    hasRequests: reqs.length > 0,
    hasAllDay: reqs.some((r) => !r.correctedCheckIn || !r.correctedCheckOut),
    inRangeWork: work.map((r) => ({ start: r.correctedCheckIn, end: r.correctedCheckOut })),
    leaveWindow,
    shift,
    isHoliday,
    now,
    policy,
  };
}

export interface JudgeDayResult {
  status: string | null;
  isLate: boolean | null;
  isEarlyLeave: boolean | null;
  reason: "shift" | "allday" | "full_cover" | "exempt" | "ongoing" | "judged" | "working" | "no_checkin";
}

// 하루 판정 (day_rules.judge_day) — 메인 경로와 같은 순서.
//   신청 없는 날: 시프트 판정(점심 포함, 여유시간 없음)
//   신청 있는 날: 종일 → 정상 / 휴가가 시프트 전체 → 정상 / exempt + 시간형 근무 → 정상 /
//   시간형 근무 진행 중 → working(플래그 null) / 출근 있고 (퇴근 또는 반차 구간) → 구간·시프트 판정 /
//   출근만 → working(플래그 null) / 출근 없음 → 정상
export function judgeDay(checkIn: Date | null, checkOut: Date | null, ctx: JudgeCtx): JudgeDayResult {
  const p = ctx.policy;
  const r = (st: string | null, l: boolean | null, e: boolean | null, reason: JudgeDayResult["reason"]): JudgeDayResult => ({
    status: st, isLate: l, isEarlyLeave: e, reason,
  });
  if (!ctx.hasRequests) {
    const [st, l, e] = judgeShift(checkIn, checkOut, ctx.shift, p.graceInMinutes, p.graceOutMinutes, {
      lunchDeductEnabled: p.lunchDeductEnabled,
      lunchStart: p.lunchStart,
      lunchEnd: p.lunchEnd,
      isHoliday: ctx.isHoliday,
    });
    return r(st, l, e, "shift");
  }
  const w = ctx.leaveWindow;
  const now = ctx.now.getTime();
  if (ctx.hasAllDay) return r("normal", false, false, "allday");
  if (w && w.fullCover) return r("normal", false, false, "full_cover");
  if (p.timedTripExempt && ctx.inRangeWork.length > 0) return r("normal", false, false, "exempt");
  if (ctx.inRangeWork.some((x) => x.start.getTime() <= now && now < x.end.getTime())) {
    return r("working", null, null, "ongoing");
  }
  if (checkIn && (checkOut || w)) {
    let tripMinutes = 0;
    for (const x of ctx.inRangeWork) {
      if (x.end > x.start) tripMinutes += Math.floor((x.end.getTime() - x.start.getTime()) / MIN_MS);
    }
    const [st, l, e] = judgeShift(checkIn, checkOut, ctx.shift, p.graceInMinutes, p.graceOutMinutes, {
      lunchDeductEnabled: p.lunchDeductEnabled,
      lunchStart: p.lunchStart,
      lunchEnd: p.lunchEnd,
      tripMinutes,
      marginHours: p.timedEventMarginHours,
      isHoliday: ctx.isHoliday,
      refWindow: w,
    });
    return r(st, l, e, "judged");
  }
  if (checkIn) return r("working", null, null, "working");
  return r("normal", false, false, "no_checkin");
}

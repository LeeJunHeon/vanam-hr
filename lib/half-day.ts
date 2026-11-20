// 반차 기본 시각 — 그날 시프트(시작·종료)와 반차 경계(시작 후 분)로 오전·오후 반차 시각을 정한다.
// 순수 함수 — 클라이언트(신청 화면·시프트 패턴 화면)와 서버(API)가 같이 쓴다. 서버 전용 모듈 import 금지.
//
// 규칙
//  - 오전반차(HALF_AM) = 시작 ~ 경계, 오후반차(HALF_PM) = 경계 ~ 종료. 경계 = 시작 + 경계 분.
//  - 경계가 시프트 밖이면 시프트 범위 안으로 자른다.
//  - 경계 분: 시프트 패턴의 half_day_split_minutes → 없으면 정책 half_day_split_minutes → 없으면 240.
//  - 시프트 미배정 직원: 예전 고정값(09:00~13:00 / 13:00~18:00) — 미배정이면 월~금 근무로 보는 기존 규칙과 같게.
//  - 휴무일·공휴일·자정 넘는 시프트: 자동 채움 없음(빈칸 — 종일로 등록되지 않게 사용자가 직접 넣는다).
// 근태 판정(aggregator·lib/attendance-judge)은 "시프트 − 신청 시각"으로 하므로 여기 값은 입력 기본값일 뿐이다.

export const DEFAULT_HALF_DAY_SPLIT_MINUTES = 240;
export const HALF_DAY_SPLIT_POLICY_KEY = "half_day_split_minutes";
/** 반차 경계 입력 단위(분) */
export const HALF_DAY_SPLIT_STEP = 30;

export type HalfDayCode = "HALF_AM" | "HALF_PM";
export interface TimeRange {
  in: string; // HH:MM
  out: string; // HH:MM
}
export type HalfDayTimes = Record<HalfDayCode, TimeRange>;

/** 시프트 미배정 직원용 — 예전 고정값 */
export const HALF_DAY_FALLBACK: HalfDayTimes = {
  HALF_AM: { in: "09:00", out: "13:00" },
  HALF_PM: { in: "13:00", out: "18:00" },
};

export function isHalfDayCode(code: string | null | undefined): code is HalfDayCode {
  return code === "HALF_AM" || code === "HALF_PM";
}

function toMin(hhmm: string | null | undefined): number | null {
  if (!hhmm || !/^\d{2}:\d{2}$/.test(hhmm)) return null;
  const h = Number(hhmm.slice(0, 2));
  const m = Number(hhmm.slice(3, 5));
  return h < 24 && m < 60 ? h * 60 + m : null;
}

function toHHMM(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
}

/** 시프트 길이(분). 형식이 틀리거나 자정을 넘기면(종료 ≤ 시작) null */
export function shiftLengthMinutes(start: string | null | undefined, end: string | null | undefined): number | null {
  const s = toMin(start);
  const e = toMin(end);
  if (s === null || e === null || e <= s) return null;
  return e - s;
}

/**
 * 그날 시프트·경계 분 → 오전·오후 반차 시각.
 * 시프트 시각이 없거나 자정을 넘기면 null (자동 채움 없음).
 */
export function halfDayTimes(
  shiftStart: string | null | undefined,
  shiftEnd: string | null | undefined,
  splitMinutes: number
): (HalfDayTimes & { split: string }) | null {
  const s = toMin(shiftStart);
  const len = shiftLengthMinutes(shiftStart, shiftEnd);
  if (s === null || len === null) return null;
  const offset = Math.min(Math.max(Number.isFinite(splitMinutes) ? splitMinutes : 0, 0), len);
  const split = toHHMM(s + offset);
  const start = toHHMM(s);
  const end = toHHMM(s + len);
  return {
    HALF_AM: { in: start, out: split },
    HALF_PM: { in: split, out: end },
    split,
  };
}

/** 그날 시프트 상태 (서버가 직원·날짜로 구해 넘긴다) */
export interface DayShiftInfo {
  /** 그날을 덮는 시프트 배정이 있는지 */
  assigned: boolean;
  /** 근무일 — 배정 있으면 근무 포인트, 미배정이면 월~금. 공휴일은 false */
  isWorkDay: boolean;
  start: string | null;
  end: string | null;
}

export type HalfDayDefaults =
  | { kind: "shift"; times: HalfDayTimes; split: string }
  | { kind: "fallback"; times: HalfDayTimes; split: string }
  | { kind: "none"; reason: "off_day" | "overnight" };

/** 그날 반차 기본 시각 — 근무일이 아니거나 자정 넘는 시프트면 none */
export function halfDayDefaultsFor(day: DayShiftInfo, splitMinutes: number): HalfDayDefaults {
  if (!day.isWorkDay) return { kind: "none", reason: "off_day" };
  if (!day.assigned) return { kind: "fallback", times: HALF_DAY_FALLBACK, split: HALF_DAY_FALLBACK.HALF_AM.out };
  const t = halfDayTimes(day.start, day.end, splitMinutes);
  if (!t) return { kind: "none", reason: "overnight" };
  return { kind: "shift", times: { HALF_AM: t.HALF_AM, HALF_PM: t.HALF_PM }, split: t.split };
}

/** 정책·패턴 값 해석 — 양의 정수만, 아니면 null */
export function parseSplitMinutes(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v.trim()) : NaN;
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** 패턴 값 → 정책 값 → 240 */
export function effectiveSplitMinutes(patternValue: number | null | undefined, policyValue: number | null | undefined): number {
  return parseSplitMinutes(patternValue) ?? parseSplitMinutes(policyValue) ?? DEFAULT_HALF_DAY_SPLIT_MINUTES;
}

/**
 * 시프트 패턴 반차 경계 검증 — null(기본값 사용) 또는 30분 단위, 0 초과, 그 패턴의 가장 짧은 근무일 시프트 길이 미만.
 * 오류 문구 또는 null.
 */
export function validatePatternSplit(
  value: unknown,
  schedule: { type?: string; start?: string | null; end?: string | null }[]
): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return "반차 경계는 0보다 큰 분(정수)이어야 합니다.";
  }
  if (value % HALF_DAY_SPLIT_STEP !== 0) return `반차 경계는 ${HALF_DAY_SPLIT_STEP}분 단위여야 합니다.`;
  const lengths = schedule
    .filter((p) => p && p.type !== "off")
    .map((p) => shiftLengthMinutes(p.start, p.end))
    .filter((n): n is number => n !== null);
  if (lengths.length > 0) {
    const min = Math.min(...lengths);
    if (value >= min) {
      return `반차 경계(${formatSplit(value)})는 근무 시간(${formatSplit(min)})보다 짧아야 합니다.`;
    }
  }
  return null;
}

/** 240 → "4시간", 270 → "4시간 30분" */
export function formatSplit(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}분`;
  return m ? `${h}시간 ${m}분` : `${h}시간`;
}

/** 패턴의 대표 근무일 시프트 — 근무 포인트 중 가장 많이 나오는 (시작, 종료) */
export function representativeShift(
  schedule: { type?: string; start?: string | null; end?: string | null }[]
): { start: string; end: string } | null {
  const count = new Map<string, number>();
  for (const p of schedule) {
    if (!p || p.type === "off" || !p.start || !p.end) continue;
    const k = `${p.start}~${p.end}`;
    count.set(k, (count.get(k) ?? 0) + 1);
  }
  let best: string | null = null;
  for (const [k, n] of count) if (best === null || n > (count.get(best) ?? 0)) best = k;
  if (!best) return null;
  const [start, end] = best.split("~");
  return { start, end };
}

/** GET /api/my-shift/half-day 응답 — 직원·날짜의 시프트·반차 경계·반차 기본 시각 */
export interface HalfDayInfo {
  date: string;
  employeeId: number;
  assigned: boolean;
  isWorkDay: boolean;
  isHoliday: boolean;
  shiftStart: string | null;
  shiftEnd: string | null;
  splitMinutes: number;
  /** 경계 분의 출처 — 패턴 값 / 정책 값 / 코드 기본값 */
  splitSource: "pattern" | "policy" | "default";
  defaults: HalfDayDefaults;
}

/** 시간 입력 칸 아래 안내 — "내 시프트 07:00~17:00 · 반차 경계 12:00 (직접 수정 가능)" */
export function halfDayHint(info: HalfDayInfo, who: "내" | "직원" = "내"): string {
  if (info.defaults.kind === "none") {
    return info.defaults.reason === "off_day"
      ? "이 날은 근무일이 아닙니다"
      : `${who} 시프트 ${info.shiftStart}~${info.shiftEnd} (자정을 넘는 시프트 — 시각을 직접 입력하세요)`;
  }
  const shift =
    info.defaults.kind === "fallback"
      ? `시프트 미배정 — 기본 ${HALF_DAY_FALLBACK.HALF_AM.in}~${HALF_DAY_FALLBACK.HALF_PM.out}`
      : `${who} 시프트 ${info.shiftStart}~${info.shiftEnd}`;
  return `${shift} · 반차 경계 ${info.defaults.split} (직접 수정 가능)`;
}

// ── 신청 화면 시각 입력 검증 ──
// 반차는 시작·종료 시각이 반드시 있어야 한다 — 비우면 연차는 0.5일 차감인데 근태 판정·캘린더는 종일 휴가가 된다.
// 반차가 아닌 시간 입력 카테고리는 기존대로 둘 다 비우면 종일, 한쪽만은 막는다.
export const HALF_DAY_TIME_REQUIRED_MSG = "반차는 시작·종료 시각을 입력해야 합니다.";
export const TIME_PAIR_REQUIRED_MSG =
  "시작 시간과 종료 시간을 모두 입력하거나, 모두 비워주세요. (모두 비우면 종일 일정으로 등록됩니다.)";

/** 신청 시각 입력 오류 문구 또는 null */
export function requestTimeInputError(
  categoryCode: string | null | undefined,
  checkIn: string | null | undefined,
  checkOut: string | null | undefined
): string | null {
  const inFilled = !!checkIn?.trim();
  const outFilled = !!checkOut?.trim();
  if (isHalfDayCode(categoryCode)) return inFilled && outFilled ? null : HALF_DAY_TIME_REQUIRED_MSG;
  return inFilled !== outFilled ? TIME_PAIR_REQUIRED_MSG : null;
}

/** 그날 시프트 정보를 못 받았을 때 안내 */
export const HALF_DAY_INFO_FAILED_MSG = "시프트 정보를 불러오지 못했습니다 — 시각을 직접 입력하세요";

// 분기 성과 판정 규칙 — 분기 계산, 회차 상태, 성과표 상태 표시, 편집/제출 가능 여부.
// 서버(API)와 화면이 같이 쓴다. "오늘"은 항상 서버가 KST 로 구해 넘긴 todayYmd 를 쓴다.
// ⚠ prisma 등 서버 전용 모듈을 import 하지 말 것 (클라이언트 번들에 들어감).

export interface YearQuarter {
  year: number;
  quarter: number;
}

// ── 날짜(YYYY-MM-DD) 유틸 ──

const YMD_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** 실제로 존재하는 날짜의 "YYYY-MM-DD" 인지 */
export function isValidYmd(v: unknown): v is string {
  if (typeof v !== "string") return false;
  const m = YMD_RE.exec(v);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.toISOString().slice(0, 10) === v;
}

function ymdToUtcMs(ymd: string): number {
  const [y, m, d] = ymd.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

export function addDaysYmd(ymd: string, days: number): string {
  return new Date(ymdToUtcMs(ymd) + days * 86400000).toISOString().slice(0, 10);
}

/** to - from (일) */
export function diffDaysYmd(from: string, to: string): number {
  return Math.round((ymdToUtcMs(to) - ymdToUtcMs(from)) / 86400000);
}

const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];

/** "10월 12일" / withWeekday 면 "10월 12일(월)" */
export function formatMonthDay(ymd: string, withWeekday = false): string {
  const [, m, d] = ymd.split("-").map(Number);
  const base = `${m}월 ${d}일`;
  if (!withWeekday) return base;
  return `${base}(${WEEKDAYS[new Date(ymdToUtcMs(ymd)).getUTCDay()]})`;
}

function kstParts(iso: string) {
  const d = new Date(new Date(iso).getTime() + 9 * 3600000);
  return {
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hh: String(d.getUTCHours()).padStart(2, "0"),
    mm: String(d.getUTCMinutes()).padStart(2, "0"),
  };
}

/** 서버 시각(ISO) → KST "M/D HH:mm" */
export function formatKstShort(iso: string): string {
  const p = kstParts(iso);
  return `${p.month}/${p.day} ${p.hh}:${p.mm}`;
}

/** 서버 시각(ISO) → KST "HH:mm" */
export function formatKstTime(iso: string): string {
  const p = kstParts(iso);
  return `${p.hh}:${p.mm}`;
}

// ── 분기 유틸 ──

export function quarterOfYmd(ymd: string): YearQuarter {
  const [y, m] = ymd.split("-").map(Number);
  return { year: y, quarter: Math.floor((m - 1) / 3) + 1 };
}

export function prevQuarter({ year, quarter }: YearQuarter): YearQuarter {
  return quarter === 1 ? { year: year - 1, quarter: 4 } : { year, quarter: quarter - 1 };
}

export function nextQuarter({ year, quarter }: YearQuarter): YearQuarter {
  return quarter === 4 ? { year: year + 1, quarter: 1 } : { year, quarter: quarter + 1 };
}

/** a < b 면 음수, 같으면 0, a > b 면 양수 */
export function compareQuarter(a: YearQuarter, b: YearQuarter): number {
  return a.year !== b.year ? a.year - b.year : a.quarter - b.quarter;
}

export function quarterLabel(year: number, quarter: number): string {
  return `${year}년 ${quarter}분기`;
}

export function quarterKey(year: number, quarter: number): string {
  return `${year}-Q${quarter}`;
}

/** 오늘이 속한 분기보다 뒤인지 */
export function isFutureQuarter(q: YearQuarter, todayYmd: string): boolean {
  return compareQuarter(q, quarterOfYmd(todayYmd)) > 0;
}

/** 쿼리·바디의 year/quarter 검증 */
export function parseYearQuarter(rawYear: unknown, rawQuarter: unknown): YearQuarter | null {
  const year = Number(rawYear);
  const quarter = Number(rawQuarter);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) return null;
  if (!Number.isInteger(quarter) || quarter < 1 || quarter > 4) return null;
  return { year, quarter };
}

// ── 회차 상태 ──

export type CycleState = "upcoming" | "open" | "closed";

export interface CycleDates {
  submitStart: string; // YYYY-MM-DD
  submitEnd: string;
}

export function getCycleState(cycle: CycleDates, todayYmd: string): CycleState {
  if (todayYmd < cycle.submitStart) return "upcoming";
  if (todayYmd > cycle.submitEnd) return "closed";
  return "open";
}

/** 마감까지 남은 일수 (마감일 당일 0, 지나면 음수) */
export function getDDay(cycle: CycleDates, todayYmd: string): number {
  return diffDaysYmd(todayYmd, cycle.submitEnd);
}

/** "D-3" / 당일 "오늘 마감" */
export function dDayLabel(dDay: number): string {
  return dDay <= 0 ? "오늘 마감" : `D-${dDay}`;
}

/** 관리자 화면 진행 문구 — "마감 D-3" / "오늘 마감" / "마감됨" / "10월 20일 시작" */
export function cycleProgressLabel(cycle: CycleDates & { state: CycleState; dDay: number }): string {
  if (cycle.state === "upcoming") return `${formatMonthDay(cycle.submitStart)} 시작`;
  if (cycle.state === "closed") return "마감됨";
  return cycle.dDay <= 0 ? "오늘 마감" : `마감 D-${cycle.dDay}`;
}

// ── 성과표 상태 ──

export type SheetStatus = "none" | "draft" | "submitted" | "revision";

export const SHEET_STATUS_META: Record<SheetStatus, { label: string; badgeClass: string }> = {
  none: { label: "미작성", badgeClass: "bg-gray-100 text-gray-500" },
  draft: { label: "작성 중", badgeClass: "bg-amber-50 text-amber-700" },
  submitted: { label: "제출 완료", badgeClass: "bg-emerald-50 text-emerald-700" },
  revision: { label: "수정 요청됨", badgeClass: "bg-purple-50 text-purple-700" },
};

/** DB status(없으면 null) + 내용 유무 → 화면 상태. draft 인데 내용이 없으면 none. */
export function effectiveSheetStatus(dbStatus: string | null | undefined, hasContent: boolean): SheetStatus {
  if (dbStatus === "submitted" || dbStatus === "revision") return dbStatus;
  if (dbStatus === "draft" && hasContent) return "draft";
  return "none";
}

// ── 편집/제출 가능 여부 ──

export interface SheetAccess {
  canEdit: boolean;
  canSubmit: boolean;
  reason: string | null;
}

export function getSheetAccess(args: {
  year: number;
  quarter: number;
  todayYmd: string;
  /** DB status 또는 "none"/null(성과표 없음) */
  sheetStatus: string | null;
  cycle: CycleDates | null;
  isTarget: boolean;
}): SheetAccess {
  const { year, quarter, todayYmd, sheetStatus, cycle, isTarget } = args;

  if (isFutureQuarter({ year, quarter }, todayYmd)) {
    return { canEdit: false, canSubmit: false, reason: "아직 시작하지 않은 분기입니다." };
  }
  if (sheetStatus === "submitted") {
    return {
      canEdit: false,
      canSubmit: false,
      reason: "제출한 성과는 수정할 수 없습니다. 수정이 필요하면 관리자에게 요청하세요.",
    };
  }
  // 관리자가 수정 요청으로 다시 열어 준 성과 — 회차 기간과 무관
  if (sheetStatus === "revision") {
    return { canEdit: true, canSubmit: true, reason: null };
  }

  // draft / 없음
  const state = cycle ? getCycleState(cycle, todayYmd) : null;
  if (state === "closed") {
    return { canEdit: false, canSubmit: false, reason: "제출 기간이 끝났습니다." };
  }
  if (!cycle) {
    return {
      canEdit: true,
      canSubmit: false,
      reason: "아직 제출 기간이 아닙니다. 관리자가 회차를 열면 제출할 수 있습니다.",
    };
  }
  if (state === "upcoming") {
    return {
      canEdit: true,
      canSubmit: false,
      reason: `제출 기간: ${formatMonthDay(cycle.submitStart)} ~ ${formatMonthDay(cycle.submitEnd)}`,
    };
  }
  if (!isTarget) {
    return { canEdit: true, canSubmit: false, reason: "이번 회차 제출 대상이 아닙니다." };
  }
  return { canEdit: true, canSubmit: true, reason: null };
}

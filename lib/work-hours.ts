// 근무시간 집계(관리자 /work-hours 화면) 공통 계산 — 표시 전용.
// aggregator·attendance_daily.work_minutes 저장값·lunch_deduct_enabled·조퇴 판정과는 무관하다(그쪽은 바꾸지 않는다).
// 이 파일은 클라이언트에서도 쓰일 수 있으므로 서버 전용 모듈을 import 하지 않는다.

// ─────────────────────────────────────────────────────────────
// 정책 (policy_settings) — 행이 없거나 값이 이상하면 코드 기본값
// ─────────────────────────────────────────────────────────────

export const WORK_HOURS_POLICY_KEYS = [
  "work_hours_break_per_stay_minutes",
  "work_hours_break_minutes",
] as const;

export const WORK_HOURS_POLICY_DESCRIPTION =
  "근무시간 집계 화면에만 쓰임, 조퇴 판정과 무관";

export interface WorkHoursPolicy {
  /** 머문 시간 이만큼마다 휴게 공제 (분, 기본 270 = 4시간 30분) */
  breakPerStayMinutes: number;
  /** 한 번 공제할 휴게 (분, 기본 30) */
  breakMinutes: number;
}

export const DEFAULT_WORK_HOURS_POLICY: WorkHoursPolicy = {
  breakPerStayMinutes: 270,
  breakMinutes: 30,
};

// 정책 값 검증 — 기준분은 1 이상, 공제분은 0 이상 정수. 정책 화면 저장 검사와 같이 쓴다.
export function validWorkHoursPolicyValue(key: string, raw: string): boolean {
  if (!/^\d+$/.test(raw.trim())) return false;
  const n = parseInt(raw.trim(), 10);
  if (key === "work_hours_break_per_stay_minutes") return n >= 1 && n <= 24 * 60;
  if (key === "work_hours_break_minutes") return n >= 0 && n <= 24 * 60;
  return false;
}

export function parseWorkHoursPolicy(values: Map<string, string>): WorkHoursPolicy {
  const pick = (key: (typeof WORK_HOURS_POLICY_KEYS)[number], def: number) => {
    const raw = values.get(key);
    return raw !== undefined && validWorkHoursPolicyValue(key, raw) ? parseInt(raw.trim(), 10) : def;
  };
  return {
    breakPerStayMinutes: pick("work_hours_break_per_stay_minutes", DEFAULT_WORK_HOURS_POLICY.breakPerStayMinutes),
    breakMinutes: pick("work_hours_break_minutes", DEFAULT_WORK_HOURS_POLICY.breakMinutes),
  };
}

// ─────────────────────────────────────────────────────────────
// 하루 근무시간
// ─────────────────────────────────────────────────────────────

export type DayWorkResult =
  | { status: "ok"; stayMinutes: number; breakMinutes: number; workMinutes: number }
  | { status: "no_checkout" } // 퇴근 기록 없음(오늘 근무 중 포함) — 합계 제외
  | { status: "invalid" }; // 출근 없이 퇴근만 있음 / 퇴근이 출근보다 빠름 — 합계 제외

// 분 단위 절삭 — 화면 표시(HH:MM)와 같은 기준 (lib/attendance-correction floorMinute 와 같음)
function floorMinuteMs(d: Date): number {
  return Math.floor(d.getTime() / 60000) * 60000;
}

/**
 * 하루 근무시간 = 머문 시간 − 휴게 공제.
 *  - 머문 시간 = 퇴근 − 출근 (분 절삭한 두 시각의 차, 분)
 *  - 휴게 공제 = floor(머문 시간 / 기준분) × 공제분 (기본 270분마다 30분)
 *    근로기준법 제54조(근로시간 4시간마다 휴게 30분 이상)를 "회사에 머문 시간" 기준으로 환산한 식이다.
 *    머문 4시간 30분 = 근로 4시간 + 휴게 30분 이므로, 머문 시간 270분마다 30분을 뺀다.
 *    예) 3:00→공제 0, 5:00→30분(4:30), 9:00→60분(8:00), 13:00→60분(12:00), 13:30→90분(12:00)
 */
export function computeDayWorkMinutes(
  checkIn: Date | null,
  checkOut: Date | null,
  policy: WorkHoursPolicy = DEFAULT_WORK_HOURS_POLICY
): DayWorkResult {
  if (!checkIn && !checkOut) return { status: "invalid" };
  if (!checkOut) return { status: "no_checkout" };
  if (!checkIn) return { status: "invalid" };
  const stayMinutes = Math.floor((floorMinuteMs(checkOut) - floorMinuteMs(checkIn)) / 60000);
  if (stayMinutes < 0) return { status: "invalid" };
  const breakMinutes =
    Math.floor(stayMinutes / policy.breakPerStayMinutes) * policy.breakMinutes;
  return {
    status: "ok",
    stayMinutes,
    breakMinutes,
    workMinutes: Math.max(0, stayMinutes - breakMinutes),
  };
}

// ─────────────────────────────────────────────────────────────
// 표시 형식
// ─────────────────────────────────────────────────────────────

/** 분 → "40:30" (시:분) */
export function formatHM(minutes: number): string {
  const sign = minutes < 0 ? "-" : "";
  const m = Math.abs(minutes);
  return `${sign}${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;
}

/** 분 → "4시간 30분" / "4시간" / "30분" (기준 문장용) */
export function formatKoreanDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h && m) return `${h}시간 ${m}분`;
  if (h) return `${h}시간`;
  return `${m}분`;
}

/** 화면 상단 기준 문장 — 정책값이 바뀌면 숫자도 따라 바뀐다 */
export function workHoursRuleSentence(policy: WorkHoursPolicy): string {
  return (
    "근무시간 = WiFi 첫 연결 ~ 마지막 연결 (승인된 근태 정정이 있으면 정정 시각) − 휴게시간" +
    `(머문 시간 ${formatKoreanDuration(policy.breakPerStayMinutes)}마다 ${formatKoreanDuration(policy.breakMinutes)}, 정책값 반영)` +
    " / 주 기준 월~일 / 퇴근 기록 없는 날은 합계 제외"
  );
}

/** Date → KST "HH:MM" */
export function formatKstHHMM(d: Date): string {
  const k = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  return `${String(k.getUTCHours()).padStart(2, "0")}:${String(k.getUTCMinutes()).padStart(2, "0")}`;
}

/** Date → KST "YYYY-MM-DD" */
export function kstYmd(d: Date): string {
  return new Date(d.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

// ─────────────────────────────────────────────────────────────
// 날짜·주 (YYYY-MM-DD 문자열, UTC 자정 기준 계산 — 시간대 영향 없음)
// ─────────────────────────────────────────────────────────────

export const WEEKDAY_LABELS = ["일", "월", "화", "수", "목", "금", "토"] as const;

/** "YYYY-MM-DD" 가 실제 있는 날짜인지 */
export function parseYmd(s: string | null | undefined): string | null {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(s + "T00:00:00.000Z");
  if (isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) return null;
  return s;
}

/** "YYYY-MM" 형식 검증 */
export function parseYm(s: string | null | undefined): string | null {
  if (!s || !/^\d{4}-(0[1-9]|1[0-2])$/.test(s)) return null;
  return s;
}

export function addDays(ymd: string, n: number): string {
  const d = new Date(ymd + "T00:00:00.000Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** 0=일 … 6=토 */
export function dayOfWeek(ymd: string): number {
  return new Date(ymd + "T00:00:00.000Z").getUTCDay();
}

/** 그 날짜가 속한 주의 월요일 */
export function mondayOf(ymd: string): string {
  return addDays(ymd, -((dayOfWeek(ymd) + 6) % 7));
}

/** 그 날짜가 속한 월~일 주 */
export function weekRange(ymd: string): { start: string; end: string } {
  const start = mondayOf(ymd);
  return { start, end: addDays(start, 6) };
}

export function monthRange(ym: string): { start: string; end: string } {
  const [y, m] = ym.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { start: `${ym}-01`, end: `${ym}-${String(last).padStart(2, "0")}` };
}

export function addMonths(ym: string, n: number): string {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}

/** start~end (포함) 날짜 목록 */
export function daysInRange(start: string, end: string): string[] {
  const out: string[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) out.push(d);
  return out;
}

/** "2026-11-02" → "11/2" */
export function shortMd(ymd: string): string {
  return `${Number(ymd.slice(5, 7))}/${Number(ymd.slice(8, 10))}`;
}

export interface MonthWeek {
  /** 1부터 */
  index: number;
  /** 그 달에 속한 날짜만 (월~일 주를 달 경계로 자른 범위) */
  start: string;
  end: string;
}

/** 월을 월~일 주로 나눈다. 주 칸에는 그 달에 속한 날짜만 들어간다. */
export function monthWeeks(ym: string): MonthWeek[] {
  const { start, end } = monthRange(ym);
  const weeks: MonthWeek[] = [];
  let cur = start;
  while (cur <= end) {
    const sunday = addDays(mondayOf(cur), 6);
    const wEnd = sunday < end ? sunday : end;
    weeks.push({ index: weeks.length + 1, start: cur, end: wEnd });
    cur = addDays(wEnd, 1);
  }
  return weeks;
}

// ─────────────────────────────────────────────────────────────
// 조회 권한 (화면 서버 코드가 세션으로 플래그를 구해 넘긴다 — lib/auth-helpers 규칙 그대로)
//   canViewAll = canViewAllEmployees(session)  (CEO, 부서 없는 관리자)
//   부서 있는 관리자 → 본인 부서만 (app/api/attendance/overview 와 같은 강제)
// ─────────────────────────────────────────────────────────────

export interface WorkHoursViewer {
  isAdmin: boolean; // isAdminSession (admin·ceo)
  canViewAll: boolean;
  ownDepartmentId: number | null;
}

export type WorkHoursScopeDecision =
  | { ok: true; departmentFilter: number | null }
  | { ok: false; status: 403; message: string };

/**
 * 조회 범위 결정.
 *  - 관리자 아님 → 403
 *  - 전체 권한 → 요청 부서(있으면) 또는 전체
 *  - 부서 관리자 → 본인 부서 강제. 다른 부서를 요청했거나, 요청 직원이 다른 부서면 403
 * requestedEmployeeDeptId: employee 를 지정했을 때 그 직원의 부서(undefined = 지정 안 함)
 */
export function decideWorkHoursScope(
  viewer: WorkHoursViewer,
  requestedDepartmentId: number | null,
  requestedEmployeeDeptId?: number | null
): WorkHoursScopeDecision {
  if (!viewer.isAdmin) {
    return { ok: false, status: 403, message: "관리자 권한이 필요합니다." };
  }
  if (viewer.canViewAll) {
    return { ok: true, departmentFilter: requestedDepartmentId };
  }
  const own = viewer.ownDepartmentId;
  if (own == null) {
    return { ok: false, status: 403, message: "조회 가능한 부서가 없습니다." };
  }
  if (requestedDepartmentId !== null && requestedDepartmentId !== own) {
    return { ok: false, status: 403, message: "다른 부서는 조회할 수 없습니다." };
  }
  if (requestedEmployeeDeptId !== undefined && requestedEmployeeDeptId !== own) {
    return { ok: false, status: 403, message: "해당 직원 조회 권한이 없습니다." };
  }
  return { ok: true, departmentFilter: own };
}

// ─────────────────────────────────────────────────────────────
// 하루치 요약 — attendance_daily 한 행에서 시각·출처·비고를 고른다
//
// 시각 선택 규칙 (조사 결과, 2026-11):
//  - 승인된 근태 정정만 attendance_daily 를 바꾼다(lib/finalize-approval → applyCorrectionToDaily).
//    그때 is_overridden=true, override_source='manual' 이 되고, 정정한 쪽의 WiFi 원래 시각이
//    original_check_in/out 에 백업된다. 승인 전·반려 정정은 행을 건드리지 않고, 취소되면 되돌린다.
//  - 출장·외근·휴가 반영(override_source='calendar')은 구분·상태만 바꾸고 check_in/out 은 WiFi 값 그대로.
//  → 따라서 check_in/check_out 이 곧 "승인된 정정이 있으면 정정 시각, 없으면 WiFi 시각"이다.
//    신청의 시간대(corrected_check_in/out)는 근무시간으로 치지 않는다.
// ─────────────────────────────────────────────────────────────

export interface DailyRecordInput {
  workDate: string; // YYYY-MM-DD (attendance_daily.work_date 귀속)
  checkIn: Date | null;
  checkOut: Date | null;
  originalCheckIn: Date | null;
  originalCheckOut: Date | null;
  isOverridden: boolean;
  overrideSource: string | null;
  autoStatus: string | null;
  categoryName: string | null;
  categoryType: string | null;
}

export type TimeSource = "WiFi" | "정정" | "정정(출근)" | "정정(퇴근)" | "-";

export interface DaySummary {
  /** 합계에 더할 분 (퇴근 없음·기록 오류·기록 없음은 0) */
  countedMinutes: number;
  /** 출퇴근 기록이 하나도 없으면 null */
  result: DayWorkResult | null;
  source: TimeSource;
  /** 비고 (출장·휴가 등 구분명, 퇴근 없음, 기록 오류, 결근, 기록 없음) */
  notes: string[];
}

export function timeSourceOf(r: DailyRecordInput): TimeSource {
  if (!r.checkIn && !r.checkOut) return "-";
  if (r.isOverridden && r.overrideSource === "manual") {
    const inFixed = r.originalCheckIn !== null;
    const outFixed = r.originalCheckOut !== null;
    if (inFixed && !outFixed) return "정정(출근)";
    if (outFixed && !inFixed) return "정정(퇴근)";
    return "정정";
  }
  return "WiFi";
}

export function summarizeDay(r: DailyRecordInput | null, policy: WorkHoursPolicy): DaySummary {
  if (!r) return { countedMinutes: 0, result: null, source: "-", notes: [] };
  const notes: string[] = [];
  if (r.categoryName && r.categoryType !== "correction") notes.push(r.categoryName);

  if (!r.checkIn && !r.checkOut) {
    if (notes.length === 0) notes.push(r.autoStatus === "absent" ? "결근" : "기록 없음");
    return { countedMinutes: 0, result: null, source: "-", notes };
  }
  const result = computeDayWorkMinutes(r.checkIn, r.checkOut, policy);
  if (result.status === "no_checkout") notes.push("퇴근 없음");
  if (result.status === "invalid") notes.push("기록 오류");
  return {
    countedMinutes: result.status === "ok" ? result.workMinutes : 0,
    result,
    source: timeSourceOf(r),
    notes,
  };
}

export interface PeriodTotal {
  minutes: number;
  noCheckoutDays: number;
  invalidDays: number;
}

export function sumDays(days: DaySummary[]): PeriodTotal {
  const t: PeriodTotal = { minutes: 0, noCheckoutDays: 0, invalidDays: 0 };
  for (const d of days) {
    t.minutes += d.countedMinutes;
    if (d.result?.status === "no_checkout") t.noCheckoutDays++;
    if (d.result?.status === "invalid") t.invalidDays++;
  }
  return t;
}

/** 합계 칸 글자: "40:30" + 제외한 날 표시 */
export function formatPeriodTotal(t: PeriodTotal): string {
  const extra: string[] = [];
  if (t.noCheckoutDays) extra.push(`퇴근 없음 ${t.noCheckoutDays}일 제외`);
  if (t.invalidDays) extra.push(`기록 오류 ${t.invalidDays}일 제외`);
  return extra.length ? `${formatHM(t.minutes)} (${extra.join(", ")})` : formatHM(t.minutes);
}

/** 주별 보기 하루 칸 글자 */
export function formatDayCell(d: DaySummary): string {
  const label = d.notes.filter((n) => n !== "퇴근 없음" && n !== "기록 오류").join("·");
  if (!d.result) return label ? `0:00 ${label}` : "-";
  if (d.result.status === "no_checkout") return label ? `퇴근 없음 ${label}` : "퇴근 없음";
  if (d.result.status === "invalid") return label ? `기록 오류 ${label}` : "기록 오류";
  return label ? `${formatHM(d.result.workMinutes)} ${label}` : formatHM(d.result.workMinutes);
}

/** 시각 표시 — KST HH:MM, 근무일과 날짜가 다르면 (+1)/(-1) */
export function formatTimeOnWorkDate(t: Date | null, workDate: string): string {
  if (!t) return "-";
  const ymd = kstYmd(t);
  const diff = Math.round(
    (new Date(ymd + "T00:00:00.000Z").getTime() - new Date(workDate + "T00:00:00.000Z").getTime()) /
      86400000
  );
  const hm = formatKstHHMM(t);
  return diff === 0 ? hm : `${hm}(${diff > 0 ? "+" : ""}${diff})`;
}

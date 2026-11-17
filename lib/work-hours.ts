// 전체 근무시간 조회(관리자 메뉴 "work-hours") 순수 계산 — 클라이언트 전용, 서버 모듈 import 금지.
// aggregator·attendance_daily.work_minutes 저장값·조퇴 판정과는 무관하다(그쪽은 바꾸지 않는다).
// 표시 형식은 lib/attendanceLabels(formatWorkMinutes 등)·lib/dateUtils 를 그대로 쓴다.
//
// 근무시간 규칙
//  - 하루 = 퇴근 − 출근 (분 절삭한 두 시각의 차). 휴게(점심) 시간은 빼지 않는다. 자정 넘긴 퇴근도 그대로.
//  - 시각은 attendance_daily check_in/out — 승인된 근태 정정이 있으면 정정 시각, 없으면 WiFi 시각
//    (승인 정정만 이 값을 바꾼다: lib/finalize-approval → applyCorrectionToDaily).
//  - 퇴근 없음(오늘 근무 중 포함)·기록 오류(출근 없이 퇴근, 퇴근 < 출근)는 합계에서 뺀다.
//  - 주는 월~일. 월별 보기의 주 칸에는 그 달 날짜만 더한다.
import { formatWorkMinutes } from "@/lib/attendanceLabels";

// ─────────────────────────────────────────────────────────────
// 하루 근무시간
// ─────────────────────────────────────────────────────────────

export type DayWorkResult =
  | { status: "ok"; workMinutes: number }
  | { status: "no_checkout" } // 퇴근 기록 없음 — 합계 제외
  | { status: "invalid" }; // 출근 없이 퇴근만 있음 / 퇴근이 출근보다 빠름 — 합계 제외

type TimeValue = string | Date | null;

function floorMinuteMs(t: string | Date): number {
  const ms = typeof t === "string" ? Date.parse(t) : t.getTime();
  return Math.floor(ms / 60000) * 60000;
}

/** 하루 근무시간(분). 출퇴근 둘 다 없으면 invalid. */
export function computeDayWorkMinutes(checkIn: TimeValue, checkOut: TimeValue): DayWorkResult {
  if (!checkIn && !checkOut) return { status: "invalid" };
  if (!checkOut) return { status: "no_checkout" };
  if (!checkIn) return { status: "invalid" };
  const workMinutes = Math.floor((floorMinuteMs(checkOut) - floorMinuteMs(checkIn)) / 60000);
  if (!Number.isFinite(workMinutes) || workMinutes < 0) return { status: "invalid" };
  return { status: "ok", workMinutes };
}

// ─────────────────────────────────────────────────────────────
// 날짜·주 (YYYY-MM-DD 문자열, UTC 자정 기준 계산 — 시간대 영향 없음)
// ─────────────────────────────────────────────────────────────

/** "YYYY-MM-DD" 가 실제 있는 날짜면 그대로, 아니면 null */
export function parseYmd(s: string | null | undefined): string | null {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(s + "T00:00:00.000Z");
  if (isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) return null;
  return s;
}

/** "YYYY-MM" 형식이면 그대로, 아니면 null */
export function parseYm(s: string | null | undefined): string | null {
  if (!s || !/^\d{4}-(0[1-9]|1[0-2])$/.test(s)) return null;
  return s;
}

export function addDays(ymd: string, n: number): string {
  const d = new Date(ymd + "T00:00:00.000Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function addMonths(ym: string, n: number): string {
  const [y, m] = ym.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7);
}

/** 그 날짜가 속한 주의 월요일 */
export function mondayOf(ymd: string): string {
  const dow = new Date(ymd + "T00:00:00.000Z").getUTCDay(); // 0=일
  return addDays(ymd, -((dow + 6) % 7));
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

/** "2026-11-16" → "월" */
export function weekdayKo(ymd: string): string {
  return new Date(ymd + "T00:00:00.000Z").toLocaleDateString("ko-KR", {
    weekday: "short",
    timeZone: "UTC",
  });
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
// 하루 요약·합계
// ─────────────────────────────────────────────────────────────

/** GET /api/attendance/work-hours 의 rows 한 줄 (lib/attendance-rows AttendanceRow 의 일부) */
export interface WorkHoursDayRow {
  employeeId: number;
  workDate: string; // YYYY-MM-DD
  checkIn: string | null;
  checkOut: string | null;
  originalCheckIn: string | null;
  originalCheckOut: string | null;
  autoStatus: string | null;
  categoryName: string | null;
  categoryType: string | null;
}

export interface DaySummary {
  /** 합계에 더할 분 (퇴근 없음·기록 오류·기록 없음은 0) */
  countedMinutes: number;
  /** 출퇴근 기록이 하나도 없으면 null */
  result: DayWorkResult | null;
  /** 사유 글자 (출장·휴가 등 구분명, 퇴근 없음, 기록 오류, 결근) — 없으면 빈 배열 */
  notes: string[];
}

export function summarizeDay(r: WorkHoursDayRow | null | undefined): DaySummary {
  if (!r) return { countedMinutes: 0, result: null, notes: [] };
  const notes: string[] = [];
  // 근태정정은 구분명 대신 출퇴근 칸의 정정 표시로 보여준다
  if (r.categoryName && r.categoryType !== "correction") notes.push(r.categoryName);

  if (!r.checkIn && !r.checkOut) {
    if (notes.length === 0 && r.autoStatus === "absent") notes.push("결근");
    return { countedMinutes: 0, result: null, notes };
  }
  const result = computeDayWorkMinutes(r.checkIn, r.checkOut);
  if (result.status === "no_checkout") notes.push("퇴근 없음");
  if (result.status === "invalid") notes.push("기록 오류");
  return {
    countedMinutes: result.status === "ok" ? result.workMinutes : 0,
    result,
    notes,
  };
}

/** 근무 칸 글자 — "8시간 30분", "0분 출장 및 외근", "퇴근 없음", 기록 자체가 없으면 "-" */
export function dayCellText(d: DaySummary): string {
  const reason = d.notes.filter((n) => n !== "퇴근 없음" && n !== "기록 오류").join(", ");
  if (!d.result) return reason ? `${formatWorkMinutes(0)} ${reason}` : "-";
  if (d.result.status === "no_checkout") return reason ? `퇴근 없음 ${reason}` : "퇴근 없음";
  if (d.result.status === "invalid") return reason ? `기록 오류 ${reason}` : "기록 오류";
  const t = formatWorkMinutes(d.result.workMinutes);
  return reason ? `${t} ${reason}` : t;
}

/** 일별 상세의 근무 칸 — 시간만 (퇴근 없음·기록 오류·기록 없음은 "-") */
export function dayMinutesText(d: DaySummary): string {
  return d.result?.status === "ok" ? formatWorkMinutes(d.result.workMinutes) : "-";
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

/** 합계에서 뺀 날 글자 — "(퇴근 없음 1일 제외)", 없으면 "" */
export function periodExcludedText(t: PeriodTotal): string {
  const extra: string[] = [];
  if (t.noCheckoutDays) extra.push(`퇴근 없음 ${t.noCheckoutDays}일 제외`);
  if (t.invalidDays) extra.push(`기록 오류 ${t.invalidDays}일 제외`);
  return extra.length ? `(${extra.join(", ")})` : "";
}

/** 합계 칸 글자 — "176시간 30분" + 제외한 날 "(퇴근 없음 1일 제외)" */
export function periodTotalText(t: PeriodTotal): string {
  const excluded = periodExcludedText(t);
  const base = formatWorkMinutes(t.minutes);
  return excluded ? `${base} ${excluded}` : base;
}

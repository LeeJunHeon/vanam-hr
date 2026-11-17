// 전체 근무시간 조회(관리자 메뉴 "work-hours") 순수 계산 — 클라이언트 전용, 서버 모듈 import 금지.
// aggregator·attendance_daily.work_minutes 저장값·조퇴 판정과는 무관하다(그쪽은 바꾸지 않는다).
// 표시 형식은 lib/attendanceLabels(formatWorkMinutes 등)·lib/dateUtils 를 그대로 쓴다.
//
// 근무시간 규칙
//  - 하루 = 퇴근 − 출근 (분 절삭한 두 시각의 차). 휴게(점심) 시간은 빼지 않는다. 자정 넘긴 퇴근도 그대로.
//  - 시각은 attendance_daily check_in/out — 승인된 근태 정정이 있으면 정정 시각, 없으면 WiFi 시각
//    (승인 정정만 이 값을 바꾼다: lib/finalize-approval → applyCorrectionToDaily).
//  - 지난 날짜의 퇴근 없음·기록 오류(출근 없이 퇴근, 퇴근 < 출근)는 합계에서 빼고 비고에 날짜를 적는다.
//  - 오늘 근무일(work_date_cutoff_hour 기준)에 퇴근 전이면 "근무중" — 합계·제외 집계 모두 넣지 않는다.
//  - 오늘 이후 날짜는 "-" — 합계 대상 아님.
//  - 주는 월~일. 월별 보기의 주 칸에는 그 달 날짜만 더한다.
import { formatWorkMinutes, PROGRESS_WORKING } from "@/lib/attendanceLabels";

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
// 하루 요약·합계 (표시 상태 — 위 계산 규칙은 그대로 쓰고, 오늘·미래만 따로 표시)
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

/**
 * 하루 표시 상태
 *  - ok / no_checkout / invalid: computeDayWorkMinutes 결과 (no_checkout·invalid 는 지난 날짜만 — 합계 제외 대상)
 *  - working: 오늘 근무일, 출근만 있고 퇴근 전 — 합계에도 제외 집계에도 넣지 않는다
 *  - future: 오늘 이후 — 합계 대상 아님, 칸은 "-"
 *  - none: 출퇴근 기록 없음
 */
export type DayState = "ok" | "no_checkout" | "invalid" | "working" | "future" | "none";

export interface DaySummary {
  ymd: string;
  state: DayState;
  /** 합계에 더할 분 (ok 만) */
  countedMinutes: number;
  /** 사유 글자 (출장·휴가 등 구분명, 퇴근 없음, 기록 오류, 결근) — 없으면 빈 배열 */
  notes: string[];
}

/** 근무 중 라벨 — 근태 화면과 같은 PROGRESS_WORKING.label */
export const WORKING_LABEL: string = PROGRESS_WORKING.label;

/**
 * 하루 요약. today = 오늘 근무일(work_date_cutoff_hour 기준, API 응답 today).
 * 근태정정은 구분명 대신 출퇴근 칸의 정정 표시로 보여준다.
 */
export function summarizeDay(
  ymd: string,
  r: WorkHoursDayRow | null | undefined,
  today: string
): DaySummary {
  const notes: string[] = [];
  if (r?.categoryName && r.categoryType !== "correction") notes.push(r.categoryName);

  if (ymd > today) return { ymd, state: "future", countedMinutes: 0, notes };
  if (!r || (!r.checkIn && !r.checkOut)) {
    if (notes.length === 0 && r?.autoStatus === "absent" && ymd < today) notes.push("결근");
    return { ymd, state: "none", countedMinutes: 0, notes };
  }
  const result = computeDayWorkMinutes(r.checkIn, r.checkOut);
  if (result.status === "ok") return { ymd, state: "ok", countedMinutes: result.workMinutes, notes };
  if (result.status === "no_checkout") {
    if (ymd === today) return { ymd, state: "working", countedMinutes: 0, notes };
    return { ymd, state: "no_checkout", countedMinutes: 0, notes: [...notes, "퇴근 없음"] };
  }
  return { ymd, state: "invalid", countedMinutes: 0, notes: [...notes, "기록 오류"] };
}

/** 하루 칸 글자 — "8시간 30분", "근무중", "-"(미래·기록 없음), "0분 출장 및 외근", "퇴근 없음" */
export function dayCellText(d: DaySummary): string {
  const reason = d.notes.filter((n) => n !== "퇴근 없음" && n !== "기록 오류").join(", ");
  switch (d.state) {
    case "future":
      return "-";
    case "working":
      return WORKING_LABEL;
    case "none":
      return reason ? `${formatWorkMinutes(0)} ${reason}` : "-";
    case "no_checkout":
      return reason ? `퇴근 없음 ${reason}` : "퇴근 없음";
    case "invalid":
      return reason ? `기록 오류 ${reason}` : "기록 오류";
    case "ok": {
      const t = formatWorkMinutes(d.countedMinutes);
      return reason ? `${t} ${reason}` : t;
    }
  }
}

/** 일별 상세의 근무 칸 — 시간만 ("근무중", 그 밖에 시간이 없으면 "-") */
export function dayMinutesText(d: DaySummary): string {
  if (d.state === "ok") return formatWorkMinutes(d.countedMinutes);
  if (d.state === "working") return WORKING_LABEL;
  return "-";
}

export interface PeriodTotal {
  minutes: number;
  /** 합계에서 뺀 지난 날짜 */
  noCheckoutDates: string[];
  invalidDates: string[];
  /** 기간 전체가 오늘 이후 */
  allFuture: boolean;
}

export function sumDays(days: DaySummary[]): PeriodTotal {
  const t: PeriodTotal = { minutes: 0, noCheckoutDates: [], invalidDates: [], allFuture: days.length > 0 };
  for (const d of days) {
    t.minutes += d.countedMinutes;
    if (d.state === "no_checkout") t.noCheckoutDates.push(d.ymd);
    if (d.state === "invalid") t.invalidDates.push(d.ymd);
    if (d.state !== "future") t.allFuture = false;
  }
  return t;
}

/** 합계 칸 글자 — "176시간 30분", 기간 전체가 미래면 "-" */
export function periodMinutesText(t: PeriodTotal): string {
  return t.allFuture ? "-" : formatWorkMinutes(t.minutes);
}

function excludedPart(label: string, dates: string[]): string {
  if (dates.length === 0) return "";
  if (dates.length === 1) return `${label} ${shortMd(dates[0])} 제외`;
  return `${label} ${dates.length}일(${dates.map(shortMd).join(", ")}) 제외`;
}

/** 비고 칸 — "퇴근 없음 11/12 제외", "퇴근 없음 2일(11/12, 11/14) 제외", 없으면 "" */
export function periodRemarkText(t: PeriodTotal): string {
  return [excludedPart("퇴근 없음", t.noCheckoutDates), excludedPart("기록 오류", t.invalidDates)]
    .filter(Boolean)
    .join(", ");
}

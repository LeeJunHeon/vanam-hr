import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/app/generated/prisma/client";
import { resolveShiftPoint, isWorkPoint } from "@/lib/shift-schedule";
import { LIVE_REQUEST_STATUSES } from "@/lib/attendance-live-requests";

export interface AnnualLeavePolicyValues {
  baseDays: number;
  incrementStartYear: number;
  incrementCycleYears: number;
  incrementDays: number;
  maxDays: number;
  firstYearMonthly: boolean;
  firstYearMax: number;
  monthlyBasis: string; // 'month' | 'hire_day'
  grantBasis: string;       // 'fiscal_year' | 'hire_date'
  firstYearFixedDays: number;
}

// from~to(YYYY-MM-DD, inclusive)의 hr.holidays를 'YYYY-MM-DD' Set으로 반환.
export async function getHolidaySet(fromYmd: string, toYmd: string): Promise<Set<string>> {
  const rows = await prisma.holiday.findMany({
    where: {
      holidayDate: {
        gte: new Date(`${fromYmd}T00:00:00.000Z`),
        lte: new Date(`${toYmd}T00:00:00.000Z`),
      },
    },
    select: { holidayDate: true },
  });
  return new Set(rows.map((h) => h.holidayDate.toISOString().split("T")[0]));
}

// 시프트를 보지 않는 달력 기준 근무일. 연차 차감에는 countWorkDays 를 쓸 것.
// [start, end] inclusive에서 토(6)·일(0)·공휴일을 제외한 근무일 수.
export function countBusinessDays(start: Date, end: Date, holidays: Set<string>): number {
  let count = 0;
  const cur = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
  const last = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate()));
  while (cur <= last) {
    const dow = cur.getUTCDay(); // 0=일, 6=토
    const ymd = cur.toISOString().split("T")[0];
    if (dow !== 0 && dow !== 6 && !holidays.has(ymd)) count++;
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return count;
}

// 연차 "사용"으로 인정하는 요청 조건 — 모든 연차 집계가 이것 하나를 쓴다.
// HR 신청만 차감(calendar_auto 제외, 2026-09 방침).
function usedLeaveRequestWhere(employeeId: number): Prisma.AttendanceRequestWhereInput {
  return {
    employeeId,
    status: { in: LIVE_REQUEST_STATUSES },
    category: { annualLeaveDeduct: { gt: 0 } },
    requestType: { not: "calendar_auto" },
  };
}

// 연차 "결재 대기" — 사용과 같은 조건인데 status 'pending'. 신청 가능 일수에서 미리 뺀다.
function pendingLeaveRequestWhere(employeeId: number): Prisma.AttendanceRequestWhereInput {
  return {
    ...usedLeaveRequestWhere(employeeId),
    status: "pending",
  };
}

type ShiftAssignmentRow = {
  employee_id: number;
  start_date: Date;
  end_date: Date | null;
  cycle_days: number;
  schedule: unknown;
};

// 연차는 본인이 원래 일하는 날만 센다 (2026-09 방침).
// 근무일 = 그 날을 덮는 시프트 배정상 근무(isWorkPoint) AND 공휴일 아님.
// 그 날을 덮는 배정이 없으면 기존 규칙(토·일 제외, 공휴일 제외) — 시프트 미배정 직원 동작 유지.
export async function loadWorkDayChecker(
  employeeIds: number[],
  fromYmd: string,
  toYmd: string
): Promise<(employeeId: number, day: Date) => boolean> {
  const holidays = await getHolidaySet(fromYmd, toYmd);

  const byEmployee = new Map<number, ShiftAssignmentRow[]>();
  if (employeeIds.length > 0) {
    // loadShiftAndGrace 와 같은 조건(pattern is_active) + 기간 겹침. start_date DESC 라
    // 날짜별로 첫 매칭 행을 고르면 LIMIT 1 과 같은 선택이 된다.
    const rows = await prisma.$queryRaw<ShiftAssignmentRow[]>`
      SELECT es.employee_id, es.start_date, es.end_date, sp.cycle_days, sp.schedule
      FROM hr.employee_shifts es
      JOIN hr.shift_patterns sp ON sp.id = es.pattern_id
      WHERE es.employee_id = ANY(${employeeIds}::int[])
        AND es.start_date <= ${toYmd}::date
        AND (es.end_date IS NULL OR es.end_date >= ${fromYmd}::date)
        AND sp.is_active = true
      ORDER BY es.start_date DESC
    `;
    for (const r of rows) {
      const list = byEmployee.get(r.employee_id);
      if (list) list.push(r);
      else byEmployee.set(r.employee_id, [r]);
    }
  }

  return (employeeId: number, day: Date): boolean => {
    const d = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()));
    const ymd = d.toISOString().split("T")[0];
    if (holidays.has(ymd)) return false;
    const row = byEmployee
      .get(employeeId)
      ?.find((r) => r.start_date <= d && (r.end_date == null || r.end_date >= d));
    if (row) {
      return isWorkPoint(resolveShiftPoint(row.start_date, row.cycle_days, row.schedule, d));
    }
    const dow = d.getUTCDay(); // 0=일, 6=토
    return dow !== 0 && dow !== 6;
  };
}

// [start, end] inclusive 중 근무일 수.
export function countWorkDays(
  isWorkDay: (employeeId: number, day: Date) => boolean,
  employeeId: number,
  start: Date,
  end: Date
): number {
  let count = 0;
  const cur = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
  const last = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate()));
  while (cur <= last) {
    if (isWorkDay(employeeId, cur)) count++;
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return count;
}

// [from, toExclusive) 기간과 겹치는 요청(where)의, 기간 안 근무일 × 차감계수 합.
// 기간 밖 날짜는 세지 않는다(연도를 넘는 신청은 날짜별로 해당 연도에서 차감).
async function sumLeaveDaysInPeriod(
  where: Prisma.AttendanceRequestWhereInput,
  employeeId: number,
  from: Date,
  toExclusive: Date,
  excludeRequestId?: number
): Promise<number> {
  const reqs = await prisma.attendanceRequest.findMany({
    where: {
      ...where,
      startDate: { lt: toExclusive },
      endDate: { gte: from },
      ...(excludeRequestId !== undefined ? { id: { not: excludeRequestId } } : {}),
    },
    select: {
      startDate: true,
      endDate: true,
      category: { select: { annualLeaveDeduct: true } },
    },
  });
  if (reqs.length === 0) return 0;
  const lastDay = new Date(toExclusive.getTime() - 86400000);
  const isWorkDay = await loadWorkDayChecker(
    [employeeId],
    from.toISOString().split("T")[0],
    lastDay.toISOString().split("T")[0]
  );
  let total = 0;
  for (const r of reqs) {
    const deduct = r.category.annualLeaveDeduct ? Number(r.category.annualLeaveDeduct) : 0;
    if (deduct <= 0) continue;
    const s = r.startDate > from ? r.startDate : from;
    const e = r.endDate < lastDay ? r.endDate : lastDay;
    if (s > e) continue;
    total += countWorkDays(isWorkDay, employeeId, s, e) * deduct;
  }
  return total;
}

// [from, toExclusive) 기간과 겹치는 연차 사용의, 기간 안 근무일 × 차감계수 합.
// 연차 관리와 같은 요청 필터·같은 근무일 판정을 쓴다.
export async function computeLeaveDaysInPeriod(
  employeeId: number,
  from: Date,
  toExclusive: Date
): Promise<number> {
  return sumLeaveDaysInPeriod(usedLeaveRequestWhere(employeeId), employeeId, from, toExclusive);
}

function yearRange(year: number): { from: Date; toExclusive: Date } {
  return {
    from: new Date(Date.UTC(year, 0, 1)),
    toExclusive: new Date(Date.UTC(year + 1, 0, 1)),
  };
}

// targetYear의 부여량 계산.
// - grant_basis='fiscal_year': 기준일 = targetYear-01-01. 그 시점 만 근속으로 계산(매년 1/1 초기화).
// - grant_basis='hire_date': 기준일 = asOf(오늘). 기존 로직.
// - 1년 미만: firstYearMonthly면 월차(min(경과개월, firstYearMax)),
//   아니면 firstYearFixedDays>0이면 고정일수, 둘 다 아니면 0.
// - 1년 이상: 연차 공식(만 근속연수 기준).
export function computeGrantedDays(
  hiredAt: Date,
  targetYear: number,
  asOf: Date,
  policy: AnnualLeavePolicyValues
): number {
  // 기준일 결정: 회계연도면 targetYear-01-01, 입사일 기준이면 오늘(asOf).
  const basisDate =
    policy.grantBasis === "hire_date"
      ? asOf
      : new Date(Date.UTC(targetYear, 0, 1)); // 1월 1일

  const hy = hiredAt.getUTCFullYear();
  const hm = hiredAt.getUTCMonth(); // 0-based
  const hd = hiredAt.getUTCDate();
  const by = basisDate.getUTCFullYear();
  const bm = basisDate.getUTCMonth();
  const bd = basisDate.getUTCDate();

  // 경과 개월 (기준일 - 입사일)
  let monthsElapsed = (by - hy) * 12 + (bm - hm);
  // 일자 보정: 기준일의 '일'이 입사일의 '일'보다 빠르면 아직 그 달 안 채움 → 1개월 차감.
  // (fiscal_year든 hire_date든 동일하게 만 개월 계산)
  if (bd < hd) monthsElapsed -= 1;
  if (monthsElapsed < 0) monthsElapsed = 0;

  if (monthsElapsed < 12) {
    // 1년 미만 처리
    if (policy.firstYearMonthly) {
      // 월차: 경과 개월수(최대 firstYearMax)
      return Math.min(monthsElapsed, policy.firstYearMax);
    }
    if (policy.firstYearFixedDays > 0) {
      // 고정 일수 (예: 신입 첫해 12일)
      return policy.firstYearFixedDays;
    }
    return 0;
  }

  // 1년 이상 → 연차 공식 (만 근속연수 기준)
  const years = Math.floor(monthsElapsed / 12);
  if (years < policy.incrementStartYear) {
    return policy.baseDays;
  }
  const cycles =
    Math.floor((years - policy.incrementStartYear) / policy.incrementCycleYears) + 1;
  return Math.min(policy.baseDays + cycles * policy.incrementDays, policy.maxDays);
}

// 해당 연도(역년) 시스템 사용 연차 합계 — 그 연도 안의 날짜만 센다.
export async function computeSystemUsedDays(
  employeeId: number,
  year: number
): Promise<number> {
  const { from, toExclusive } = yearRange(year);
  return computeLeaveDaysInPeriod(employeeId, from, toExclusive);
}

// 해당 연도(역년) 결재 대기 연차 합계 — 그 연도 안의 날짜만. excludeRequestId 는 빼고 센다.
export async function computePendingLeaveDays(
  employeeId: number,
  year: number,
  excludeRequestId?: number
): Promise<number> {
  const { from, toExclusive } = yearRange(year);
  return sumLeaveDaysInPeriod(
    pendingLeaveRequestWhere(employeeId),
    employeeId,
    from,
    toExclusive,
    excludeRequestId
  );
}

// 특정 직원·연도의 연차 부여값 계산 (grant 행 우선, 없으면 정책 자동계산).
export async function getGrantedDaysForEmployee(
  employeeId: number,
  year: number
): Promise<number> {
  const grant = await prisma.annualLeaveGrant.findUnique({
    where: { employeeId_year: { employeeId, year } },
  });
  if (grant) return Number(grant.grantedDays);
  // grant 없으면 자동계산
  const emp = await prisma.employee.findUnique({
    where: { id: employeeId },
    select: { hiredAt: true },
  });
  if (!emp?.hiredAt) return 0;
  const policy = await getPolicy();
  return computeGrantedDays(emp.hiredAt, year, new Date(), policy);
}

// 특정 직원·연도의 잔여 연차 계산.
// 잔여 = 부여 - 도입전사용(initial_used_days) - 시스템사용.
export async function getRemainingDays(
  employeeId: number,
  year: number
): Promise<{ granted: number; initialUsed: number; systemUsed: number; remaining: number }> {
  const grant = await prisma.annualLeaveGrant.findUnique({
    where: { employeeId_year: { employeeId, year } },
  });
  const granted = await getGrantedDaysForEmployee(employeeId, year);
  const initialUsed = grant ? Number(grant.initialUsedDays) : 0;
  const systemUsed = await computeSystemUsedDays(employeeId, year);
  return {
    granted,
    initialUsed,
    systemUsed,
    remaining: granted - initialUsed - systemUsed,
  };
}

// 연차 차감 신청 1건의 차감량(본인 근무일 × 차감계수)만. checkLeaveRequest 와 같은 근무일 판정.
// 잔여·결재 대기가 필요 없는 곳(결재함 처리 완료 목록 등)에서 쓴다.
export async function computeLeaveAmount(
  employeeId: number,
  startDate: Date,
  endDate: Date,
  deductPerDay: number
): Promise<number> {
  if (deductPerDay <= 0) return 0;
  const ymd = (d: Date) => d.toISOString().split("T")[0];
  const isWorkDay = await loadWorkDayChecker([employeeId], ymd(startDate), ymd(endDate));
  return countWorkDays(isWorkDay, employeeId, startDate, endDate) * deductPerDay;
}

export interface LeaveYearCheck {
  year: number;
  amount: number;         // 이번 신청 중 그 연도 날짜의 차감량
  granted: number;
  used: number;           // 도입 전 사용 + 시스템 사용
  pending: number;        // 결재 대기 (검사 대상 신청 자신 제외)
  remaining: number;      // 부여 − 도입 전 사용 − 사용
  available: number;      // 잔여 − 대기 (= 신청 가능)
  availableAfter: number; // 신청 가능 − 이번 차감량
}

function fmtLeaveDays(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

// 연차 차감 신청 검사 — 신청·수정 검사, 미리보기, 결재함 카드가 모두 이 함수를 쓴다.
// - 연도를 넘는 신청은 날짜별로 해당 연도에서 차감하고, 연도별로 검사한다.
// - 신청 가능 = 잔여 − 결재 대기 (excludeRequestId 로 검사 대상 신청 자신은 대기에서 뺀다).
// - 부여가 0 이어도 같은 검사를 한다(예외 없음).
// deductPerDay <= 0(차감 없는 항목)이면 years 는 비고 ok=true.
export async function checkLeaveRequest(
  employeeId: number,
  startDate: Date,
  endDate: Date,
  deductPerDay: number,
  opts: { excludeRequestId?: number } = {}
): Promise<{
  workDays: number;
  amount: number;
  years: LeaveYearCheck[];
  ok: boolean;
  message: string | null;
}> {
  if (deductPerDay <= 0) {
    return { workDays: 0, amount: 0, years: [], ok: true, message: null };
  }
  const ymd = (d: Date) => d.toISOString().split("T")[0];
  const isWorkDay = await loadWorkDayChecker([employeeId], ymd(startDate), ymd(endDate));

  const years: LeaveYearCheck[] = [];
  let workDays = 0;
  for (let y = startDate.getUTCFullYear(); y <= endDate.getUTCFullYear(); y++) {
    const { from, toExclusive } = yearRange(y);
    const lastDay = new Date(toExclusive.getTime() - 86400000);
    const s = startDate > from ? startDate : from;
    const e = endDate < lastDay ? endDate : lastDay;
    const days = countWorkDays(isWorkDay, employeeId, s, e);
    workDays += days;
    const amount = days * deductPerDay;
    const { granted, initialUsed, systemUsed, remaining } = await getRemainingDays(employeeId, y);
    const pending = await computePendingLeaveDays(employeeId, y, opts.excludeRequestId);
    const available = remaining - pending;
    years.push({
      year: y,
      amount,
      granted,
      used: initialUsed + systemUsed,
      pending,
      remaining,
      available,
      availableAfter: available - amount,
    });
  }

  let message: string | null = null;
  for (const y of years) {
    if (y.amount <= 0) continue;
    if (y.granted <= 0) {
      message = `${y.year}년 연차 부여가 0일입니다. 연차 관리에서 부여를 확인하세요.`;
      break;
    }
    if (y.availableAfter < 0) {
      message =
        `연차 잔여가 부족합니다. (${y.year}년: 신청 ${fmtLeaveDays(y.amount)}일 / ` +
        `신청 가능 ${fmtLeaveDays(y.available)}일, 결재 대기 ${fmtLeaveDays(y.pending)}일)`;
      break;
    }
  }
  return {
    workDays,
    amount: workDays * deductPerDay,
    years,
    ok: message === null,
    message,
  };
}

export async function getPolicy(): Promise<AnnualLeavePolicyValues> {
  const p = await prisma.annualLeavePolicy.findFirst();
  if (!p) {
    return {
      baseDays: 15, incrementStartYear: 3, incrementCycleYears: 2,
      incrementDays: 1, maxDays: 25,
      firstYearMonthly: true, firstYearMax: 11, monthlyBasis: "month",
      grantBasis: "fiscal_year", firstYearFixedDays: 0,
    };
  }
  return {
    baseDays: Number(p.baseDays),
    incrementStartYear: p.incrementStartYear,
    incrementCycleYears: p.incrementCycleYears,
    incrementDays: Number(p.incrementDays),
    maxDays: Number(p.maxDays),
    firstYearMonthly: p.firstYearMonthly,
    firstYearMax: Number(p.firstYearMax),
    monthlyBasis: p.monthlyBasis,
    grantBasis: p.grantBasis,
    firstYearFixedDays: Number(p.firstYearFixedDays),
  };
}

// 특정 직원·연도의 연차 사용 내역(승인된 연차차감 신청) 목록 + 합계.
// 그 연도와 겹치는 신청을 그 연도 안 날짜만큼으로 보여준다(연도를 넘는 신청은 연도별로 나뉨).
// 계산은 computeSystemUsedDays 와 같다 → grants의 systemUsedDays 합계와 totalUsed가 일치한다.
export async function getLeaveDetailItems(
  employeeId: number,
  year: number
): Promise<{
  totalUsed: number;
  items: { startDate: string; endDate: string; categoryName: string | null; usedDays: number }[];
}> {
  const { from, toExclusive } = yearRange(year);
  const lastDay = new Date(toExclusive.getTime() - 86400000);
  const reqs = await prisma.attendanceRequest.findMany({
    where: {
      ...usedLeaveRequestWhere(employeeId),
      startDate: { lt: toExclusive },
      endDate: { gte: from },
    },
    orderBy: [{ startDate: "desc" }],
    select: {
      startDate: true,
      endDate: true,
      category: { select: { name: true, annualLeaveDeduct: true } },
    },
  });

  if (reqs.length === 0) return { totalUsed: 0, items: [] };
  const isWorkDay = await loadWorkDayChecker(
    [employeeId],
    from.toISOString().split("T")[0],
    lastDay.toISOString().split("T")[0]
  );

  let totalUsed = 0;
  const items = reqs.map((r) => {
    const deduct = r.category?.annualLeaveDeduct ? Number(r.category.annualLeaveDeduct) : 0;
    const s = r.startDate > from ? r.startDate : from;
    const e = r.endDate < lastDay ? r.endDate : lastDay;
    const used = deduct > 0 ? countWorkDays(isWorkDay, employeeId, s, e) * deduct : 0;
    totalUsed += used;
    return {
      startDate: s.toISOString().split("T")[0],
      endDate: e.toISOString().split("T")[0],
      categoryName: r.category?.name ?? null,
      usedDays: used,
    };
  });

  return { totalUsed, items };
}

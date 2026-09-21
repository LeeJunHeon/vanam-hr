import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/app/generated/prisma/client";
import { resolveShiftPoint, isWorkPoint } from "@/lib/shift-schedule";

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
    status: { in: ["approved", "auto_approved", "auto_delegated"] },
    category: { annualLeaveDeduct: { gt: 0 } },
    requestType: { not: "calendar_auto" },
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

// [from, toExclusive) 기간과 겹치는 연차 요청의, 기간 안 근무일 × 차감계수 합.
// 연차 관리와 같은 요청 필터·같은 근무일 판정을 쓴다.
export async function computeLeaveDaysInPeriod(
  employeeId: number,
  from: Date,
  toExclusive: Date
): Promise<number> {
  const reqs = await prisma.attendanceRequest.findMany({
    where: {
      ...usedLeaveRequestWhere(employeeId),
      startDate: { lt: toExclusive },
      endDate: { gte: from },
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

// 해당 연도(역년) 시스템 사용 연차 합계.
export async function computeSystemUsedDays(
  employeeId: number,
  year: number
): Promise<number> {
  const yearStart = new Date(Date.UTC(year, 0, 1));
  const yearEnd = new Date(Date.UTC(year, 11, 31, 23, 59, 59));
  const reqs = await prisma.attendanceRequest.findMany({
    where: {
      ...usedLeaveRequestWhere(employeeId),
      startDate: { gte: yearStart, lte: yearEnd },
    },
    select: {
      startDate: true,
      endDate: true,
      category: { select: { annualLeaveDeduct: true } },
    },
  });
  if (reqs.length === 0) return 0;
  const minStart = new Date(Math.min(...reqs.map((r) => r.startDate.getTime())));
  const maxEnd = new Date(Math.max(...reqs.map((r) => r.endDate.getTime())));
  const isWorkDay = await loadWorkDayChecker(
    [employeeId],
    minStart.toISOString().split("T")[0],
    maxEnd.toISOString().split("T")[0]
  );
  let total = 0;
  for (const r of reqs) {
    const deduct = r.category.annualLeaveDeduct
      ? Number(r.category.annualLeaveDeduct)
      : 0;
    if (deduct <= 0) continue;
    total += countWorkDays(isWorkDay, employeeId, r.startDate, r.endDate) * deduct;
  }
  return total;
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
// 계산은 /api/internal/my-leave-detail 라우트와 100% 동일하다 →
// grants의 systemUsedDays 합계와 이 화면의 totalUsed가 일치한다.
export async function getLeaveDetailItems(
  employeeId: number,
  year: number
): Promise<{
  totalUsed: number;
  items: { startDate: string; endDate: string; categoryName: string | null; usedDays: number }[];
}> {
  const yearStart = new Date(Date.UTC(year, 0, 1));
  const yearEnd = new Date(Date.UTC(year, 11, 31, 23, 59, 59));
  const reqs = await prisma.attendanceRequest.findMany({
    where: {
      ...usedLeaveRequestWhere(employeeId),
      startDate: { gte: yearStart, lte: yearEnd },
    },
    orderBy: [{ startDate: "desc" }],
    select: {
      startDate: true,
      endDate: true,
      category: { select: { name: true, annualLeaveDeduct: true } },
    },
  });

  if (reqs.length === 0) return { totalUsed: 0, items: [] };
  const minStart = new Date(Math.min(...reqs.map((r) => r.startDate.getTime())));
  const maxEnd = new Date(Math.max(...reqs.map((r) => r.endDate.getTime())));
  const isWorkDay = await loadWorkDayChecker(
    [employeeId],
    minStart.toISOString().split("T")[0],
    maxEnd.toISOString().split("T")[0]
  );

  let totalUsed = 0;
  const items = reqs.map((r) => {
    const deduct = r.category?.annualLeaveDeduct ? Number(r.category.annualLeaveDeduct) : 0;
    const used = countWorkDays(isWorkDay, employeeId, r.startDate, r.endDate) * deduct;
    totalUsed += used;
    return {
      startDate: r.startDate.toISOString().split("T")[0],
      endDate: r.endDate.toISOString().split("T")[0],
      categoryName: r.category?.name ?? null,
      usedDays: used,
    };
  });

  return { totalUsed, items };
}

import { prisma } from "@/lib/prisma";

export interface AnnualLeavePolicyValues {
  baseDays: number;
  incrementStartYear: number;
  incrementCycleYears: number;
  incrementDays: number;
  maxDays: number;
  firstYearMonthly: boolean;
  firstYearMax: number;
  monthlyBasis: string; // 'month' | 'hire_day'
}

// 기준일(asOf, 보통 오늘) 시점에 입사일(hiredAt)로부터 자동 부여량 계산.
// - 1년 미만: 월차. monthlyBasis='month'면 (연*12+월) 차이, 'hire_day'면 일자까지 고려.
//   월차 = min(경과개월, firstYearMax). firstYearMonthly=false면 0.
// - 1년 이상: 연차 공식. 근속연수 = floor(경과개월/12).
export function computeGrantedDays(
  hiredAt: Date,
  asOf: Date,
  policy: AnnualLeavePolicyValues
): number {
  // 경과 개월 수
  const hy = hiredAt.getUTCFullYear();
  const hm = hiredAt.getUTCMonth(); // 0-based
  const hd = hiredAt.getUTCDate();
  const ay = asOf.getUTCFullYear();
  const am = asOf.getUTCMonth();
  const ad = asOf.getUTCDate();

  let monthsElapsed = (ay - hy) * 12 + (am - hm);
  if (policy.monthlyBasis === "hire_day") {
    // 입사일(일자)이 아직 안 지났으면 한 달 덜 친다.
    if (ad < hd) monthsElapsed -= 1;
  }
  if (monthsElapsed < 0) monthsElapsed = 0;

  if (monthsElapsed < 12) {
    // 1년 미만 → 월차
    if (!policy.firstYearMonthly) return 0;
    return Math.min(monthsElapsed, policy.firstYearMax);
  }

  // 1년 이상 → 연차
  const years = Math.floor(monthsElapsed / 12); // 근속연수
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
      employeeId,
      status: { in: ["approved", "auto_approved", "auto_delegated"] },
      startDate: { gte: yearStart, lte: yearEnd },
      category: { annualLeaveDeduct: { gt: 0 } },
    },
    select: {
      startDate: true,
      endDate: true,
      category: { select: { annualLeaveDeduct: true } },
    },
  });
  let total = 0;
  for (const r of reqs) {
    const deduct = r.category.annualLeaveDeduct
      ? Number(r.category.annualLeaveDeduct)
      : 0;
    if (deduct <= 0) continue;
    const days =
      Math.floor((r.endDate.getTime() - r.startDate.getTime()) / 86400000) + 1;
    total += days * deduct;
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
  return computeGrantedDays(emp.hiredAt, new Date(), policy);
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
  };
}

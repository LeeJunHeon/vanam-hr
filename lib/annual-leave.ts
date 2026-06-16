import { prisma } from "@/lib/prisma";

// 정책 기반 부여량 계산.
// 근속연수 = year - 입사연도. increment_start_year 미만이면 base_days,
// 이상이면 base_days + (증가횟수 × increment_days), max_days 상한.
export function computeGrantedDays(
  hiredYear: number,
  targetYear: number,
  policy: {
    baseDays: number;
    incrementStartYear: number;
    incrementCycleYears: number;
    incrementDays: number;
    maxDays: number;
  }
): number {
  const years = targetYear - hiredYear; // 근속연수(해당 연도 기준)
  if (years < policy.incrementStartYear) {
    return policy.baseDays;
  }
  const cycles =
    Math.floor((years - policy.incrementStartYear) / policy.incrementCycleYears) + 1;
  const granted = policy.baseDays + cycles * policy.incrementDays;
  return Math.min(granted, policy.maxDays);
}

// 해당 연도(역년) 시스템 사용 연차 합계.
// 승인된(approved/auto_approved/auto_delegated) 신청 중 카테고리 annual_leave_deduct>0인 것만,
// 일수(startDate~endDate, 양끝 포함) × annual_leave_deduct 합산.
// 반차(0.5)는 보통 하루짜리이므로 1일 × 0.5 = 0.5로 계산됨.
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
    // 일수 계산 (양끝 포함). 반차도 카테고리에서 0.5로 처리되므로 일수는 1.
    const start = r.startDate.getTime();
    const end = r.endDate.getTime();
    const days =
      Math.floor((end - start) / (24 * 60 * 60 * 1000)) + 1;
    total += days * deduct;
  }
  return total;
}

// 정책 1행 로드(없으면 기본값 객체). Decimal→number 변환.
export async function getPolicy() {
  const p = await prisma.annualLeavePolicy.findFirst();
  if (!p) {
    return {
      baseDays: 15,
      incrementStartYear: 3,
      incrementCycleYears: 2,
      incrementDays: 1,
      maxDays: 25,
    };
  }
  return {
    baseDays: Number(p.baseDays),
    incrementStartYear: p.incrementStartYear,
    incrementCycleYears: p.incrementCycleYears,
    incrementDays: Number(p.incrementDays),
    maxDays: Number(p.maxDays),
  };
}

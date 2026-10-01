import { prisma } from "@/lib/prisma";
import { computeLeaveDaysInPeriod } from "@/lib/annual-leave";
import { LIVE_REQUEST_STATUSES } from "@/lib/attendance-live-requests";

// 개인 대시보드(dashboard/my-stats)·챗(internal/my-stats) 공용 본인 통계.
// - attended  : 기간 내 출근 시각이 있는 날
// - leaveDays : 기간 내 연차 차감 일수 (computeLeaveDaysInPeriod — 연차 관리와 같은 계산)
// - pending   : 기간과 무관하게 지금 결재 대기(pending)인 본인 신청 전부
// - completed : 기간(requested_at) 안에 낸 본인 신청 중 승인된 것(자동승인·대리 확정 포함).
//               캘린더·출장 자동 기록(request_type 'calendar_auto')은 본인이 낸 신청이 아니므로 뺀다.
export async function computeMyStats(
  employeeId: number,
  start: Date,
  endExclusive: Date
): Promise<{ attended: number; leaveDays: number; pending: number; completed: number }> {
  const [attended, leaveDays, pending, completed] = await Promise.all([
    prisma.attendanceDaily.count({
      where: { employeeId, workDate: { gte: start, lt: endExclusive }, checkIn: { not: null } },
    }),
    computeLeaveDaysInPeriod(employeeId, start, endExclusive),
    prisma.attendanceRequest.count({ where: { employeeId, status: "pending" } }),
    prisma.attendanceRequest.count({
      where: {
        employeeId,
        status: { in: LIVE_REQUEST_STATUSES },
        requestType: { not: "calendar_auto" },
        requestedAt: { gte: start, lt: endExclusive },
      },
    }),
  ]);
  return { attended, leaveDays, pending, completed };
}

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/auth-helpers";

// GET /api/dashboard/my-stats
// 본인 대시보드용 통계 — admin이 아니거나 매핑된 일반 사용자가 사용.
// 카드 4종:
//   1) myThisMonthAttended   : 이번달 본인 출근일 수 (checkIn != null)
//   2) myThisMonthLeaveDays  : 이번달 본인 휴가 사용일 (category.annual_leave_deduct 합)
//   3) myPendingRequests     : 본인이 신청한 pending 요청 수
//   4) myPendingApprovals    : 본인이 결재해야 할 pending 요청 수 (primary 또는 deputy)
export async function GET() {
  const r = await requireSession();
  if (!r.ok) return r.response;
  const { session } = r;

  const employeeId = session.user.employeeId;
  if (!Number.isInteger(employeeId)) {
    return NextResponse.json(
      {
        error:
          "본인 직원 정보가 매핑되어 있지 않습니다. 관리자에게 직원 등록을 요청하세요.",
      },
      { status: 403 }
    );
  }

  try {
    // KST 기준 이번달 시작/끝 계산 (raw query로 안전하게)
    const monthRange = await prisma.$queryRaw<
      Array<{ month_start: Date; next_month_start: Date }>
    >`
      WITH t AS (
        SELECT date_trunc('month', NOW() AT TIME ZONE 'Asia/Seoul')::date AS month_start
      )
      SELECT
        month_start,
        (month_start + interval '1 month')::date AS next_month_start
      FROM t
    `;
    const { month_start, next_month_start } = monthRange[0];

    const [
      myThisMonthAttended,
      myThisMonthLeaveRows,
      myPendingRequests,
      myPendingApprovals,
    ] = await Promise.all([
      prisma.attendanceDaily.count({
        where: {
          employeeId: employeeId as number,
          workDate: { gte: month_start, lt: next_month_start },
          checkIn: { not: null },
        },
      }),
      prisma.attendanceDaily.findMany({
        where: {
          employeeId: employeeId as number,
          workDate: { gte: month_start, lt: next_month_start },
          category: { annualLeaveDeduct: { not: null } },
        },
        include: { category: { select: { annualLeaveDeduct: true } } },
      }),
      prisma.attendanceRequest.count({
        where: {
          employeeId: employeeId as number,
          status: "pending",
        },
      }),
      prisma.attendanceRequest.count({
        where: {
          status: "pending",
          OR: [
            { primaryApproverId: employeeId as number },
            { deputyApproverId: employeeId as number },
          ],
          // 본인 신청 제외
          NOT: { employeeId: employeeId as number },
        },
      }),
    ]);

    const myThisMonthLeaveDays = myThisMonthLeaveRows.reduce(
      (sum, d) => sum + Number(d.category?.annualLeaveDeduct ?? 0),
      0
    );

    return NextResponse.json({
      employeeId,
      myThisMonthAttended,
      myThisMonthLeaveDays,
      myPendingRequests,
      myPendingApprovals,
      asOf: new Date().toISOString(),
    });
  } catch (error) {
    console.error("GET /api/dashboard/my-stats error:", error);
    return NextResponse.json(
      { error: "본인 통계 조회 실패" },
      { status: 500 }
    );
  }
}

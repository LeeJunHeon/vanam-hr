import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth-helpers";

// GET /api/dashboard/stats?period=day|month|year&targetDate=YYYY-MM-DD&targetMonth=YYYY-MM&targetYear=YYYY
//
// 고정 카드 (period 무관): activeEmployees, activeDepartments, activeDevices,
//                          pendingRequests, shiftPatterns, mappedSsoUsers
// 동적 카드 (period 따라): attendedCount, leaveDays
//   - day: targetDate 그 날 출근한 직원 수 / 휴가 사용일 합
//   - month: targetMonth 그 달 출근일 합 / 휴가 사용일 합
//   - year: targetYear 그 해 출근일 합 / 휴가 사용일 합
export async function GET(request: NextRequest) {
  try {
    const _auth = await requireAdmin();
    if (!_auth.ok) return _auth.response;

    const { searchParams } = new URL(request.url);
    const period = (searchParams.get("period") || "month") as
      | "day"
      | "month"
      | "year";
    const targetDate = searchParams.get("targetDate"); // YYYY-MM-DD
    const targetMonth = searchParams.get("targetMonth"); // YYYY-MM
    const targetYear = searchParams.get("targetYear"); // YYYY

    const now = new Date();

    // 기간 범위 계산 (KST 기준이 아닌 서버 시각 기준 — Prisma가 자동 변환)
    let rangeStart: Date;
    let rangeEnd: Date;

    if (period === "day") {
      const d = targetDate
        ? new Date(targetDate + "T00:00:00.000Z")
        : new Date(now.getFullYear(), now.getMonth(), now.getDate());
      rangeStart = new Date(d.getFullYear(), d.getMonth(), d.getDate());
      rangeEnd = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
    } else if (period === "month") {
      let y: number, m: number;
      if (targetMonth && /^\d{4}-\d{2}$/.test(targetMonth)) {
        const parts = targetMonth.split("-");
        y = Number(parts[0]);
        m = Number(parts[1]) - 1;
      } else {
        y = now.getFullYear();
        m = now.getMonth();
      }
      rangeStart = new Date(y, m, 1);
      rangeEnd = new Date(y, m + 1, 1);
    } else {
      // year
      let y: number;
      if (targetYear && /^\d{4}$/.test(targetYear)) {
        y = Number(targetYear);
      } else {
        y = now.getFullYear();
      }
      rangeStart = new Date(y, 0, 1);
      rangeEnd = new Date(y + 1, 0, 1);
    }

    const [
      activeEmployees,
      activeDepartments,
      activeDevices,
      pendingRequests,
      shiftPatterns,
      mappedSsoUsers,
      attendedRaw,
      leaveRaw,
    ] = await Promise.all([
      prisma.employee.count({ where: { isActive: true } }),
      prisma.department.count({ where: { isActive: true } }),
      prisma.device.count({ where: { isActive: true } }),
      prisma.attendanceRequest.count({ where: { status: "pending" } }),
      prisma.shiftPattern.count({ where: { isActive: true } }),
      prisma.employee.count({
        where: { isActive: true, userId: { not: null } },
      }),
      // attendedCount: 기간 내 attendance_daily where checkIn != null 의 개수
      prisma.attendanceDaily.count({
        where: {
          workDate: { gte: rangeStart, lt: rangeEnd },
          checkIn: { not: null },
        },
      }),
      // leaveDays: 기간 내 휴가 사용일 합
      prisma.attendanceDaily.findMany({
        where: {
          workDate: { gte: rangeStart, lt: rangeEnd },
          category: { annualLeaveDeduct: { not: null } },
        },
        include: { category: { select: { annualLeaveDeduct: true } } },
      }),
    ]);

    const leaveDays = leaveRaw.reduce(
      (sum, d) => sum + Number(d.category?.annualLeaveDeduct ?? 0),
      0
    );

    return NextResponse.json({
      period,
      range: {
        start: rangeStart.toISOString(),
        end: rangeEnd.toISOString(),
      },
      activeEmployees,
      activeDepartments,
      activeDevices,
      pendingRequests,
      shiftPatterns,
      mappedSsoUsers,
      attendedCount: attendedRaw,
      leaveDays,
      asOf: now.toISOString(),
    });
  } catch (error) {
    console.error("GET /api/dashboard/stats error:", error);
    return NextResponse.json(
      { error: "대시보드 통계 조회 실패" },
      { status: 500 }
    );
  }
}

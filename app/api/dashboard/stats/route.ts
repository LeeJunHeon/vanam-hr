import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth-helpers";

// GET /api/dashboard/stats — 모든 통계 병렬 집계
export async function GET() {
  try {
    const _auth = await requireAdmin();
    if (!_auth.ok) return _auth.response;

    const now = new Date();
    const todayStart = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate()
    );
    const todayEnd = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() + 1
    );
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const nextMonthStart = new Date(now.getFullYear(), now.getMonth() + 1, 1);

    const [
      activeEmployees,
      activeDepartments,
      activeDevices,
      pendingRequests,
      todayAttended,
      thisMonthLeaves,
      shiftPatterns,
      mappedSsoUsers,
    ] = await Promise.all([
      prisma.employee.count({ where: { isActive: true } }),
      prisma.department.count({ where: { isActive: true } }),
      prisma.device.count({ where: { isActive: true } }),
      prisma.attendanceRequest.count({ where: { status: "pending" } }),
      prisma.attendanceDaily.count({
        where: {
          workDate: { gte: todayStart, lt: todayEnd },
          checkIn: { not: null },
        },
      }),
      // 이번달 휴가 사용 합계 — category.annualLeaveDeduct 합
      prisma.attendanceDaily.findMany({
        where: {
          workDate: { gte: monthStart, lt: nextMonthStart },
          category: { annualLeaveDeduct: { not: null } },
        },
        include: { category: { select: { annualLeaveDeduct: true } } },
      }),
      prisma.shiftPattern.count({ where: { isActive: true } }),
      prisma.employee.count({
        where: { isActive: true, userId: { not: null } },
      }),
    ]);

    const totalLeaveDays = thisMonthLeaves.reduce(
      (sum, d) => sum + Number(d.category?.annualLeaveDeduct ?? 0),
      0
    );

    return NextResponse.json({
      activeEmployees,
      activeDepartments,
      activeDevices,
      pendingRequests,
      todayAttended,
      monthLeaveDays: totalLeaveDays,
      shiftPatterns,
      mappedSsoUsers,
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

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth-helpers";

// GET /api/dashboard/stats?period=day|month|year&targetDate=YYYY-MM-DD&targetMonth=YYYY-MM&targetYear=YYYY
//
// 기간 내 "문제 근태(결근/지각/조퇴) + 휴가 + 출장 + 외근"을 건수로 집계하고
// 각 항목의 상세 목록을 함께 반환한다. pendingRequests는 기간 무관 현재 pending 전체.
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

    const [pendingRequests, dailies] = await Promise.all([
      // 결재 대기 (기간 무관, 현재 pending 전체)
      prisma.attendanceRequest.count({ where: { status: "pending" } }),
      // 기간 내 attendance_daily — employee/category include 후 메모리 분류
      prisma.attendanceDaily.findMany({
        where: { workDate: { gte: rangeStart, lt: rangeEnd } },
        include: {
          employee: {
            select: {
              id: true,
              name: true,
              department: { select: { name: true } },
            },
          },
          category: {
            select: { code: true, name: true, annualLeaveDeduct: true },
          },
        },
        orderBy: { workDate: "desc" },
      }),
    ]);

    // 공통 필드 추출 헬퍼
    const base = (d: (typeof dailies)[number]) => ({
      employeeId: d.employee.id,
      name: d.employee.name,
      departmentName: d.employee.department?.name ?? null,
      workDate: d.workDate.toISOString().split("T")[0],
    });
    const iso = (v: Date | null) => (v ? v.toISOString() : null);

    const details = {
      absent: [] as Array<ReturnType<typeof base>>,
      late: [] as Array<ReturnType<typeof base> & { checkIn: string | null }>,
      earlyLeave: [] as Array<
        ReturnType<typeof base> & { checkIn: string | null; checkOut: string | null }
      >,
      leave: [] as Array<ReturnType<typeof base> & { categoryName: string | null }>,
      businessTrip: [] as Array<
        ReturnType<typeof base> & { categoryName: string | null; reason: string | null }
      >,
      externalWork: [] as Array<
        ReturnType<typeof base> & { categoryName: string | null; reason: string | null }
      >,
    };

    for (const d of dailies) {
      const code = d.category?.code ?? null;
      const categoryName = d.category?.name ?? null;
      const isLeave = d.category?.annualLeaveDeduct != null;

      // 휴가/출장/외근 (category 기준) — 이 행들은 auto_status가 normal이라
      // 결근/지각/조퇴 분류와 공존하지 않음
      if (code === "BUSINESS_TRIP") {
        details.businessTrip.push({ ...base(d), categoryName, reason: null });
      } else if (code === "EXTERNAL_WORK") {
        details.externalWork.push({ ...base(d), categoryName, reason: null });
      } else if (isLeave) {
        details.leave.push({ ...base(d), categoryName });
      }

      // 문제 근태 (auto_status 기준)
      switch (d.autoStatus) {
        case "absent":
          details.absent.push(base(d));
          break;
        case "late":
          details.late.push({ ...base(d), checkIn: iso(d.checkIn) });
          break;
        case "early_leave":
          details.earlyLeave.push({
            ...base(d),
            checkIn: iso(d.checkIn),
            checkOut: iso(d.checkOut),
          });
          break;
      }
    }

    const counts = {
      absent: details.absent.length,
      late: details.late.length,
      earlyLeave: details.earlyLeave.length,
      leave: details.leave.length,
      businessTrip: details.businessTrip.length,
      externalWork: details.externalWork.length,
    };

    return NextResponse.json({
      period,
      range: {
        start: rangeStart.toISOString(),
        end: rangeEnd.toISOString(),
      },
      asOf: now.toISOString(),
      pendingRequests,
      counts,
      details,
    });
  } catch (error) {
    console.error("GET /api/dashboard/stats error:", error);
    return NextResponse.json(
      { error: "대시보드 통계 조회 실패" },
      { status: 500 }
    );
  }
}

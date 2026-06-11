import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/auth-helpers";

// GET /api/dashboard/my-stats?period=day|month|year&targetDate=...&targetMonth=...&targetYear=...
//
// 본인 대시보드용 통계 (period 적용)
// 카드 4종 (모두 동적):
//   1) myAttended : 기간 내 본인 출근일 수
//   2) myLeaveDays : 기간 내 본인 휴가 사용일
//   3) myPendingRequests : 기간 내 본인이 신청한 것 중 pending
//   4) myCompletedRequests : 기간 내 본인이 신청한 것 중 approved
export async function GET(request: NextRequest) {
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
    const { searchParams } = new URL(request.url);
    const period = (searchParams.get("period") || "month") as
      | "day"
      | "month"
      | "year";
    const targetDate = searchParams.get("targetDate");
    const targetMonth = searchParams.get("targetMonth");
    const targetYear = searchParams.get("targetYear");

    const now = new Date();
    let rangeStart: Date;
    let rangeEnd: Date;

    // KST 기준 "오늘"을 구하기 위한 보정 (서버가 UTC여도 한국 날짜를 쓰도록)
    const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
    const nowKst = new Date(now.getTime() + KST_OFFSET_MS);
    const kstY = nowKst.getUTCFullYear();
    const kstM = nowKst.getUTCMonth();
    const kstD = nowKst.getUTCDate();

    if (period === "day") {
      let y = kstY, m = kstM, dd = kstD;
      if (targetDate && /^\d{4}-\d{2}-\d{2}$/.test(targetDate)) {
        const parts = targetDate.split("-");
        y = Number(parts[0]);
        m = Number(parts[1]) - 1;
        dd = Number(parts[2]);
      }
      // work_date(DATE)는 UTC 자정으로 저장되므로 range도 UTC 자정 기준으로 생성
      rangeStart = new Date(Date.UTC(y, m, dd));
      rangeEnd = new Date(Date.UTC(y, m, dd + 1));
    } else if (period === "month") {
      let y = kstY, m = kstM;
      if (targetMonth && /^\d{4}-\d{2}$/.test(targetMonth)) {
        const parts = targetMonth.split("-");
        y = Number(parts[0]);
        m = Number(parts[1]) - 1;
      }
      rangeStart = new Date(Date.UTC(y, m, 1));
      rangeEnd = new Date(Date.UTC(y, m + 1, 1));
    } else {
      let y = kstY;
      if (targetYear && /^\d{4}$/.test(targetYear)) {
        y = Number(targetYear);
      }
      rangeStart = new Date(Date.UTC(y, 0, 1));
      rangeEnd = new Date(Date.UTC(y + 1, 0, 1));
    }

    const [
      myAttended,
      myLeaveRaw,
      myPendingRequests,
      myCompletedRequests,
    ] = await Promise.all([
      prisma.attendanceDaily.count({
        where: {
          employeeId: employeeId as number,
          workDate: { gte: rangeStart, lt: rangeEnd },
          checkIn: { not: null },
        },
      }),
      prisma.attendanceDaily.findMany({
        where: {
          employeeId: employeeId as number,
          workDate: { gte: rangeStart, lt: rangeEnd },
          category: { annualLeaveDeduct: { not: null } },
        },
        include: { category: { select: { annualLeaveDeduct: true } } },
      }),
      prisma.attendanceRequest.count({
        where: {
          employeeId: employeeId as number,
          status: "pending",
          requestedAt: { gte: rangeStart, lt: rangeEnd },
        },
      }),
      prisma.attendanceRequest.count({
        where: {
          employeeId: employeeId as number,
          status: "approved",
          requestedAt: { gte: rangeStart, lt: rangeEnd },
        },
      }),
    ]);

    const myLeaveDays = myLeaveRaw.reduce(
      (sum, d) => sum + Number(d.category?.annualLeaveDeduct ?? 0),
      0
    );

    return NextResponse.json({
      employeeId,
      period,
      range: {
        start: rangeStart.toISOString(),
        end: rangeEnd.toISOString(),
      },
      myAttended,
      myLeaveDays,
      myPendingRequests,
      myCompletedRequests,
      asOf: now.toISOString(),
    });
  } catch (error) {
    console.error("GET /api/dashboard/my-stats error:", error);
    return NextResponse.json(
      { error: "본인 통계 조회 실패" },
      { status: 500 }
    );
  }
}

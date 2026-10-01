import { NextRequest, NextResponse } from "next/server";
import { kstTodayMidnightUtc } from "@/lib/kst-date";
import { requireSession } from "@/lib/auth-helpers";
import { computeMyStats } from "@/lib/my-stats";

// GET /api/dashboard/my-stats?period=day|month|year&targetDate=...&targetMonth=...&targetYear=...
//
// 본인 대시보드용 통계 (period 적용)
// 카드 4종 (모두 동적):
//   1) myAttended : 기간 내 본인 출근일 수
//   2) myLeaveDays : 기간 내 본인 연차 차감 일수
//   3) myPendingRequests : 기간과 무관하게 지금 결재 대기인 본인 신청
//   4) myCompletedRequests : 기간 내 본인이 낸 신청 중 승인(자동승인 포함, 캘린더·출장 자동 기록 제외)
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

    // KST 기준 "오늘" (lib/kst-date — 서버가 UTC여도 한국 날짜)
    const kstToday = kstTodayMidnightUtc();
    const kstY = kstToday.getUTCFullYear();
    const kstM = kstToday.getUTCMonth();
    const kstD = kstToday.getUTCDate();

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

    // 계산은 lib/my-stats (챗 internal/my-stats 와 같은 함수)
    const stats = await computeMyStats(employeeId as number, rangeStart, rangeEnd);
    const myAttended = stats.attended;
    const myLeaveDays = stats.leaveDays;
    const myPendingRequests = stats.pending;
    const myCompletedRequests = stats.completed;

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

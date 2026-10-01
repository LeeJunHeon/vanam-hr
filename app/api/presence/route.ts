import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getTargetEmployeeId } from "@/lib/auth-helpers";
import { loadTodayWorkDate } from "@/lib/kst-date";
import { loadTodayPresenceSummary } from "@/lib/realtime-presence";

// GET /api/presence?employeeId=N
// 본인의 오늘(근무일 창) presence_raw 요약을 반환.
// 비관리자: 본인만, 관리자: 다른 직원도 조회 가능.
export async function GET(request: NextRequest) {
  try {
    const r = await getTargetEmployeeId(request);
    if (!r.ok) return r.response;
    const employeeId = r.employeeId;

    // 오늘 = 근무일 창(work_date_cutoff_hour 기준). currentStatus 는 lib/realtime-presence 공용 판정 —
    // 오늘 기록이 없어도 마지막 기록이 online 이면(근무일 경계를 넘어 연결된 채) 연결 중이다.
    const { date: todayWorkDate, cutoffHour } = await loadTodayWorkDate(prisma);
    const summary = await loadTodayPresenceSummary(prisma, employeeId, todayWorkDate, cutoffHour);

    return NextResponse.json({
      employeeId,
      currentStatus: summary.currentStatus,
      lastOnlineAt: summary.lastOnlineAt ? summary.lastOnlineAt.toISOString() : null,
      lastOfflineAt: summary.lastOfflineAt ? summary.lastOfflineAt.toISOString() : null,
      todayRawCount: summary.todayRawCount,
    });
  } catch (error) {
    console.error("GET /api/presence error:", error);
    return NextResponse.json(
      { error: "presence 조회 실패" },
      { status: 500 }
    );
  }
}

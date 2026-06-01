import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-helpers";
import { prisma } from "@/lib/prisma";

// GET /api/calendar-sources
// 활성 calendar_sources 전체 반환. RequestPage/ApprovalPage의 캘린더 select 옵션용.
// 권한: 로그인한 모든 사용자 (직원도 신청 시 캘린더 선택 가능).
export async function GET() {
  try {
    const sessionR = await requireSession();
    if (!sessionR.ok) return sessionR.response;

    const sources = await prisma.calendarSource.findMany({
      where: { syncEnabled: true },
      select: {
        id: true,
        calendarId: true,
        calendarName: true,
        defaultCategoryId: true,
        description: true,
      },
      orderBy: { id: "asc" },
    });
    return NextResponse.json(sources);
  } catch (e) {
    console.error("GET /api/calendar-sources error:", e);
    return NextResponse.json(
      { error: "캘린더 목록을 가져올 수 없습니다." },
      { status: 500 }
    );
  }
}

import { NextRequest, NextResponse } from "next/server";
import { requireSession, isAdminSession } from "@/lib/auth-helpers";
import { getLeaveDetailItems } from "@/lib/annual-leave";

export const dynamic = "force-dynamic";

// GET /api/annual-leave/detail?employeeId=N&year=YYYY — 관리자용 개인별 연차 사용 내역.
export async function GET(request: NextRequest) {
  const sessionR = await requireSession();
  if (!sessionR.ok) return sessionR.response;
  if (!isAdminSession(sessionR.session)) {
    return NextResponse.json({ error: "관리자만 접근 가능합니다." }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const employeeIdRaw = searchParams.get("employeeId");
  const employeeId = Number(employeeIdRaw);
  if (!employeeIdRaw || !Number.isInteger(employeeId)) {
    return NextResponse.json({ error: "employeeId가 유효하지 않습니다." }, { status: 400 });
  }
  const year = Number(searchParams.get("year")) || new Date().getFullYear();

  const r = await getLeaveDetailItems(employeeId, year);
  return NextResponse.json({ employeeId, year, totalUsed: r.totalUsed, items: r.items });
}

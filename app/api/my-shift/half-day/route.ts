import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession, isAdminSession, canViewEmployee } from "@/lib/auth-helpers";
import { loadHalfDayInfo } from "@/lib/half-day-info";

// GET /api/my-shift/half-day?date=YYYY-MM-DD[&employeeId=N]
// 그날 시프트·반차 경계·반차 기본 시각(lib/half-day-info). 기본은 세션 본인.
// employeeId 는 관리자만 — 볼 수 있는 직원(canViewEmployee: 전체 권한 또는 본인 부서)일 때만(관리자 반차 시각 수정 안내용).
export async function GET(request: Request) {
  try {
    const r = await requireSession();
    if (!r.ok) return r.response;
    const { session } = r;

    const url = new URL(request.url);
    const date = url.searchParams.get("date") ?? "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || isNaN(Date.parse(`${date}T00:00:00.000Z`))) {
      return NextResponse.json({ error: "date(YYYY-MM-DD)가 필요합니다." }, { status: 400 });
    }

    const ownId = session.user.employeeId;
    const requestedRaw = url.searchParams.get("employeeId");
    let employeeId: number;
    if (requestedRaw !== null && Number(requestedRaw) !== ownId) {
      const n = Number(requestedRaw);
      if (!Number.isInteger(n)) {
        return NextResponse.json({ error: "employeeId는 정수여야 합니다." }, { status: 400 });
      }
      if (!isAdminSession(session)) {
        return NextResponse.json({ error: "권한이 없습니다." }, { status: 403 });
      }
      const target = await prisma.employee.findUnique({ where: { id: n }, select: { departmentId: true } });
      if (!target) return NextResponse.json({ error: "직원을 찾을 수 없습니다." }, { status: 404 });
      if (!canViewEmployee(session, n, target.departmentId)) {
        return NextResponse.json({ error: "권한이 없습니다." }, { status: 403 });
      }
      employeeId = n;
    } else {
      if (!Number.isInteger(ownId)) {
        return NextResponse.json({ error: "본인 직원 정보가 매핑되어 있지 않습니다." }, { status: 403 });
      }
      employeeId = ownId as number;
    }

    return NextResponse.json(await loadHalfDayInfo(prisma, employeeId, date));
  } catch (error) {
    console.error("GET /api/my-shift/half-day error:", error);
    return NextResponse.json({ error: "반차 기본 시각 조회 실패" }, { status: 500 });
  }
}

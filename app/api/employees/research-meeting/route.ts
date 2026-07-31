import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession, isAdminSession } from "@/lib/auth-helpers";

// 연구미팅 참여 여부 토글 (관리자 전용).
// 기존 /api/employees PUT과 분리 — 참여 지정만 단독으로 다룬다.
export async function PUT(request: Request) {
  try {
    const sessionR = await requireSession();
    if (!sessionR.ok) return sessionR.response;
    if (!isAdminSession(sessionR.session)) {
      return NextResponse.json(
        { error: "관리자 권한이 필요합니다." },
        { status: 403 }
      );
    }

    const body = await request.json().catch(() => ({}));
    const employeeId = Number(body?.employeeId);
    const attends = body?.attends;
    if (!Number.isInteger(employeeId) || typeof attends !== "boolean") {
      return NextResponse.json(
        { error: "employeeId(number)와 attends(boolean)가 필요합니다." },
        { status: 400 }
      );
    }

    const emp = await prisma.employee.findUnique({
      where: { id: employeeId },
      select: { id: true },
    });
    if (!emp) {
      return NextResponse.json(
        { error: "직원을 찾을 수 없습니다." },
        { status: 404 }
      );
    }

    await prisma.employee.update({
      where: { id: employeeId },
      data: { attendsResearchMeeting: attends },
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("PUT /api/employees/research-meeting error:", error);
    return NextResponse.json(
      { error: "연구미팅 참여 설정 변경 실패" },
      { status: 500 }
    );
  }
}

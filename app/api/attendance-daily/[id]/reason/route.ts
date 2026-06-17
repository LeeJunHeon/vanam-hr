import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/auth-helpers";

export async function PUT(
  request: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const r = await requireSession();
  if (!r.ok) return r.response;
  const { session } = r;

  const { id: idStr } = await ctx.params;
  const id = Number(idStr);
  if (!Number.isInteger(id)) {
    return NextResponse.json({ error: "id가 올바르지 않습니다." }, { status: 400 });
  }

  const body = await request.json();
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";

  // 대상 행 조회
  const daily = await prisma.attendanceDaily.findUnique({
    where: { id },
    select: { id: true, employeeId: true, autoStatus: true },
  });
  if (!daily) {
    return NextResponse.json({ error: "근태 기록을 찾을 수 없습니다." }, { status: 404 });
  }

  // 권한: 본인 것만 (관리자도 본인 것만 입력 — 사유는 당사자가 작성)
  const ownId = session.user.employeeId;
  if (daily.employeeId !== ownId) {
    return NextResponse.json({ error: "본인 근태에만 사유를 작성할 수 있습니다." }, { status: 403 });
  }

  // 지각/조퇴만 사유 입력 허용
  if (daily.autoStatus !== "late" && daily.autoStatus !== "early_leave") {
    return NextResponse.json({ error: "지각/조퇴 기록에만 사유를 작성할 수 있습니다." }, { status: 400 });
  }

  await prisma.attendanceDaily.update({
    where: { id },
    data: { statusReason: reason.length === 0 ? null : reason },
  });
  return NextResponse.json({ ok: true });
}

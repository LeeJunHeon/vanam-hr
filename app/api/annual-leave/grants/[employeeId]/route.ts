import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession, isAdminSession } from "@/lib/auth-helpers";

export async function PUT(
  request: NextRequest,
  ctx: { params: Promise<{ employeeId: string }> }
) {
  const sessionR = await requireSession();
  if (!sessionR.ok) return sessionR.response;
  if (!isAdminSession(sessionR.session)) {
    return NextResponse.json({ error: "관리자만 접근 가능합니다." }, { status: 403 });
  }
  const { employeeId: empIdStr } = await ctx.params;
  const employeeId = Number(empIdStr);
  const { searchParams } = new URL(request.url);
  const year = Number(searchParams.get("year")) || new Date().getFullYear();
  const body = await request.json();
  const grantedDays = Number(body.grantedDays);
  const initialUsedDays = Number(body.initialUsedDays ?? 0);
  if (!Number.isInteger(employeeId) || !Number.isFinite(grantedDays) || grantedDays < 0
      || !Number.isFinite(initialUsedDays) || initialUsedDays < 0) {
    return NextResponse.json({ error: "입력값이 올바르지 않습니다." }, { status: 400 });
  }
  const saved = await prisma.annualLeaveGrant.upsert({
    where: { employeeId_year: { employeeId, year } },
    update: { grantedDays, initialUsedDays, isManual: true, note: body.note ?? null },
    create: { employeeId, year, grantedDays, initialUsedDays, isManual: true, note: body.note ?? null },
  });
  return NextResponse.json({
    employeeId: saved.employeeId,
    year: saved.year,
    grantedDays: Number(saved.grantedDays),
    initialUsedDays: Number(saved.initialUsedDays),
  });
}

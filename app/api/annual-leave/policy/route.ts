import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession, isAdminSession } from "@/lib/auth-helpers";

export async function GET() {
  const sessionR = await requireSession();
  if (!sessionR.ok) return sessionR.response;
  if (!isAdminSession(sessionR.session)) {
    return NextResponse.json({ error: "관리자만 접근 가능합니다." }, { status: 403 });
  }
  const p = await prisma.annualLeavePolicy.findFirst();
  if (!p) {
    return NextResponse.json({
      baseDays: 15, incrementStartYear: 3, incrementCycleYears: 2,
      incrementDays: 1, maxDays: 25,
    });
  }
  return NextResponse.json({
    id: p.id,
    baseDays: Number(p.baseDays),
    incrementStartYear: p.incrementStartYear,
    incrementCycleYears: p.incrementCycleYears,
    incrementDays: Number(p.incrementDays),
    maxDays: Number(p.maxDays),
  });
}

export async function PUT(request: NextRequest) {
  const sessionR = await requireSession();
  if (!sessionR.ok) return sessionR.response;
  if (!isAdminSession(sessionR.session)) {
    return NextResponse.json({ error: "관리자만 접근 가능합니다." }, { status: 403 });
  }
  const body = await request.json();
  const data = {
    baseDays: Number(body.baseDays),
    incrementStartYear: Number(body.incrementStartYear),
    incrementCycleYears: Number(body.incrementCycleYears),
    incrementDays: Number(body.incrementDays),
    maxDays: Number(body.maxDays),
  };
  // 유효성: 숫자/음수 체크
  if (
    [data.baseDays, data.incrementStartYear, data.incrementCycleYears, data.incrementDays, data.maxDays].some(
      (v) => !Number.isFinite(v) || v < 0
    )
  ) {
    return NextResponse.json({ error: "모든 값은 0 이상의 숫자여야 합니다." }, { status: 400 });
  }
  const existing = await prisma.annualLeavePolicy.findFirst();
  let saved;
  if (existing) {
    saved = await prisma.annualLeavePolicy.update({
      where: { id: existing.id },
      data,
    });
  } else {
    saved = await prisma.annualLeavePolicy.create({ data });
  }
  return NextResponse.json({
    id: saved.id,
    baseDays: Number(saved.baseDays),
    incrementStartYear: saved.incrementStartYear,
    incrementCycleYears: saved.incrementCycleYears,
    incrementDays: Number(saved.incrementDays),
    maxDays: Number(saved.maxDays),
  });
}

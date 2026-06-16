import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession, isAdminSession } from "@/lib/auth-helpers";

export async function GET() {
  const s = await requireSession();
  if (!s.ok) return s.response;
  if (!isAdminSession(s.session))
    return NextResponse.json({ error: "관리자만 접근 가능합니다." }, { status: 403 });
  const p = await prisma.annualLeavePolicy.findFirst();
  if (!p) {
    return NextResponse.json({
      baseDays: 15, incrementStartYear: 3, incrementCycleYears: 2,
      incrementDays: 1, maxDays: 25,
      firstYearMonthly: true, firstYearMax: 11, monthlyBasis: "month",
    });
  }
  return NextResponse.json({
    id: p.id,
    baseDays: Number(p.baseDays),
    incrementStartYear: p.incrementStartYear,
    incrementCycleYears: p.incrementCycleYears,
    incrementDays: Number(p.incrementDays),
    maxDays: Number(p.maxDays),
    firstYearMonthly: p.firstYearMonthly,
    firstYearMax: Number(p.firstYearMax),
    monthlyBasis: p.monthlyBasis,
  });
}

export async function PUT(request: NextRequest) {
  const s = await requireSession();
  if (!s.ok) return s.response;
  if (!isAdminSession(s.session))
    return NextResponse.json({ error: "관리자만 접근 가능합니다." }, { status: 403 });
  const body = await request.json();
  const num = {
    baseDays: Number(body.baseDays),
    incrementStartYear: Number(body.incrementStartYear),
    incrementCycleYears: Number(body.incrementCycleYears),
    incrementDays: Number(body.incrementDays),
    maxDays: Number(body.maxDays),
    firstYearMax: Number(body.firstYearMax),
  };
  const firstYearMonthly = Boolean(body.firstYearMonthly);
  const monthlyBasis = body.monthlyBasis === "hire_day" ? "hire_day" : "month";
  if (Object.values(num).some((v) => !Number.isFinite(v) || v < 0)) {
    return NextResponse.json({ error: "모든 값은 0 이상의 숫자여야 합니다." }, { status: 400 });
  }
  if (num.incrementCycleYears < 1) {
    return NextResponse.json({ error: "증가 주기는 1 이상이어야 합니다." }, { status: 400 });
  }
  const data = { ...num, firstYearMonthly, monthlyBasis };
  const existing = await prisma.annualLeavePolicy.findFirst();
  const saved = existing
    ? await prisma.annualLeavePolicy.update({ where: { id: existing.id }, data })
    : await prisma.annualLeavePolicy.create({ data });
  return NextResponse.json({
    id: saved.id,
    baseDays: Number(saved.baseDays),
    incrementStartYear: saved.incrementStartYear,
    incrementCycleYears: saved.incrementCycleYears,
    incrementDays: Number(saved.incrementDays),
    maxDays: Number(saved.maxDays),
    firstYearMonthly: saved.firstYearMonthly,
    firstYearMax: Number(saved.firstYearMax),
    monthlyBasis: saved.monthlyBasis,
  });
}

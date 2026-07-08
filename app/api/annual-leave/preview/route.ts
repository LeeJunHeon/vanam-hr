import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/auth-helpers";
import { getRemainingDays, getHolidaySet, countBusinessDays } from "@/lib/annual-leave";

export const dynamic = "force-dynamic";

function parseYmd(s: string | null): Date | null {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(s + "T00:00:00.000Z");
  return isNaN(d.getTime()) ? null : d;
}

// GET /api/annual-leave/preview?categoryId=&startDate=&endDate=
// 본인(session) 기준. 선택 항목의 차감계수 × 근무일수 = 이번 차감량, 신청 후 잔여.
export async function GET(request: NextRequest) {
  const r = await requireSession();
  if (!r.ok) return r.response;
  const employeeId = r.session.user.employeeId;
  if (!Number.isInteger(employeeId)) {
    return NextResponse.json({ mapped: false });
  }
  const sp = new URL(request.url).searchParams;
  const categoryId = Number(sp.get("categoryId"));
  const startD = parseYmd(sp.get("startDate"));
  const endD = parseYmd(sp.get("endDate"));
  if (!Number.isInteger(categoryId) || !startD || !endD) {
    return NextResponse.json({ error: "categoryId/startDate/endDate 필요" }, { status: 400 });
  }
  if (endD < startD) {
    return NextResponse.json({ error: "종료일은 시작일 이후여야 합니다." }, { status: 400 });
  }

  const category = await prisma.attendanceCategory.findUnique({ where: { id: categoryId } });
  const deductPerDay = category?.annualLeaveDeduct ? Number(category.annualLeaveDeduct) : 0;

  const startYear = startD.getUTCFullYear();
  const { granted, remaining } = await getRemainingDays(employeeId as number, startYear);

  // 차감 없는 항목(병가/외근/재택 등)은 미리보기 대상 아님
  if (deductPerDay <= 0) {
    return NextResponse.json({
      mapped: true, deductPerDay: 0, businessDays: 0, requestAmount: 0,
      granted, remaining, remainingAfter: remaining,
    });
  }

  const ymd = (d: Date) => d.toISOString().split("T")[0];
  const holidays = await getHolidaySet(ymd(startD), ymd(endD));
  const businessDays = countBusinessDays(startD, endD, holidays);
  const requestAmount = businessDays * deductPerDay;

  return NextResponse.json({
    mapped: true, deductPerDay, businessDays, requestAmount,
    granted, remaining, remainingAfter: remaining - requestAmount,
  });
}

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/auth-helpers";
import { checkLeaveRequest, getRemainingDays } from "@/lib/annual-leave";

export const dynamic = "force-dynamic";

function parseYmd(s: string | null): Date | null {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(s + "T00:00:00.000Z");
  return isNaN(d.getTime()) ? null : d;
}

// GET /api/annual-leave/preview?categoryId=&startDate=&endDate=[&excludeRequestId=]
// 본인(session) 기준. 선택 항목의 차감계수 × 근무일수 = 이번 차감량, 신청 후 신청 가능.
// 계산은 신청 검사와 같은 checkLeaveRequest (결재 대기 포함, 연도별).
// excludeRequestId: 수정 모드 — 그 신청(본인 것)은 결재 대기에서 뺀다.
// 호환 필드: requestAmount = 전체 차감량, remaining = 시작 연도 잔여,
//            remainingAfter = 연도별 availableAfter 중 가장 작은 값.
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
  const excludeRaw = sp.get("excludeRequestId");
  let excludeRequestId: number | undefined;
  if (excludeRaw) {
    const id = Number(excludeRaw);
    // 본인 신청일 때만 제외(다른 사람 신청 id 로 대기를 빼는 것 방지)
    const own = Number.isInteger(id)
      ? await prisma.attendanceRequest.findFirst({
          where: { id, employeeId: employeeId as number },
          select: { id: true },
        })
      : null;
    if (own) excludeRequestId = own.id;
  }

  const category = await prisma.attendanceCategory.findUnique({ where: { id: categoryId } });
  const deductPerDay = category?.annualLeaveDeduct ? Number(category.annualLeaveDeduct) : 0;

  // 차감 없는 항목(병가/외근/재택 등)은 미리보기 대상 아님
  if (deductPerDay <= 0) {
    const { granted, remaining } = await getRemainingDays(
      employeeId as number,
      startD.getUTCFullYear()
    );
    return NextResponse.json({
      mapped: true, deductPerDay: 0, businessDays: 0, requestAmount: 0,
      granted, remaining, remainingAfter: remaining, years: [],
    });
  }

  const check = await checkLeaveRequest(employeeId as number, startD, endD, deductPerDay, {
    excludeRequestId,
  });
  const first = check.years[0];

  // 필드명은 프론트 호환을 위해 businessDays 유지 (의미: 본인 시프트상 근무일)
  return NextResponse.json({
    mapped: true,
    deductPerDay,
    businessDays: check.workDays,
    requestAmount: check.amount,
    granted: first.granted,
    remaining: first.remaining,
    remainingAfter: Math.min(...check.years.map((y) => y.availableAfter)),
    years: check.years,
    ok: check.ok,
    message: check.message,
  });
}

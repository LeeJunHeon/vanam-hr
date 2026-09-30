import { NextRequest, NextResponse } from "next/server";
import { requireHrPortalAuth } from "@/lib/internal-portal-auth";
import { resolveHrIdentity } from "@/lib/internal-identity";
import { getRemainingDays, computePendingLeaveDays } from "@/lib/annual-leave";

export const dynamic = "force-dynamic";

// GET /api/internal/my-annual-leave?year=YYYY
// 챗봇(포털 경유)용 "본인 잔여 연차". 신원 = x-acting-user-email → 그 사람 employeeId로만 조회.
export async function GET(request: NextRequest) {
  const auth = requireHrPortalAuth(request);
  if (!auth.ok) return auth.response;

  const identity = await resolveHrIdentity(auth.actingEmail);
  const year = Number(new URL(request.url).searchParams.get("year")) || new Date().getFullYear();

  if (!Number.isInteger(identity.employeeId)) {
    return NextResponse.json({ mapped: false, email: auth.actingEmail, year, granted: 0, used: 0, remaining: 0, pending: 0, available: 0 });
  }

  const { granted, initialUsed, systemUsed, remaining } = await getRemainingDays(
    identity.employeeId as number, year
  );
  // 결재 대기 연차(그 연도 안 날짜만) — 신청 가능 = 잔여 − 결재 대기
  const pending = await computePendingLeaveDays(identity.employeeId as number, year);

  return NextResponse.json({
    mapped: true,
    employeeId: identity.employeeId,
    employeeNo: identity.employeeNo,
    year, granted,
    used: initialUsed + systemUsed,
    remaining,
    pending,
    // 신청 가능 = 잔여 − 결재 대기 (신청 검사와 같은 기준)
    available: remaining - pending,
  });
}

import { NextRequest, NextResponse } from "next/server";
import { requireHrPortalAuth } from "@/lib/internal-portal-auth";
import { resolveHrIdentity } from "@/lib/internal-identity";
import { getRemainingDays } from "@/lib/annual-leave";

export const dynamic = "force-dynamic";

// GET /api/internal/my-annual-leave?year=YYYY
// 챗봇(포털 경유)용 "본인 잔여 연차". 신원 = x-acting-user-email → 그 사람 employeeId로만 조회.
export async function GET(request: NextRequest) {
  const auth = requireHrPortalAuth(request);
  if (!auth.ok) return auth.response;

  const identity = await resolveHrIdentity(auth.actingEmail);
  const year = Number(new URL(request.url).searchParams.get("year")) || new Date().getFullYear();

  if (!Number.isInteger(identity.employeeId)) {
    return NextResponse.json({ mapped: false, email: auth.actingEmail, year, granted: 0, used: 0, remaining: 0 });
  }

  const { granted, initialUsed, systemUsed, remaining } = await getRemainingDays(
    identity.employeeId as number, year
  );

  return NextResponse.json({
    mapped: true,
    employeeId: identity.employeeId,
    employeeNo: identity.employeeNo,
    year, granted,
    used: initialUsed + systemUsed,
    remaining,
  });
}

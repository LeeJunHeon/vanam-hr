import { NextRequest, NextResponse } from "next/server";
import { requireHrPortalAuth } from "@/lib/internal-portal-auth";
import { resolveHrIdentity } from "@/lib/internal-identity";
import { getLeaveDetailItems } from "@/lib/annual-leave";

export const dynamic = "force-dynamic";

// GET /api/internal/my-leave-detail?year=YYYY — 본인 연차 사용 내역(승인된 연차차감 신청 목록).
export async function GET(request: NextRequest) {
  const auth = requireHrPortalAuth(request);
  if (!auth.ok) return auth.response;
  const identity = await resolveHrIdentity(auth.actingEmail);
  if (!Number.isInteger(identity.employeeId)) {
    return NextResponse.json({ mapped: false, items: [] });
  }
  const empId = identity.employeeId as number;

  const yearParam = new URL(request.url).searchParams.get("year");
  const year =
    yearParam && /^\d{4}$/.test(yearParam) ? Number(yearParam) : new Date().getUTCFullYear();

  const { totalUsed, items } = await getLeaveDetailItems(empId, year);
  return NextResponse.json({ mapped: true, year, totalUsed, items });
}

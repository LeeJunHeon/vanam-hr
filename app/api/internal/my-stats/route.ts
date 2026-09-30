import { NextRequest, NextResponse } from "next/server";
import { requireHrPortalAuth } from "@/lib/internal-portal-auth";
import { resolveHrIdentity } from "@/lib/internal-identity";
import { resolvePeriodRange } from "@/lib/period-range";
import { computeMyStats } from "@/lib/my-stats";

export const dynamic = "force-dynamic";

// GET /api/internal/my-stats — 본인 통계 (dashboard/my-stats 와 같은 계산 lib/my-stats).
// 응답 필드 이름(attended·leaveDays·pending·completed)은 포털 호환을 위해 유지한다.
export async function GET(request: NextRequest) {
  const auth = requireHrPortalAuth(request);
  if (!auth.ok) return auth.response;
  const identity = await resolveHrIdentity(auth.actingEmail);
  if (!Number.isInteger(identity.employeeId)) {
    return NextResponse.json({ mapped: false });
  }
  const empId = identity.employeeId as number;
  const sp = new URL(request.url).searchParams;
  const { start, end, label } = resolvePeriodRange(sp.get("period"), sp.get("yearMonth"));
  const { attended, leaveDays, pending, completed } = await computeMyStats(empId, start, end);
  return NextResponse.json({
    mapped: true,
    month: label,
    attended, leaveDays, pending, completed,
  });
}

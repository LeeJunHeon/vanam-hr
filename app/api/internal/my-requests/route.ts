import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireHrPortalAuth } from "@/lib/internal-portal-auth";
import { resolveHrIdentity } from "@/lib/internal-identity";
import { resolvePeriodRange } from "@/lib/period-range";

export const dynamic = "force-dynamic";

// GET /api/internal/my-requests — 본인 근태 신청 내역(최근 30건).
export async function GET(request: NextRequest) {
  const auth = requireHrPortalAuth(request);
  if (!auth.ok) return auth.response;
  const identity = await resolveHrIdentity(auth.actingEmail);
  if (!Number.isInteger(identity.employeeId)) {
    return NextResponse.json({ mapped: false, requests: [] });
  }
  const sp = new URL(request.url).searchParams;
  const period = sp.get("period");
  const yearMonth = sp.get("yearMonth");
  const where: any = { employeeId: identity.employeeId as number };
  if (period || yearMonth) {
    const { start, end } = resolvePeriodRange(period, yearMonth);
    where.requestedAt = { gte: start, lt: end };
  }
  const rows = await prisma.attendanceRequest.findMany({
    where,
    orderBy: [{ requestedAt: "desc" }],
    take: 30,
    include: { category: { select: { name: true } } },
  });
  return NextResponse.json({
    mapped: true,
    requests: rows.map((r) => ({
      categoryName: r.category?.name ?? null,
      startDate: r.startDate.toISOString().split("T")[0],
      endDate: r.endDate.toISOString().split("T")[0],
      status: r.status,
      reason: r.reason,
    })),
  });
}

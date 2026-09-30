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
  // 상태 라벨 — 웹 RequestPage 와 같은 code_lookups(request_status). 캘린더에서 빠진 취소는 따로 표시.
  const lookups = await prisma.codeLookup.findMany({
    where: { category: "request_status" },
    select: { code: true, label: true },
  });
  const labelOf = new Map(lookups.map((l) => [l.code, l.label]));
  const statusLabel = (status: string, cancelSource: string | null) =>
    status === "cancelled" && cancelSource === "calendar_sync"
      ? "취소됨 (캘린더에서 빠짐)"
      : labelOf.get(status) ?? status;
  return NextResponse.json({
    mapped: true,
    requests: rows.map((r) => ({
      categoryName: r.category?.name ?? null,
      startDate: r.startDate.toISOString().split("T")[0],
      endDate: r.endDate.toISOString().split("T")[0],
      status: r.status,
      statusLabel: statusLabel(r.status, r.cancelSource),
      reason: r.reason,
    })),
  });
}

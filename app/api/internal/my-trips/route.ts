import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireHrPortalAuth } from "@/lib/internal-portal-auth";
import { resolveHrIdentity } from "@/lib/internal-identity";
import { resolvePeriodRange } from "@/lib/period-range";

export const dynamic = "force-dynamic";

function ymd(d: Date): string {
  return d.toISOString().split("T")[0];
}

// GET /api/internal/my-trips — 본인이 참여하는 출장 목록(기본 전체, period/yearMonth로 기간 필터).
export async function GET(request: NextRequest) {
  const auth = requireHrPortalAuth(request);
  if (!auth.ok) return auth.response;
  const identity = await resolveHrIdentity(auth.actingEmail);
  if (!Number.isInteger(identity.employeeId)) {
    return NextResponse.json({ mapped: false, trips: [] });
  }
  const empId = identity.employeeId as number;

  const sp = new URL(request.url).searchParams;
  const period = sp.get("period");
  const yearMonth = sp.get("yearMonth");

  const tripWhere: any = {};
  if (period || yearMonth) {
    const { start, end } = resolvePeriodRange(period, yearMonth);
    tripWhere.startDate = { gte: start, lt: end };
  }

  const rows = await prisma.tripParticipant.findMany({
    where: {
      employeeId: empId,
      tripEvent: tripWhere,
    },
    orderBy: [{ tripEvent: { startDate: "desc" } }],
    take: 50,
    include: {
      tripEvent: {
        select: {
          name: true,
          location: true,
          startDate: true,
          endDate: true,
          status: true,
        },
      },
    },
  });

  return NextResponse.json({
    mapped: true,
    trips: rows.map((p) => ({
      name: p.tripEvent?.name ?? null,
      location: p.tripEvent?.location ?? null,
      startDate: p.tripEvent ? ymd(p.tripEvent.startDate) : null,
      endDate: p.tripEvent ? ymd(p.tripEvent.endDate) : null,
      tripStatus: p.tripEvent?.status ?? null,
      inviteStatus: p.inviteStatus,
      approvalStatus: p.approvalStatus,
    })),
  });
}

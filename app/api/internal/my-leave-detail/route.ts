import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireHrPortalAuth } from "@/lib/internal-portal-auth";
import { resolveHrIdentity } from "@/lib/internal-identity";

export const dynamic = "force-dynamic";

function ymd(d: Date): string {
  return d.toISOString().split("T")[0];
}

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
  const yearStart = new Date(Date.UTC(year, 0, 1));
  const yearEnd = new Date(Date.UTC(year, 11, 31, 23, 59, 59));

  const reqs = await prisma.attendanceRequest.findMany({
    where: {
      employeeId: empId,
      status: { in: ["approved", "auto_approved", "auto_delegated"] },
      startDate: { gte: yearStart, lte: yearEnd },
      category: { annualLeaveDeduct: { gt: 0 } },
    },
    orderBy: [{ startDate: "desc" }],
    select: {
      startDate: true,
      endDate: true,
      category: { select: { name: true, annualLeaveDeduct: true } },
    },
  });

  let totalUsed = 0;
  const items = reqs.map((r) => {
    const deduct = r.category?.annualLeaveDeduct ? Number(r.category.annualLeaveDeduct) : 0;
    const days = Math.floor((r.endDate.getTime() - r.startDate.getTime()) / 86400000) + 1;
    const used = days * deduct;
    totalUsed += used;
    return {
      startDate: ymd(r.startDate),
      endDate: ymd(r.endDate),
      categoryName: r.category?.name ?? null,
      usedDays: used,
    };
  });

  return NextResponse.json({ mapped: true, year, totalUsed, items });
}

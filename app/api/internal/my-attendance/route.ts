import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireHrPortalAuth } from "@/lib/internal-portal-auth";
import { resolveHrIdentity } from "@/lib/internal-identity";

export const dynamic = "force-dynamic";

// GET /api/internal/my-attendance — 본인 이번달 근태 기록.
export async function GET(request: NextRequest) {
  const auth = requireHrPortalAuth(request);
  if (!auth.ok) return auth.response;
  const identity = await resolveHrIdentity(auth.actingEmail);
  if (!Number.isInteger(identity.employeeId)) {
    return NextResponse.json({ mapped: false, records: [] });
  }
  const KST = 9 * 60 * 60 * 1000;
  const now = new Date(Date.now() + KST);
  const y = now.getUTCFullYear(), m = now.getUTCMonth();
  const start = new Date(Date.UTC(y, m, 1));
  const end = new Date(Date.UTC(y, m + 1, 1));
  const dailies = await prisma.attendanceDaily.findMany({
    where: { employeeId: identity.employeeId as number, workDate: { gte: start, lt: end } },
    orderBy: [{ workDate: "asc" }],
    include: { category: { select: { name: true } } },
  });
  return NextResponse.json({
    mapped: true,
    month: `${y}-${String(m + 1).padStart(2, "0")}`,
    records: dailies.map((d) => ({
      workDate: d.workDate.toISOString().split("T")[0],
      checkIn: d.checkIn ? d.checkIn.toISOString() : null,
      checkOut: d.checkOut ? d.checkOut.toISOString() : null,
      categoryName: d.category?.name ?? null,
      workMinutes: d.workMinutes,
    })),
  });
}

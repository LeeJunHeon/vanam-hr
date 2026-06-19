import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireHrPortalAuth } from "@/lib/internal-portal-auth";
import { resolveHrIdentity } from "@/lib/internal-identity";

export const dynamic = "force-dynamic";

// GET /api/internal/my-stats — 본인 이번달 통계 (dashboard/my-stats 쿼리 복제).
export async function GET(request: NextRequest) {
  const auth = requireHrPortalAuth(request);
  if (!auth.ok) return auth.response;
  const identity = await resolveHrIdentity(auth.actingEmail);
  if (!Number.isInteger(identity.employeeId)) {
    return NextResponse.json({ mapped: false });
  }
  const empId = identity.employeeId as number;
  const KST = 9 * 60 * 60 * 1000;
  const now = new Date(Date.now() + KST);
  const y = now.getUTCFullYear(), m = now.getUTCMonth();
  const start = new Date(Date.UTC(y, m, 1));
  const end = new Date(Date.UTC(y, m + 1, 1));
  const [attended, leaveRaw, pending, completed] = await Promise.all([
    prisma.attendanceDaily.count({ where: { employeeId: empId, workDate: { gte: start, lt: end }, checkIn: { not: null } } }),
    prisma.attendanceDaily.findMany({ where: { employeeId: empId, workDate: { gte: start, lt: end }, category: { annualLeaveDeduct: { not: null } } }, include: { category: { select: { annualLeaveDeduct: true } } } }),
    prisma.attendanceRequest.count({ where: { employeeId: empId, status: "pending", requestedAt: { gte: start, lt: end } } }),
    prisma.attendanceRequest.count({ where: { employeeId: empId, status: "approved", requestedAt: { gte: start, lt: end } } }),
  ]);
  const leaveDays = leaveRaw.reduce((s, d) => s + Number(d.category?.annualLeaveDeduct ?? 0), 0);
  return NextResponse.json({
    mapped: true,
    month: `${y}-${String(m + 1).padStart(2, "0")}`,
    attended, leaveDays, pending, completed,
  });
}

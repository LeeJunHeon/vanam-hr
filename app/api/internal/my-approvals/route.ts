import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireHrPortalAuth } from "@/lib/internal-portal-auth";
import { resolveHrIdentity } from "@/lib/internal-identity";

export const dynamic = "force-dynamic";

// GET /api/internal/my-approvals — 본인이 결재할 대기(pending) 건.
export async function GET(request: NextRequest) {
  const auth = requireHrPortalAuth(request);
  if (!auth.ok) return auth.response;
  const identity = await resolveHrIdentity(auth.actingEmail);
  if (!Number.isInteger(identity.employeeId)) {
    return NextResponse.json({ mapped: false, approvals: [] });
  }
  const approverId = identity.employeeId as number;

  const rows = await prisma.attendanceRequest.findMany({
    where: {
      status: "pending",
      OR: [
        { approverIds: { has: approverId } },
        { deputyApproverId: approverId },
      ],
    },
    orderBy: [{ requestedAt: "desc" }],
    include: {
      employee: { select: { name: true, department: { select: { name: true } } } },
      category: { select: { name: true } },
    },
  });
  return NextResponse.json({
    mapped: true,
    approvals: rows.map((r) => ({
      requesterName: r.employee?.name ?? null,
      departmentName: r.employee?.department?.name ?? null,
      categoryName: r.category?.name ?? null,
      startDate: r.startDate.toISOString().split("T")[0],
      endDate: r.endDate.toISOString().split("T")[0],
    })),
  });
}

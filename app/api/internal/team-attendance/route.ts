import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireHrPortalAuth } from "@/lib/internal-portal-auth";
import { resolveHrIdentity } from "@/lib/internal-identity";
import { canViewAllEmployees } from "@/lib/auth-helpers";

export const dynamic = "force-dynamic";

// GET /api/internal/team-attendance — 오늘(KST) 출근 현황(권한 스코프).
export async function GET(request: NextRequest) {
  const auth = requireHrPortalAuth(request);
  if (!auth.ok) return auth.response;
  const identity = await resolveHrIdentity(auth.actingEmail);

  // 권한 판정 — 기존 권한함수 재사용(합성 세션). realtime과 동일 규칙.
  const synthetic = {
    user: {
      role: identity.role,
      departmentId: identity.departmentId,
      employeeId: identity.employeeId,
    },
  } as unknown as Parameters<typeof canViewAllEmployees>[0];

  let scope: "all" | "department";
  let deptId: number | null = null;
  if (canViewAllEmployees(synthetic)) {
    scope = "all";
  } else if (identity.role === "admin" && identity.departmentId != null) {
    scope = "department";
    deptId = identity.departmentId;
  } else {
    return NextResponse.json({ allowed: false });
  }

  // 오늘(KST) 범위
  const KST = 9 * 60 * 60 * 1000;
  const now = new Date(Date.now() + KST);
  const y = now.getUTCFullYear(), m = now.getUTCMonth(), dd = now.getUTCDate();
  const start = new Date(Date.UTC(y, m, dd));
  const end = new Date(Date.UTC(y, m, dd + 1));

  const empWhere: any = { isActive: true };
  if (scope === "department") empWhere.departmentId = deptId;

  const employees = await prisma.employee.findMany({
    where: empWhere,
    select: { id: true, name: true, department: { select: { name: true } } },
    orderBy: { id: "asc" },
  });
  const empIds = employees.map((e) => e.id);

  const dailies = await prisma.attendanceDaily.findMany({
    where: { employeeId: { in: empIds }, workDate: { gte: start, lt: end } },
    select: { employeeId: true, checkIn: true, category: { select: { name: true } } },
  });
  const dailyMap = new Map<number, { checkIn: Date | null; categoryName: string | null }>();
  for (const d of dailies) {
    dailyMap.set(d.employeeId, { checkIn: d.checkIn, categoryName: d.category?.name ?? null });
  }

  let present = 0, leave = 0, absent = 0;
  const absentList: Array<{ name: string | null; departmentName: string | null }> = [];
  const leaveList: Array<{ name: string | null; categoryName: string | null }> = [];
  for (const e of employees) {
    const d = dailyMap.get(e.id);
    if (d?.checkIn) {
      present++;
    } else if (d?.categoryName) {
      leave++;
      leaveList.push({ name: e.name, categoryName: d.categoryName });
    } else {
      absent++;
      absentList.push({ name: e.name, departmentName: e.department?.name ?? null });
    }
  }

  return NextResponse.json({
    allowed: true,
    scope,
    date: `${y}-${String(m + 1).padStart(2, "0")}-${String(dd).padStart(2, "0")}`,
    total: employees.length,
    present, leave, absent,
    absentList, leaveList,
  });
}

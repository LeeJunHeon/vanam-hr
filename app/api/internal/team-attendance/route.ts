import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireHrPortalAuth } from "@/lib/internal-portal-auth";
import { resolveHrIdentity } from "@/lib/internal-identity";
import { canViewAllEmployees } from "@/lib/auth-helpers";

export const dynamic = "force-dynamic";

// GET /api/internal/team-attendance?date=YYYY-MM-DD — 출근 현황(권한 스코프). 기본 오늘(KST).
// CEO/인사담당=전체, 부서장=자기 부서, 그 외=권한없음. isHrOnly(인사카드 전용)는 제외.
export async function GET(request: NextRequest) {
  const auth = requireHrPortalAuth(request);
  if (!auth.ok) return auth.response;
  const identity = await resolveHrIdentity(auth.actingEmail);

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

  // 대상 날짜 (param date=YYYY-MM-DD, 없으면 오늘 KST)
  const KST = 9 * 60 * 60 * 1000;
  const dateParam = new URL(request.url).searchParams.get("date");
  let y: number, m: number, dd: number;
  if (dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
    const p = dateParam.split("-");
    y = Number(p[0]); m = Number(p[1]) - 1; dd = Number(p[2]);
  } else {
    const now = new Date(Date.now() + KST);
    y = now.getUTCFullYear(); m = now.getUTCMonth(); dd = now.getUTCDate();
  }
  const start = new Date(Date.UTC(y, m, dd));
  const end = new Date(Date.UTC(y, m, dd + 1));

  const empWhere: any = { isActive: true, isHrOnly: false };
  if (scope === "department") empWhere.departmentId = deptId;

  const employees = await prisma.employee.findMany({
    where: empWhere,
    select: { id: true, name: true, department: { select: { name: true } } },
    orderBy: { id: "asc" },
  });
  const empIds = employees.map((e) => e.id);

  const dailies = await prisma.attendanceDaily.findMany({
    where: { employeeId: { in: empIds }, workDate: { gte: start, lt: end } },
    select: {
      employeeId: true,
      checkIn: true,
      autoStatus: true,
      category: { select: { name: true, code: true, annualLeaveDeduct: true } },
    },
  });
  const dailyMap = new Map<number, (typeof dailies)[number]>();
  for (const d of dailies) dailyMap.set(d.employeeId, d);

  const hm = (dt: Date | null) =>
    dt ? new Date(dt.getTime() + KST).toISOString().slice(11, 16) : null;

  let present = 0, late = 0, earlyLeave = 0, leave = 0, absent = 0, pending = 0;
  const lateList: Array<{ name: string | null; checkIn: string | null }> = [];
  const absentList: Array<{ name: string | null; departmentName: string | null }> = [];
  const leaveList: Array<{ name: string | null; categoryName: string | null }> = [];

  for (const e of employees) {
    const d = dailyMap.get(e.id);
    const cat = d?.category;
    const isLeaveCat =
      !!cat && (cat.annualLeaveDeduct != null || cat.code === "BUSINESS_TRIP" || cat.code === "EXTERNAL_WORK");
    if (isLeaveCat) {
      leave++;
      leaveList.push({ name: e.name, categoryName: cat?.name ?? null });
      continue;
    }
    switch (d?.autoStatus) {
      case "absent":
        absent++;
        absentList.push({ name: e.name, departmentName: e.department?.name ?? null });
        break;
      case "late":
        late++;
        lateList.push({ name: e.name, checkIn: hm(d.checkIn) });
        break;
      case "early_leave":
        earlyLeave++;
        break;
      case "normal":
        present++;
        break;
      default:
        if (d?.checkIn) present++;
        else pending++;
    }
  }

  return NextResponse.json({
    allowed: true,
    scope,
    date: `${y}-${String(m + 1).padStart(2, "0")}-${String(dd).padStart(2, "0")}`,
    total: employees.length,
    present, late, earlyLeave, leave, absent, pending,
    lateList, absentList, leaveList,
  });
}

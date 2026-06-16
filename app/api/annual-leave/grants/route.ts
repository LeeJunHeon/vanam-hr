import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession, isAdminSession } from "@/lib/auth-helpers";
import { getPolicy, computeGrantedDays, computeSystemUsedDays } from "@/lib/annual-leave";

export async function GET(request: NextRequest) {
  const sessionR = await requireSession();
  if (!sessionR.ok) return sessionR.response;
  if (!isAdminSession(sessionR.session)) {
    return NextResponse.json({ error: "관리자만 접근 가능합니다." }, { status: 403 });
  }
  const { searchParams } = new URL(request.url);
  const year = Number(searchParams.get("year")) || new Date().getFullYear();

  const policy = await getPolicy();
  const employees = await prisma.employee.findMany({
    where: { isActive: true },
    select: { id: true, name: true, employeeNo: true, hiredAt: true,
              department: { select: { name: true } } },
    orderBy: { id: "asc" },
  });
  const grants = await prisma.annualLeaveGrant.findMany({ where: { year } });
  const grantMap = new Map(grants.map((g) => [g.employeeId, g]));

  const result = [];
  for (const e of employees) {
    const grant = grantMap.get(e.id);
    const hiredYear = e.hiredAt ? e.hiredAt.getUTCFullYear() : null;
    const autoGranted = hiredYear != null
      ? computeGrantedDays(hiredYear, year, policy)
      : 0;
    const grantedDays = grant ? Number(grant.grantedDays) : autoGranted;
    const initialUsedDays = grant ? Number(grant.initialUsedDays) : 0;
    const systemUsedDays = await computeSystemUsedDays(e.id, year);
    const remainingDays = grantedDays - initialUsedDays - systemUsedDays;
    result.push({
      employeeId: e.id,
      name: e.name,
      employeeNo: e.employeeNo,
      departmentName: e.department?.name ?? null,
      hiredAt: e.hiredAt ? e.hiredAt.toISOString().split("T")[0] : null,
      grantedDays,
      autoGrantedDays: autoGranted,
      initialUsedDays,
      systemUsedDays,
      remainingDays,
      hasGrantRow: !!grant,
    });
  }
  return NextResponse.json({ year, employees: result });
}

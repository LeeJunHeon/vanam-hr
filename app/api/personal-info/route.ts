import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requirePersonalInfoAccess } from "@/lib/auth-helpers";

export async function GET() {
  const r = await requirePersonalInfoAccess();
  if (!r.ok) return r.response;

  const employees = await prisma.employee.findMany({
    where: { isActive: true },
    select: {
      id: true,
      employeeNo: true,
      name: true,
      department: { select: { name: true } },
      position: { select: { name: true } },
      personalInfo: { select: { id: true, hrName: true, hrPosition: true, hrDepartment: true } },
    },
    orderBy: [
      { hrSortOrder: { sort: "asc", nulls: "last" } },
      { id: "asc" },
    ],
  });

  return NextResponse.json(
    employees.map((e) => ({
      employeeId: e.id,
      employeeNo: e.employeeNo,
      name: e.personalInfo?.hrName || e.name,
      departmentName: e.personalInfo?.hrDepartment || e.department?.name || null,
      positionName: e.personalInfo?.hrPosition || e.position?.name || null,
      hasInfo: !!e.personalInfo,
    }))
  );
}

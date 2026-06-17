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
      personalInfo: { select: { id: true } }, // 입력 여부만
    },
    orderBy: { id: "asc" },
  });

  return NextResponse.json(
    employees.map((e) => ({
      employeeId: e.id,
      employeeNo: e.employeeNo,
      name: e.name,
      departmentName: e.department?.name ?? null,
      positionName: e.position?.name ?? null,
      hasInfo: !!e.personalInfo,
    }))
  );
}

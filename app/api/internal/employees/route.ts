import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireHrReadAuth } from "@/lib/internal-auth";

export const dynamic = "force-dynamic";

// GET /api/internal/employees?search=... — 직원 검색(최소 필드만).
// ⚠️ 개인정보(email/phone/userId/입퇴사일/note) 절대 미노출. 활성 직원만. 신원 불필요.
export async function GET(request: Request) {
  const auth = requireHrReadAuth(request);
  if (!auth.ok) return auth.response;
  try {
    const { searchParams } = new URL(request.url);
    const search = searchParams.get("search") || "";

    const where: any = { isActive: true, isHrOnly: false };
    if (search) {
      where.OR = [
        { employeeNo: { contains: search, mode: "insensitive" } },
        { name: { contains: search, mode: "insensitive" } },
      ];
    }

    const employees = await prisma.employee.findMany({
      where,
      orderBy: [{ employeeNo: "asc" }],
      select: {
        id: true,
        employeeNo: true,
        name: true,
        isActive: true,
        department: { select: { name: true } },
        position: { select: { name: true } },
      },
    });

    return NextResponse.json(
      employees.map((e) => ({
        id: e.id,
        employeeNo: e.employeeNo,
        name: e.name,
        departmentName: e.department?.name ?? null,
        positionName: e.position?.name ?? null,
        isActive: e.isActive,
      }))
    );
  } catch (error) {
    console.error("GET /api/internal/employees error:", error);
    return NextResponse.json({ error: "직원 조회 실패" }, { status: 500 });
  }
}

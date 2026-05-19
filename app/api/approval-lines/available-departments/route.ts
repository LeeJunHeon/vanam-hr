import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// GET /api/approval-lines/available-departments
// 결재선이 아직 없는 활성 부서 목록 (추가 폼의 부서 select용)
export async function GET() {
  try {
    const lines = await prisma.approvalLine.findMany({
      select: { departmentId: true },
    });
    const takenIds = lines.map((l) => l.departmentId);

    const where: any = { isActive: true };
    if (takenIds.length > 0) where.id = { notIn: takenIds };

    const departments = await prisma.department.findMany({
      where,
      orderBy: [{ sortOrder: "asc" }, { code: "asc" }],
      select: { id: true, code: true, name: true },
    });

    return NextResponse.json(departments);
  } catch (error) {
    console.error("GET /api/approval-lines/available-departments error:", error);
    return NextResponse.json(
      { error: "가용 부서 조회 실패" },
      { status: 500 }
    );
  }
}

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth-helpers";

// GET /api/approval-lines/available-departments
// 결재선이 아직 없는 활성 부서 목록 (추가 폼의 부서 select용)
export async function GET() {
  try {
    const _auth = await requireAdmin();
    if (!_auth.ok) return _auth.response;

    // 항목별 결재선(부서 기본 + 항목별)으로 한 부서에 여러 라인 가능 → 모든 활성 부서 노출
    const where: any = { isActive: true };

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

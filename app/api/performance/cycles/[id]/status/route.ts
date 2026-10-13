import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth-helpers";
import { PERF_REVIEW_FORM, hasAnyContent } from "@/lib/performance/form";
import { effectiveSheetStatus, reviewStatusOf } from "@/lib/performance/rules";
import { EMPLOYEE_ORDER } from "@/lib/performance/server";

export const dynamic = "force-dynamic";

// GET /api/performance/cycles/[id]/status — 대상자별 제출 현황.
// ⚠ 성과 내용(content)·04 면담 기록 내용은 절대 포함하지 않는다 (상태 판정에만 쓴다).
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const r = await requireAdmin();
    if (!r.ok) return r.response;

    const { id: idRaw } = await params;
    const id = Number(idRaw);
    if (!Number.isInteger(id) || id <= 0) {
      return NextResponse.json({ error: "잘못된 회차 id입니다." }, { status: 400 });
    }
    const cycle = await prisma.perfCycle.findUnique({ where: { id } });
    if (!cycle) return NextResponse.json({ error: "회차를 찾을 수 없습니다." }, { status: 404 });

    const [employees, sheets] = await Promise.all([
      prisma.employee.findMany({
        where: { id: { in: cycle.targetEmployeeIds } },
        orderBy: EMPLOYEE_ORDER,
        select: { id: true, name: true, department: { select: { name: true } } },
      }),
      prisma.perfSheet.findMany({
        where: {
          year: cycle.year,
          quarter: cycle.quarter,
          employeeId: { in: cycle.targetEmployeeIds },
        },
        select: {
          employeeId: true,
          status: true,
          content: true,
          submittedAt: true,
          reviewContent: true,
          reviewFinalizedAt: true,
        },
      }),
    ]);
    const sheetMap = new Map(sheets.map((s) => [s.employeeId, s]));

    return NextResponse.json({
      rows: employees.map((e) => {
        const s = sheetMap.get(e.id);
        return {
          employeeId: e.id,
          name: e.name,
          departmentName: e.department?.name ?? null,
          status: effectiveSheetStatus(s?.status, hasAnyContent(s?.content)),
          submittedAt: s?.submittedAt?.toISOString() ?? null,
          hasSubmitted: s?.submittedAt != null,
          reviewStatus: reviewStatusOf(
            hasAnyContent(s?.reviewContent, PERF_REVIEW_FORM),
            s?.reviewFinalizedAt != null
          ),
        };
      }),
    });
  } catch (error) {
    console.error("GET /api/performance/cycles/[id]/status error:", error);
    return NextResponse.json({ error: "제출 현황 조회 실패" }, { status: 500 });
  }
}

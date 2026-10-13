import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth-helpers";
import { parseReviewTarget, sessionEmployeeId } from "@/lib/performance/server";

export const dynamic = "force-dynamic";

// POST /api/performance/sheets/review/unfinalize — 04 평가 확정 취소 { employeeId, year, quarter }
export async function POST(request: NextRequest) {
  try {
    const r = await requireAdmin();
    if (!r.ok) return r.response;

    const body = await request.json().catch(() => ({}));
    const target = parseReviewTarget(body);
    if (!target) {
      return NextResponse.json({ error: "직원과 분기를 올바르게 지정해 주세요." }, { status: 400 });
    }
    const { employeeId, yq } = target;
    const actorId = sessionEmployeeId(r.session);

    const result = await prisma.$transaction(async (tx) => {
      const sheet = await tx.perfSheet.findUnique({
        where: { employeeId_year_quarter: { employeeId, ...yq } },
        select: { id: true },
      });
      if (!sheet) return { ok: false as const, status: 404, error: "성과표를 찾을 수 없습니다." };

      const updated = await tx.perfSheet.updateMany({
        where: { id: sheet.id, reviewFinalizedAt: { not: null } },
        data: { reviewFinalizedAt: null, reviewFinalizedById: null },
      });
      if (updated.count === 0) {
        return { ok: false as const, status: 409, error: "확정된 평가가 아닙니다. 다시 불러와 주세요." };
      }
      await tx.perfSheetLog.create({
        data: { sheetId: sheet.id, action: "review_unfinalize", actorEmployeeId: actorId },
      });
      return { ok: true as const };
    });
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("POST /api/performance/sheets/review/unfinalize error:", error);
    return NextResponse.json({ error: "확정 취소 실패" }, { status: 500 });
  }
}

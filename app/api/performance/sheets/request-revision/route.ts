import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth-helpers";
import { createNotifications } from "@/lib/notify";
import { parseYearQuarter, quarterLabel } from "@/lib/performance/rules";

export const dynamic = "force-dynamic";

const REASON_MAX = 1000;
const REVIEW_FINALIZED = "평가가 확정된 성과는 수정을 요청할 수 없습니다. 확정을 취소한 뒤 요청하세요.";

// POST /api/performance/sheets/request-revision — 수정 요청 { employeeId, year, quarter, reason }
export async function POST(request: NextRequest) {
  try {
    const r = await requireAdmin();
    if (!r.ok) return r.response;
    const { session } = r;

    const body = await request.json().catch(() => ({}));
    const employeeId = Number(body?.employeeId);
    const yq = parseYearQuarter(body?.year, body?.quarter);
    if (!Number.isInteger(employeeId) || employeeId <= 0 || !yq) {
      return NextResponse.json({ error: "직원과 분기를 올바르게 지정해 주세요." }, { status: 400 });
    }
    const reason = typeof body?.reason === "string" ? body.reason.trim().slice(0, REASON_MAX) : "";
    if (!reason) {
      return NextResponse.json({ error: "수정 요청 사유를 입력해 주세요." }, { status: 400 });
    }

    const actorRaw = session.user.employeeId;
    const actorId = Number.isInteger(actorRaw) ? (actorRaw as number) : null;

    const result = await prisma.$transaction(async (tx) => {
      const sheet = await tx.perfSheet.findUnique({
        where: { employeeId_year_quarter: { employeeId, ...yq } },
        select: { id: true, reviewFinalizedAt: true },
      });
      if (!sheet) return { ok: false as const, status: 404, error: "아직 제출하지 않은 성과입니다." };
      if (sheet.reviewFinalizedAt) return { ok: false as const, status: 409, error: REVIEW_FINALIZED };

      const now = new Date();
      const updated = await tx.perfSheet.updateMany({
        where: { id: sheet.id, status: "submitted", reviewFinalizedAt: null },
        data: {
          status: "revision",
          revisionReason: reason,
          revisionRequestedAt: now,
          revisionRequestedById: actorId,
          updatedAt: now,
        },
      });
      if (updated.count === 0) {
        // 그 사이 평가가 확정됐으면 그 사유로 알려 준다
        const cur = await tx.perfSheet.findUnique({
          where: { id: sheet.id },
          select: { reviewFinalizedAt: true },
        });
        if (cur?.reviewFinalizedAt) return { ok: false as const, status: 409, error: REVIEW_FINALIZED };
        return {
          ok: false as const,
          status: 409,
          error: "제출 완료 상태인 성과에만 수정을 요청할 수 있습니다.",
        };
      }
      await tx.perfSheetLog.create({
        data: { sheetId: sheet.id, action: "request_revision", actorEmployeeId: actorId, note: reason },
      });
      return { ok: true as const };
    });
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }

    // 알림 실패가 수정 요청 자체를 되돌리지는 않는다
    try {
      await createNotifications({
        employeeIds: [employeeId],
        type: "perf_revision",
        title: "성과 수정 요청",
        body: `${quarterLabel(yq.year, yq.quarter)} 성과에 수정 요청이 있습니다: ${reason}`,
        linkPage: "my-performance",
      });
    } catch (e) {
      console.error("[performance] 수정 요청 알림 발송 실패:", e);
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("POST /api/performance/sheets/request-revision error:", error);
    return NextResponse.json({ error: "수정 요청 실패" }, { status: 500 });
  }
}

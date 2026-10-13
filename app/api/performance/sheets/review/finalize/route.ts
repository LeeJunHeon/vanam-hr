import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@/app/generated/prisma/client";
import { requireAdmin } from "@/lib/auth-helpers";
import { PERF_REVIEW_FORM, sanitizeContent, validateForSubmit } from "@/lib/performance/form";
import {
  parseBaseUpdatedAt,
  parseReviewTarget,
  sessionEmployeeId,
  writeReview,
} from "@/lib/performance/server";

export const dynamic = "force-dynamic";

// POST /api/performance/sheets/review/finalize — 04 평가 확정 { employeeId, year, quarter, content, baseUpdatedAt }
// 내용 저장과 확정을 한 번에 (저장과 같은 조건부 update)
export async function POST(request: NextRequest) {
  try {
    const r = await requireAdmin();
    if (!r.ok) return r.response;

    const body = await request.json().catch(() => ({}));
    const target = parseReviewTarget(body);
    const baseUpdatedAt = parseBaseUpdatedAt(body?.baseUpdatedAt);
    if (!target || baseUpdatedAt === undefined) {
      return NextResponse.json({ error: "직원과 분기를 올바르게 지정해 주세요." }, { status: 400 });
    }

    const errors = validateForSubmit(body?.content, PERF_REVIEW_FORM);
    if (errors.length > 0) {
      return NextResponse.json({ error: "입력하지 않은 항목이 있습니다.", errors }, { status: 400 });
    }

    const result = await writeReview({
      ...target,
      content: sanitizeContent(body?.content, PERF_REVIEW_FORM) as Prisma.InputJsonObject,
      baseUpdatedAt,
      actorId: sessionEmployeeId(r.session),
      finalize: true,
    });
    if (!result.ok) {
      return NextResponse.json({ error: result.error, code: result.code }, { status: result.status });
    }
    return NextResponse.json({ updatedAt: result.updatedAt.toISOString() });
  } catch (error) {
    console.error("POST /api/performance/sheets/review/finalize error:", error);
    return NextResponse.json({ error: "평가 확정 실패" }, { status: 500 });
  }
}

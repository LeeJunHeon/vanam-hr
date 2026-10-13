import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@/app/generated/prisma/client";
import { requireAdmin } from "@/lib/auth-helpers";
import { PERF_REVIEW_FORM, sanitizeContent } from "@/lib/performance/form";
import {
  parseBaseUpdatedAt,
  parseReviewTarget,
  sessionEmployeeId,
  writeReview,
} from "@/lib/performance/server";

export const dynamic = "force-dynamic";

// PUT /api/performance/sheets/review — 04 면담 기록 저장 { employeeId, year, quarter, content, baseUpdatedAt }
export async function PUT(request: NextRequest) {
  try {
    const r = await requireAdmin();
    if (!r.ok) return r.response;

    const body = await request.json().catch(() => ({}));
    const target = parseReviewTarget(body);
    const baseUpdatedAt = parseBaseUpdatedAt(body?.baseUpdatedAt);
    if (!target || baseUpdatedAt === undefined) {
      return NextResponse.json({ error: "직원과 분기를 올바르게 지정해 주세요." }, { status: 400 });
    }

    const result = await writeReview({
      ...target,
      content: sanitizeContent(body?.content, PERF_REVIEW_FORM) as Prisma.InputJsonObject,
      baseUpdatedAt,
      actorId: sessionEmployeeId(r.session),
      finalize: false,
    });
    if (!result.ok) {
      return NextResponse.json({ error: result.error, code: result.code }, { status: result.status });
    }
    return NextResponse.json({ updatedAt: result.updatedAt.toISOString() });
  } catch (error) {
    console.error("PUT /api/performance/sheets/review error:", error);
    return NextResponse.json({ error: "면담 기록 저장 실패" }, { status: 500 });
  }
}

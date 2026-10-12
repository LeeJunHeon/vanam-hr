import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth-helpers";
import { sanitizeContent } from "@/lib/performance/form";
import { parseYearQuarter, quarterLabel } from "@/lib/performance/rules";

export const dynamic = "force-dynamic";

// GET /api/performance/sheets?employeeId=&year=&quarter= — 관리자 열람 (마지막 제출본만).
// ⚠ 작성 중인 content 는 어떤 경우에도 내보내지 않는다 — submitted_content 만.
export async function GET(request: NextRequest) {
  try {
    const r = await requireAdmin();
    if (!r.ok) return r.response;

    const sp = new URL(request.url).searchParams;
    const employeeId = Number(sp.get("employeeId"));
    const yq = parseYearQuarter(sp.get("year"), sp.get("quarter"));
    if (!Number.isInteger(employeeId) || employeeId <= 0 || !yq) {
      return NextResponse.json({ error: "직원과 분기를 올바르게 지정해 주세요." }, { status: 400 });
    }

    const sheet = await prisma.perfSheet.findUnique({
      where: { employeeId_year_quarter: { employeeId, ...yq } },
      select: {
        status: true,
        submittedContent: true,
        submittedAt: true,
        revisionReason: true,
        revisionRequestedAt: true,
        employee: { select: { name: true } },
      },
    });
    if (!sheet || !sheet.submittedAt) {
      return NextResponse.json({ error: "아직 제출하지 않은 성과입니다." }, { status: 404 });
    }

    const history = await prisma.perfSheet.findMany({
      where: { employeeId, submittedAt: { not: null } },
      orderBy: [{ year: "desc" }, { quarter: "desc" }],
      select: { year: true, quarter: true },
    });

    return NextResponse.json({
      employeeName: sheet.employee.name,
      label: quarterLabel(yq.year, yq.quarter),
      status: sheet.status,
      submittedAt: sheet.submittedAt.toISOString(),
      revisionReason: sheet.revisionReason,
      revisionRequestedAt: sheet.revisionRequestedAt?.toISOString() ?? null,
      content: sanitizeContent(sheet.submittedContent),
      history: history.map((h) => ({
        year: h.year,
        quarter: h.quarter,
        label: quarterLabel(h.year, h.quarter),
      })),
    });
  } catch (error) {
    console.error("GET /api/performance/sheets error:", error);
    return NextResponse.json({ error: "성과 조회 실패" }, { status: 500 });
  }
}

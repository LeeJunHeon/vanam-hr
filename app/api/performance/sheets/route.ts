import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth-helpers";
import { PERF_REVIEW_FORM, sanitizeContent } from "@/lib/performance/form";
import { parseYearQuarter, quarterLabel } from "@/lib/performance/rules";
import {
  buildPerfInfo,
  keepExistingFiles,
  loadSheetFileMetas,
  pickProfile,
  referencedFileMetas,
  sessionEmployeeId,
} from "@/lib/performance/server";

export const dynamic = "force-dynamic";

// GET /api/performance/sheets?employeeId=&year=&quarter= — 관리자 열람 (마지막 제출본만).
// ⚠ 작성 중인 content 는 어떤 경우에도 내보내지 않는다 — submitted_content 만.
// review 는 04 면담 및 평가 기록 (관리자 전용).
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
        id: true,
        status: true,
        submittedContent: true,
        submittedAt: true,
        revisionReason: true,
        revisionRequestedAt: true,
        profileSnapshot: true,
        reviewContent: true,
        reviewUpdatedAt: true,
        reviewFinalizedAt: true,
        reviewUpdatedBy: { select: { name: true } },
        reviewFinalizedBy: { select: { name: true } },
        employee: { select: { name: true } },
      },
    });
    if (!sheet || !sheet.submittedAt) {
      return NextResponse.json({ error: "아직 제출하지 않은 성과입니다." }, { status: 404 });
    }

    // 평가자 칸 미리 채우기용 — 로그인한 관리자 이름
    const viewerId = sessionEmployeeId(r.session);
    const [history, viewer] = await Promise.all([
      prisma.perfSheet.findMany({
        where: { employeeId, submittedAt: { not: null } },
        orderBy: [{ year: "desc" }, { quarter: "desc" }],
        select: { year: true, quarter: true },
      }),
      viewerId != null
        ? prisma.employee.findUnique({ where: { id: viewerId }, select: { name: true } })
        : Promise.resolve(null),
    ]);

    // 제출본이 참조하는 파일만 (작성 중에 올린 파일은 관리자에게 보이지 않는다)
    const fileMetas = await loadSheetFileMetas(sheet.id);
    const content = keepExistingFiles(sanitizeContent(sheet.submittedContent), fileMetas);
    const files = referencedFileMetas(content, fileMetas);

    const profile = pickProfile(sheet.status, sheet.profileSnapshot, { name: sheet.employee.name });

    return NextResponse.json({
      employeeName: sheet.employee.name,
      label: quarterLabel(yq.year, yq.quarter),
      status: sheet.status,
      submittedAt: sheet.submittedAt.toISOString(),
      revisionReason: sheet.revisionReason,
      revisionRequestedAt: sheet.revisionRequestedAt?.toISOString() ?? null,
      content,
      files,
      info: buildPerfInfo(profile, yq),
      review: {
        content: sanitizeContent(sheet.reviewContent, PERF_REVIEW_FORM),
        updatedAt: sheet.reviewUpdatedAt?.toISOString() ?? null,
        updatedByName: sheet.reviewUpdatedBy?.name ?? null,
        finalizedAt: sheet.reviewFinalizedAt?.toISOString() ?? null,
        finalizedByName: sheet.reviewFinalizedBy?.name ?? null,
      },
      viewerName: viewer?.name ?? r.session.user.name ?? "",
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

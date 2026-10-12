import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@/app/generated/prisma/client";
import { requireSession } from "@/lib/auth-helpers";
import { PERF_FORM_VERSION, hasAnyContent, sanitizeContent } from "@/lib/performance/form";
import {
  effectiveSheetStatus,
  getSheetAccess,
  isFutureQuarter,
  parseYearQuarter,
  quarterLabel,
} from "@/lib/performance/rules";
import { cycleDates, cycleView, perfTodayYmd, requireEmployeeId } from "@/lib/performance/server";

export const dynamic = "force-dynamic";

const BAD_QUARTER = "연도와 분기가 올바르지 않습니다.";
const FUTURE_QUARTER = "아직 시작하지 않은 분기입니다.";

// GET /api/performance/my/sheet?year=&quarter= — 내 실적표 (작성 중 내용)
export async function GET(request: NextRequest) {
  try {
    const sessionR = await requireSession();
    if (!sessionR.ok) return sessionR.response;
    const empR = requireEmployeeId(sessionR.session);
    if (!empR.ok) return empR.response;
    const { employeeId } = empR;

    const sp = new URL(request.url).searchParams;
    const yq = parseYearQuarter(sp.get("year"), sp.get("quarter"));
    if (!yq) return NextResponse.json({ error: BAD_QUARTER }, { status: 400 });
    const todayYmd = perfTodayYmd();
    if (isFutureQuarter(yq, todayYmd)) {
      return NextResponse.json({ error: FUTURE_QUARTER }, { status: 400 });
    }

    const [sheet, cycle] = await Promise.all([
      prisma.perfSheet.findUnique({
        where: { employeeId_year_quarter: { employeeId, ...yq } },
      }),
      prisma.perfCycle.findUnique({ where: { year_quarter: yq } }),
    ]);
    const content = sanitizeContent(sheet?.content);
    const isTarget = cycle ? cycle.targetEmployeeIds.includes(employeeId) : false;

    return NextResponse.json({
      label: quarterLabel(yq.year, yq.quarter),
      formVersion: sheet?.formVersion ?? PERF_FORM_VERSION,
      status: effectiveSheetStatus(sheet?.status, hasAnyContent(content)),
      content,
      submittedAt: sheet?.submittedAt?.toISOString() ?? null,
      revisionReason: sheet?.revisionReason ?? null,
      revisionRequestedAt: sheet?.revisionRequestedAt?.toISOString() ?? null,
      updatedAt: sheet?.updatedAt.toISOString() ?? null,
      cycle: cycle ? cycleView(cycle, todayYmd) : null,
      isTarget,
      access: getSheetAccess({
        ...yq,
        todayYmd,
        sheetStatus: sheet?.status ?? null,
        cycle: cycle ? cycleDates(cycle) : null,
        isTarget,
      }),
    });
  } catch (error) {
    console.error("GET /api/performance/my/sheet error:", error);
    return NextResponse.json({ error: "실적 조회 실패" }, { status: 500 });
  }
}

// PUT /api/performance/my/sheet — 자동 저장 { year, quarter, content }
export async function PUT(request: NextRequest) {
  try {
    const sessionR = await requireSession();
    if (!sessionR.ok) return sessionR.response;
    const empR = requireEmployeeId(sessionR.session);
    if (!empR.ok) return empR.response;
    const { employeeId } = empR;

    const body = await request.json().catch(() => ({}));
    const yq = parseYearQuarter(body?.year, body?.quarter);
    if (!yq) return NextResponse.json({ error: BAD_QUARTER }, { status: 400 });
    const todayYmd = perfTodayYmd();
    if (isFutureQuarter(yq, todayYmd)) {
      return NextResponse.json({ error: FUTURE_QUARTER }, { status: 400 });
    }
    const content = sanitizeContent(body?.content) as Prisma.InputJsonObject;

    const save = () => prisma.$transaction(async (tx) => {
      const [sheet, cycle] = await Promise.all([
        tx.perfSheet.findUnique({
          where: { employeeId_year_quarter: { employeeId, ...yq } },
          select: { id: true, status: true },
        }),
        tx.perfCycle.findUnique({ where: { year_quarter: yq } }),
      ]);
      const access = getSheetAccess({
        ...yq,
        todayYmd,
        sheetStatus: sheet?.status ?? null,
        cycle: cycle ? cycleDates(cycle) : null,
        isTarget: cycle ? cycle.targetEmployeeIds.includes(employeeId) : false,
      });
      if (!access.canEdit) return { ok: false as const, reason: access.reason };

      if (!sheet) {
        const created = await tx.perfSheet.create({
          data: { employeeId, ...yq, formVersion: PERF_FORM_VERSION, content, status: "draft" },
          select: { status: true, updatedAt: true },
        });
        return { ok: true as const, sheet: created };
      }
      // 저장 사이에 제출된 경우를 막는다 (제출본 이후 content 덮어쓰기 금지)
      const now = new Date();
      const updated = await tx.perfSheet.updateMany({
        where: { id: sheet.id, status: { not: "submitted" } },
        data: { content, updatedAt: now },
      });
      if (updated.count === 0) {
        return { ok: false as const, reason: "제출한 실적은 수정할 수 없습니다." };
      }
      return { ok: true as const, sheet: { status: sheet.status, updatedAt: now } };
    });
    // 첫 저장 두 건이 동시에 들어와 같은 행을 만들려 하면(유니크 충돌) 한 번 더 시도 — 두 번째는 update 경로
    let result: Awaited<ReturnType<typeof save>>;
    try {
      result = await save();
    } catch (e) {
      if ((e as { code?: string })?.code !== "P2002") throw e;
      result = await save();
    }

    if (!result.ok) {
      return NextResponse.json({ error: result.reason ?? "수정할 수 없습니다." }, { status: 409 });
    }
    return NextResponse.json({
      status: effectiveSheetStatus(result.sheet.status, hasAnyContent(content)),
      updatedAt: result.sheet.updatedAt.toISOString(),
    });
  } catch (error) {
    console.error("PUT /api/performance/my/sheet error:", error);
    return NextResponse.json({ error: "실적 저장 실패" }, { status: 500 });
  }
}

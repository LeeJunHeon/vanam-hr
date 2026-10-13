import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@/app/generated/prisma/client";
import { requireSession } from "@/lib/auth-helpers";
import { PERF_FORM_VERSION, sanitizeContent, validateForSubmit } from "@/lib/performance/form";
import { checkQuarter, getSheetAccess, parseYearQuarter } from "@/lib/performance/rules";
import {
  cycleDates,
  loadEmployeeProfile,
  loadStartQuarter,
  perfTodayYmd,
  requireEmployeeId,
} from "@/lib/performance/server";

export const dynamic = "force-dynamic";

// POST /api/performance/my/submit — 제출 { year, quarter, content }
export async function POST(request: NextRequest) {
  try {
    const sessionR = await requireSession();
    if (!sessionR.ok) return sessionR.response;
    const empR = requireEmployeeId(sessionR.session);
    if (!empR.ok) return empR.response;
    const { employeeId } = empR;

    const body = await request.json().catch(() => ({}));
    const yq = parseYearQuarter(body?.year, body?.quarter);
    if (!yq) {
      return NextResponse.json({ error: "연도와 분기가 올바르지 않습니다." }, { status: 400 });
    }
    const todayYmd = perfTodayYmd();
    const quarterError = checkQuarter(yq, todayYmd, await loadStartQuarter());
    if (quarterError) return NextResponse.json({ error: quarterError }, { status: 400 });

    // 제출 순간의 프로필 — profile_snapshot 에 저장 (다시 제출하면 갱신)
    const profile = await loadEmployeeProfile(employeeId);

    const result = await prisma.$transaction(async (tx) => {
      const content = sanitizeContent(body?.content);
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
      if (!access.canSubmit) {
        return { kind: "conflict" as const, error: access.reason ?? "제출할 수 없습니다." };
      }
      // 받은 배열 그대로 검증 — 오류 행 번호가 화면 번호와 같게 (검증 안에서 칸별로 정리한다)
      const errors = validateForSubmit(body?.content);
      if (errors.length > 0) return { kind: "invalid" as const, errors };

      const now = new Date();
      const json = content as Prisma.InputJsonObject;
      const data = {
        formVersion: PERF_FORM_VERSION,
        content: json,
        submittedContent: json,
        profileSnapshot: { ...profile } as Prisma.InputJsonObject,
        status: "submitted",
        submittedAt: now,
        updatedAt: now,
      };
      let sheetId: number;
      if (sheet) {
        // 동시 제출 방지 — 아직 제출 상태가 아닐 때만
        const updated = await tx.perfSheet.updateMany({
          where: { id: sheet.id, status: { not: "submitted" } },
          data,
        });
        if (updated.count === 0) {
          return { kind: "conflict" as const, error: "이미 제출한 성과입니다." };
        }
        sheetId = sheet.id;
      } else {
        const created = await tx.perfSheet.create({
          data: { employeeId, ...yq, ...data },
          select: { id: true },
        });
        sheetId = created.id;
      }
      await tx.perfSheetLog.create({
        data: {
          sheetId,
          action: sheet?.status === "revision" ? "resubmit" : "submit",
          actorEmployeeId: employeeId,
        },
      });
      return { kind: "ok" as const, submittedAt: now };
    });

    if (result.kind === "conflict") {
      return NextResponse.json({ error: result.error }, { status: 409 });
    }
    if (result.kind === "invalid") {
      return NextResponse.json(
        { error: "입력하지 않은 항목이 있습니다.", errors: result.errors },
        { status: 400 }
      );
    }
    return NextResponse.json({
      status: "submitted",
      submittedAt: result.submittedAt.toISOString(),
    });
  } catch (error) {
    console.error("POST /api/performance/my/submit error:", error);
    return NextResponse.json({ error: "성과 제출 실패" }, { status: 500 });
  }
}

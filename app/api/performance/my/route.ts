import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/auth-helpers";
import { hasAnyContent } from "@/lib/performance/form";
import {
  effectiveSheetStatus,
  getSheetAccess,
  quarterKey,
  quarterLabel,
  quarterOfYmd,
  quartersBetween,
} from "@/lib/performance/rules";
import {
  cycleDates,
  cycleView,
  loadStartQuarter,
  perfTodayYmd,
  requireEmployeeId,
} from "@/lib/performance/server";

export const dynamic = "force-dynamic";

// GET /api/performance/my — 내 성과 분기 목록 + 기본 선택 분기
export async function GET() {
  try {
    const sessionR = await requireSession();
    if (!sessionR.ok) return sessionR.response;
    const empR = requireEmployeeId(sessionR.session);
    if (!empR.ok) return empR.response;
    const { employeeId } = empR;

    const todayYmd = perfTodayYmd();
    const current = quarterOfYmd(todayYmd);

    const [sheets, cycles, start] = await Promise.all([
      prisma.perfSheet.findMany({
        where: { employeeId },
        select: { year: true, quarter: true, status: true, content: true },
      }),
      prisma.perfCycle.findMany({
        select: { year: true, quarter: true, submitStart: true, submitEnd: true, targetEmployeeIds: true },
      }),
      loadStartQuarter(),
    ]);
    const sheetMap = new Map(sheets.map((s) => [quarterKey(s.year, s.quarter), s]));
    const cycleMap = new Map(cycles.map((c) => [quarterKey(c.year, c.quarter), c]));

    // 목록 = 성과 관리 시작 분기부터 오늘이 속한 분기까지 전부 (오래된 순).
    // 시작 분기가 오늘 분기보다 뒤면 빈 목록 — 화면이 "{시작 분기}부터 시작합니다"를 보여 준다.
    const list = quartersBetween(start, current);

    const quarters = list.map(({ year, quarter }) => {
      const key = quarterKey(year, quarter);
      const sheet = sheetMap.get(key);
      const cycle = cycleMap.get(key) ?? null;
      const access = getSheetAccess({
        year,
        quarter,
        todayYmd,
        sheetStatus: sheet?.status ?? null,
        cycle: cycle ? cycleDates(cycle) : null,
        isTarget: cycle ? cycle.targetEmployeeIds.includes(employeeId) : false,
      });
      return {
        year,
        quarter,
        label: quarterLabel(year, quarter),
        status: effectiveSheetStatus(sheet?.status, hasAnyContent(sheet?.content)),
        cycleState: cycle ? cycleView(cycle, todayYmd).state : null,
        canSubmit: access.canSubmit,
      };
    });

    // 기본 선택: 제출 가능한데 아직 안 낸 분기 → 수정 요청 분기 → 현재 분기 (같은 조건이면 최근 분기)
    const latestFirst = [...quarters].reverse();
    const pick =
      latestFirst.find((q) => q.canSubmit && (q.status === "none" || q.status === "draft")) ??
      latestFirst.find((q) => q.status === "revision") ??
      (list.length > 0 ? current : null);

    return NextResponse.json({
      quarters,
      defaultQuarter: pick ? { year: pick.year, quarter: pick.quarter } : null,
      startLabel: quarterLabel(start.year, start.quarter),
    });
  } catch (error) {
    console.error("GET /api/performance/my error:", error);
    return NextResponse.json({ error: "성과 목록 조회 실패" }, { status: 500 });
  }
}

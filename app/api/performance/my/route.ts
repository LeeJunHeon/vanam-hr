import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/auth-helpers";
import { hasAnyContent } from "@/lib/performance/form";
import {
  compareQuarter,
  effectiveSheetStatus,
  getSheetAccess,
  isFutureQuarter,
  prevQuarter,
  quarterKey,
  quarterLabel,
  quarterOfYmd,
  type YearQuarter,
} from "@/lib/performance/rules";
import { cycleDates, cycleView, perfTodayYmd, requireEmployeeId } from "@/lib/performance/server";

export const dynamic = "force-dynamic";

const MAX_QUARTERS = 8;

// GET /api/performance/my — 내 실적 분기 목록 + 기본 선택 분기
export async function GET() {
  try {
    const sessionR = await requireSession();
    if (!sessionR.ok) return sessionR.response;
    const empR = requireEmployeeId(sessionR.session);
    if (!empR.ok) return empR.response;
    const { employeeId } = empR;

    const todayYmd = perfTodayYmd();
    const current = quarterOfYmd(todayYmd);

    const [sheets, cycles] = await Promise.all([
      prisma.perfSheet.findMany({
        where: { employeeId },
        select: { year: true, quarter: true, status: true, content: true },
      }),
      prisma.perfCycle.findMany({
        select: { year: true, quarter: true, submitStart: true, submitEnd: true, targetEmployeeIds: true },
      }),
    ]);
    const sheetMap = new Map(sheets.map((s) => [quarterKey(s.year, s.quarter), s]));
    const cycleMap = new Map(cycles.map((c) => [quarterKey(c.year, c.quarter), c]));

    // 목록 = 현재 분기 + 직전 분기 + 내 실적표가 있는 분기 + 진행 전/진행 중 회차 분기
    const candidates: YearQuarter[] = [current, prevQuarter(current)];
    for (const s of sheets) candidates.push({ year: s.year, quarter: s.quarter });
    for (const c of cycles) {
      if (cycleView(c, todayYmd).state !== "closed") candidates.push({ year: c.year, quarter: c.quarter });
    }
    const unique = new Map<string, YearQuarter>();
    for (const q of candidates) {
      if (!isFutureQuarter(q, todayYmd)) unique.set(quarterKey(q.year, q.quarter), q);
    }
    const list = Array.from(unique.values())
      .sort(compareQuarter)
      .slice(-MAX_QUARTERS);

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
      current;

    return NextResponse.json({
      quarters,
      defaultQuarter: { year: pick.year, quarter: pick.quarter },
    });
  } catch (error) {
    console.error("GET /api/performance/my error:", error);
    return NextResponse.json({ error: "실적 목록 조회 실패" }, { status: 500 });
  }
}

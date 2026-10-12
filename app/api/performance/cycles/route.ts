import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth-helpers";
import {
  isFutureQuarter,
  isValidYmd,
  parseYearQuarter,
  prevQuarter,
  quarterKey,
  quarterLabel,
  quarterOfYmd,
} from "@/lib/performance/rules";
import {
  EMPLOYEE_ORDER,
  cycleView,
  loadSubmitDefaultDays,
  parseEmployeeIds,
  perfTodayYmd,
  ymdToDate,
} from "@/lib/performance/server";

export const dynamic = "force-dynamic";

// GET /api/performance/cycles — 회차 목록 + 새 회차 기본값 + 대상자 후보(재직자)
export async function GET() {
  try {
    const r = await requireAdmin();
    if (!r.ok) return r.response;

    const todayYmd = perfTodayYmd();
    const [cycles, submitDays, employees] = await Promise.all([
      prisma.perfCycle.findMany({ orderBy: [{ year: "desc" }, { quarter: "desc" }] }),
      loadSubmitDefaultDays(),
      prisma.employee.findMany({
        where: { isActive: true, isHrOnly: false },
        orderBy: EMPLOYEE_ORDER,
        select: { id: true, name: true, department: { select: { name: true } } },
      }),
    ]);

    // 회차별 제출 수 = 대상자 중 status 가 submitted 인 수
    const submitted =
      cycles.length === 0
        ? []
        : await prisma.perfSheet.findMany({
            where: {
              status: "submitted",
              OR: cycles.map((c) => ({ year: c.year, quarter: c.quarter })),
            },
            select: { employeeId: true, year: true, quarter: true },
          });

    const current = quarterOfYmd(todayYmd);
    const prev = prevQuarter(current);
    const hasPrevCycle = cycles.some((c) => c.year === prev.year && c.quarter === prev.quarter);
    const suggested = hasPrevCycle ? current : prev;

    return NextResponse.json({
      cycles: cycles.map((c) => {
        const targets = new Set(c.targetEmployeeIds);
        const key = quarterKey(c.year, c.quarter);
        return {
          id: c.id,
          year: c.year,
          quarter: c.quarter,
          label: quarterLabel(c.year, c.quarter),
          ...cycleView(c, todayYmd),
          targetCount: targets.size,
          submittedCount: submitted.filter(
            (s) => quarterKey(s.year, s.quarter) === key && targets.has(s.employeeId)
          ).length,
        };
      }),
      defaults: {
        todayYmd,
        submitDays,
        suggestedYear: suggested.year,
        suggestedQuarter: suggested.quarter,
      },
      employees: employees.map((e) => ({
        id: e.id,
        name: e.name,
        departmentName: e.department?.name ?? null,
      })),
    });
  } catch (error) {
    console.error("GET /api/performance/cycles error:", error);
    return NextResponse.json({ error: "회차 목록 조회 실패" }, { status: 500 });
  }
}

// POST /api/performance/cycles — 회차 만들기 { year, quarter, submitStart, submitEnd, targetEmployeeIds }
export async function POST(request: NextRequest) {
  try {
    const r = await requireAdmin();
    if (!r.ok) return r.response;
    const { session } = r;

    const body = await request.json().catch(() => ({}));
    const yq = parseYearQuarter(body?.year, body?.quarter);
    if (!yq) {
      return NextResponse.json({ error: "연도와 분기가 올바르지 않습니다." }, { status: 400 });
    }
    if (isFutureQuarter(yq, perfTodayYmd())) {
      return NextResponse.json(
        { error: "아직 시작하지 않은 분기의 회차는 만들 수 없습니다." },
        { status: 400 }
      );
    }
    const { submitStart, submitEnd } = body ?? {};
    if (!isValidYmd(submitStart) || !isValidYmd(submitEnd)) {
      return NextResponse.json({ error: "제출 기간 날짜가 올바르지 않습니다." }, { status: 400 });
    }
    if (submitStart > submitEnd) {
      return NextResponse.json(
        { error: "제출 시작일은 마감일보다 늦을 수 없습니다." },
        { status: 400 }
      );
    }
    const ids = parseEmployeeIds(body?.targetEmployeeIds);
    if (!ids || ids.length === 0) {
      return NextResponse.json({ error: "대상자를 1명 이상 선택해 주세요." }, { status: 400 });
    }
    const found = await prisma.employee.count({ where: { id: { in: ids } } });
    if (found !== ids.length) {
      return NextResponse.json({ error: "존재하지 않는 직원이 포함되어 있습니다." }, { status: 400 });
    }

    const dup = await prisma.perfCycle.findUnique({ where: { year_quarter: yq }, select: { id: true } });
    if (dup) {
      return NextResponse.json({ error: "이미 같은 분기 회차가 있습니다." }, { status: 409 });
    }

    const createdById = session.user.employeeId;
    const created = await prisma.perfCycle.create({
      data: {
        ...yq,
        submitStart: ymdToDate(submitStart),
        submitEnd: ymdToDate(submitEnd),
        targetEmployeeIds: ids,
        createdById: Number.isInteger(createdById) ? (createdById as number) : null,
      },
      select: { id: true },
    });
    return NextResponse.json({ id: created.id }, { status: 201 });
  } catch (error) {
    if ((error as { code?: string })?.code === "P2002") {
      return NextResponse.json({ error: "이미 같은 분기 회차가 있습니다." }, { status: 409 });
    }
    console.error("POST /api/performance/cycles error:", error);
    return NextResponse.json({ error: "회차 생성 실패" }, { status: 500 });
  }
}

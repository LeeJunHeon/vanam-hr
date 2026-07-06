import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/auth-helpers";
import { todayYmd } from "@/lib/dateUtils";

// 로그인한 직원 본인이 자기 시프트를 (관리자가 만든 활성 패턴 중에서) 선택/변경하는 API.
// 관리자 라우트(app/api/shifts, app/api/employee-shifts)와 분리되어 있으며 본인 것만 다룬다.
// body로 employeeId를 받지 않고 세션에서만 확정한다.

// @db.Date는 UTC 자정 Date로 오간다. 날짜 덧셈/뺄셈은 UTC 메서드로 일관되게.
function fmtDate(d: Date): string {
  return d.toISOString().split("T")[0];
}

function addDaysUTC(d: Date, days: number): Date {
  const r = new Date(d);
  r.setUTCDate(r.getUTCDate() + days);
  return r;
}

// 오늘 출근(check_in) 여부. attendedToday면 적용일은 내일, 아니면 오늘.
async function computeEffectiveDate(
  db: typeof prisma,
  employeeId: number,
  today: Date
): Promise<{ attendedToday: boolean; effectiveDate: Date }> {
  const daily = await db.attendanceDaily.findUnique({
    where: { employeeId_workDate: { employeeId, workDate: today } },
    select: { checkIn: true },
  });
  const attendedToday = !!daily?.checkIn;
  const effectiveDate = attendedToday ? addDaysUTC(today, 1) : today;
  return { attendedToday, effectiveDate };
}

// GET /api/my-shift — 본인 현재 시프트 + 선택 가능한 활성 패턴 목록
export async function GET() {
  try {
    const sessionR = await requireSession();
    if (!sessionR.ok) return sessionR.response;
    const { session } = sessionR;
    const employeeId = session.user.employeeId;
    if (!Number.isInteger(employeeId)) {
      return NextResponse.json(
        { error: "본인 직원 정보가 매핑되어 있지 않습니다." },
        { status: 403 }
      );
    }
    const empId = employeeId as number;

    // 오늘 KST 기준 (lib/dateUtils — 컨테이너 TZ=Asia/Seoul 설정 활용)
    const today = new Date(todayYmd() + "T00:00:00.000Z");

    const [currentEs, patterns, effective] = await Promise.all([
      prisma.employeeShift.findFirst({
        where: {
          employeeId: empId,
          startDate: { lte: today },
          OR: [{ endDate: null }, { endDate: { gte: today } }],
        },
        orderBy: { startDate: "desc" },
        include: {
          pattern: {
            select: {
              id: true,
              name: true,
              description: true,
              cycleDays: true,
              schedule: true,
            },
          },
        },
      }),
      prisma.shiftPattern.findMany({
        where: { isActive: true },
        orderBy: [{ name: "asc" }],
      }),
      computeEffectiveDate(prisma, empId, today),
    ]);

    const currentShift = currentEs
      ? {
          id: currentEs.pattern.id,
          name: currentEs.pattern.name,
          description: currentEs.pattern.description,
          cycleDays: currentEs.pattern.cycleDays,
          schedule: currentEs.pattern.schedule,
          startDate: fmtDate(currentEs.startDate),
        }
      : null;

    return NextResponse.json({
      currentShift,
      patterns: patterns.map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description,
        cycleDays: p.cycleDays,
        schedule: p.schedule,
      })),
      attendedToday: effective.attendedToday,
      effectiveDate: fmtDate(effective.effectiveDate),
    });
  } catch (error) {
    console.error("GET /api/my-shift error:", error);
    return NextResponse.json(
      { error: "본인 시프트 조회 실패" },
      { status: 500 }
    );
  }
}

// PUT /api/my-shift — body: { patternId } 본인 시프트를 활성 패턴으로 변경
export async function PUT(request: Request) {
  try {
    const sessionR = await requireSession();
    if (!sessionR.ok) return sessionR.response;
    const { session } = sessionR;
    const employeeId = session.user.employeeId;
    if (!Number.isInteger(employeeId)) {
      return NextResponse.json(
        { error: "본인 직원 정보가 매핑되어 있지 않습니다." },
        { status: 403 }
      );
    }
    const empId = employeeId as number;

    const body = await request.json();
    const patIdNum = Number(body?.patternId);
    if (!Number.isInteger(patIdNum)) {
      return NextResponse.json(
        { error: "유효한 시프트 패턴이 아닙니다." },
        { status: 400 }
      );
    }

    // 1. patternId가 활성 패턴인지 확인
    const pattern = await prisma.shiftPattern.findUnique({
      where: { id: patIdNum },
    });
    if (!pattern || !pattern.isActive) {
      return NextResponse.json(
        { error: "유효한 시프트 패턴이 아닙니다." },
        { status: 400 }
      );
    }

    // 2. 적용일은 서버에서 결정 (클라이언트 값 신뢰 금지)
    const today = new Date(todayYmd() + "T00:00:00.000Z");
    const { effectiveDate } = await computeEffectiveDate(prisma, empId, today);

    // 3. employee_shifts 갱신
    await prisma.$transaction(async (tx) => {
      const active = await tx.employeeShift.findFirst({
        where: { employeeId: empId, endDate: null },
        orderBy: { startDate: "desc" },
      });

      if (!active) {
        // 활성 시프트 없음 → 새 레코드 생성
        await tx.employeeShift.create({
          data: {
            employeeId: empId,
            patternId: patIdNum,
            startDate: effectiveDate,
            endDate: null,
          },
        });
        return;
      }

      if (active.startDate < effectiveDate) {
        // 기존 시프트를 적용일 전날까지로 마감하고 새 레코드 생성
        await tx.employeeShift.update({
          where: { id: active.id },
          data: { endDate: addDaysUTC(effectiveDate, -1) },
        });
        await tx.employeeShift.create({
          data: {
            employeeId: empId,
            patternId: patIdNum,
            startDate: effectiveDate,
            endDate: null,
          },
        });
        return;
      }

      // start_date == effectiveDate 또는 start_date > effectiveDate → patternId만 교체
      await tx.employeeShift.update({
        where: { id: active.id },
        data: { patternId: patIdNum },
      });
    });

    return NextResponse.json({
      ok: true,
      effectiveDate: fmtDate(effectiveDate),
      patternName: pattern.name,
    });
  } catch (error) {
    console.error("PUT /api/my-shift error:", error);
    return NextResponse.json(
      { error: "본인 시프트 변경 실패" },
      { status: 500 }
    );
  }
}

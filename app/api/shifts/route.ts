import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth-helpers";

// schedule 원소 형식
interface SchedulePoint {
  dayIndex: number;
  start: string | null;
  end: string | null;
  type: string;
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

// schedule 배열 검증 + 사용된 type 코드 집합 반환
async function validateSchedule(
  schedule: any,
  cycleDays: number
): Promise<{ ok: true; types: string[] } | { ok: false; error: string }> {
  if (!Array.isArray(schedule)) {
    return { ok: false, error: "schedule은 배열이어야 합니다." };
  }
  if (schedule.length !== cycleDays) {
    return {
      ok: false,
      error: `schedule 길이(${schedule.length})가 cycleDays(${cycleDays})와 일치하지 않습니다.`,
    };
  }
  const seenIndex = new Set<number>();
  const typeSet = new Set<string>();
  for (let i = 0; i < schedule.length; i++) {
    const p = schedule[i];
    if (!p || typeof p !== "object") {
      return { ok: false, error: `${i}번째 schedule 원소가 객체가 아닙니다.` };
    }
    if (
      typeof p.dayIndex !== "number" ||
      p.dayIndex < 0 ||
      p.dayIndex >= cycleDays ||
      !Number.isInteger(p.dayIndex)
    ) {
      return {
        ok: false,
        error: `${i}번째 schedule의 dayIndex가 0 ~ ${cycleDays - 1} 범위가 아닙니다.`,
      };
    }
    if (seenIndex.has(p.dayIndex)) {
      return {
        ok: false,
        error: `dayIndex ${p.dayIndex}가 중복됩니다.`,
      };
    }
    seenIndex.add(p.dayIndex);

    if (typeof p.type !== "string" || !p.type.trim()) {
      return { ok: false, error: `${i}번째 schedule의 type이 비어있습니다.` };
    }
    typeSet.add(p.type.trim());

    if (p.type === "off") {
      if (p.start !== null || p.end !== null) {
        return {
          ok: false,
          error: `${i}번째 schedule이 off인데 start/end가 null이 아닙니다.`,
        };
      }
    } else {
      if (typeof p.start !== "string" || !TIME_RE.test(p.start)) {
        return {
          ok: false,
          error: `${i}번째 schedule의 start "${p.start}"가 HH:MM 형식이 아닙니다.`,
        };
      }
      if (typeof p.end !== "string" || !TIME_RE.test(p.end)) {
        return {
          ok: false,
          error: `${i}번째 schedule의 end "${p.end}"가 HH:MM 형식이 아닙니다.`,
        };
      }
    }
  }
  return { ok: true, types: Array.from(typeSet) };
}

// shift_day_type lookup 활성 코드 검증
async function validateScheduleTypes(types: string[]): Promise<string | null> {
  const lookups = await prisma.codeLookup.findMany({
    where: {
      category: "shift_day_type",
      code: { in: types },
      isActive: true,
    },
    select: { code: true },
  });
  const validSet = new Set(lookups.map((l) => l.code));
  for (const t of types) {
    if (!validSet.has(t)) {
      return `유형 "${t}"이 유효하지 않습니다. 코드 룩업의 shift_day_type에서 활성 코드를 사용하세요.`;
    }
  }
  return null;
}

// GET /api/shifts?search=...&includeInactive=true
export async function GET(request: NextRequest) {
  try {
    const _auth = await requireAdmin();
    if (!_auth.ok) return _auth.response;

    const { searchParams } = new URL(request.url);
    const search = searchParams.get("search") || "";
    const includeInactive = searchParams.get("includeInactive") === "true";

    const where: any = {};
    if (!includeInactive) where.isActive = true;
    if (search) {
      where.OR = [
        { name: { contains: search, mode: "insensitive" } },
        { description: { contains: search, mode: "insensitive" } },
      ];
    }

    const patterns = await prisma.shiftPattern.findMany({
      where,
      orderBy: [{ name: "asc" }],
    });

    return NextResponse.json(
      patterns.map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description,
        cycleDays: p.cycleDays,
        schedule: p.schedule,
        isActive: p.isActive,
      }))
    );
  } catch (error) {
    console.error("GET /api/shifts error:", error);
    return NextResponse.json(
      { error: "시프트 패턴 조회 실패" },
      { status: 500 }
    );
  }
}

// POST /api/shifts — 시프트 패턴 추가
export async function POST(request: NextRequest) {
  try {
    const _auth = await requireAdmin();
    if (!_auth.ok) return _auth.response;

    const body = await request.json();
    const { name, description, cycleDays, schedule } = body;

    if (!name?.trim()) {
      return NextResponse.json(
        { error: "name은 필수입니다." },
        { status: 400 }
      );
    }
    if (
      typeof cycleDays !== "number" ||
      !Number.isInteger(cycleDays) ||
      cycleDays < 1
    ) {
      return NextResponse.json(
        { error: "cycleDays는 1 이상 정수여야 합니다." },
        { status: 400 }
      );
    }

    const scheduleResult = await validateSchedule(schedule, cycleDays);
    if (!scheduleResult.ok) {
      return NextResponse.json({ error: scheduleResult.error }, { status: 400 });
    }
    const typeErr = await validateScheduleTypes(scheduleResult.types);
    if (typeErr) {
      return NextResponse.json({ error: typeErr }, { status: 400 });
    }

    const exists = await prisma.shiftPattern.findUnique({
      where: { name: name.trim() },
    });
    if (exists) {
      return NextResponse.json(
        { error: `이름 "${name}"의 시프트 패턴이 이미 존재합니다.` },
        { status: 409 }
      );
    }

    const pattern = await prisma.shiftPattern.create({
      data: {
        name: name.trim(),
        description: description?.trim() || null,
        cycleDays,
        schedule,
      },
    });

    return NextResponse.json(
      {
        id: pattern.id,
        name: pattern.name,
        description: pattern.description,
        cycleDays: pattern.cycleDays,
        schedule: pattern.schedule,
        isActive: pattern.isActive,
      },
      { status: 201 }
    );
  } catch (error) {
    console.error("POST /api/shifts error:", error);
    return NextResponse.json(
      { error: "시프트 패턴 등록 실패" },
      { status: 500 }
    );
  }
}

// PUT /api/shifts?id=1 — 시프트 패턴 수정
export async function PUT(request: NextRequest) {
  try {
    const _auth = await requireAdmin();
    if (!_auth.ok) return _auth.response;

    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");
    if (!id) {
      return NextResponse.json({ error: "id 파라미터 필요" }, { status: 400 });
    }

    const body = await request.json();
    const { name, description, cycleDays, schedule, isActive } = body;

    const before = await prisma.shiftPattern.findUnique({
      where: { id: Number(id) },
    });
    if (!before) {
      return NextResponse.json(
        { error: "시프트 패턴을 찾을 수 없습니다." },
        { status: 404 }
      );
    }

    // name 중복 검사 (이름이 바뀌었을 때만)
    if (name !== undefined && name.trim() !== before.name) {
      const dup = await prisma.shiftPattern.findUnique({
        where: { name: name.trim() },
      });
      if (dup) {
        return NextResponse.json(
          { error: `이름 "${name}"의 시프트 패턴이 이미 존재합니다.` },
          { status: 409 }
        );
      }
    }

    // cycleDays 검증
    if (cycleDays !== undefined) {
      if (
        typeof cycleDays !== "number" ||
        !Number.isInteger(cycleDays) ||
        cycleDays < 1
      ) {
        return NextResponse.json(
          { error: "cycleDays는 1 이상 정수여야 합니다." },
          { status: 400 }
        );
      }
    }

    // schedule 일관성 검증
    if (schedule !== undefined) {
      const effectiveCycleDays =
        cycleDays !== undefined ? cycleDays : before.cycleDays;
      const scheduleResult = await validateSchedule(schedule, effectiveCycleDays);
      if (!scheduleResult.ok) {
        return NextResponse.json(
          { error: scheduleResult.error },
          { status: 400 }
        );
      }
      const typeErr = await validateScheduleTypes(scheduleResult.types);
      if (typeErr) {
        return NextResponse.json({ error: typeErr }, { status: 400 });
      }
    } else if (cycleDays !== undefined && cycleDays !== before.cycleDays) {
      // schedule은 갱신 안 하는데 cycleDays만 바꾸려는 경우 — 기존 schedule 길이와 다르면 차단
      const beforeSchedule = before.schedule as unknown;
      if (Array.isArray(beforeSchedule) && beforeSchedule.length !== cycleDays) {
        return NextResponse.json(
          {
            error: `cycleDays(${cycleDays})와 기존 schedule 길이(${beforeSchedule.length})가 일치하지 않습니다. schedule도 함께 갱신하세요.`,
          },
          { status: 400 }
        );
      }
    }

    const pattern = await prisma.shiftPattern.update({
      where: { id: Number(id) },
      data: {
        ...(name !== undefined && { name: name.trim() }),
        ...(description !== undefined && {
          description: description?.trim() || null,
        }),
        ...(cycleDays !== undefined && { cycleDays }),
        ...(schedule !== undefined && { schedule }),
        ...(isActive !== undefined && { isActive: Boolean(isActive) }),
      },
    });

    return NextResponse.json({
      id: pattern.id,
      name: pattern.name,
      description: pattern.description,
      cycleDays: pattern.cycleDays,
      schedule: pattern.schedule,
      isActive: pattern.isActive,
    });
  } catch (error) {
    console.error("PUT /api/shifts error:", error);
    return NextResponse.json(
      { error: "시프트 패턴 수정 실패" },
      { status: 500 }
    );
  }
}

// DELETE /api/shifts?id=1 — 시프트 패턴 삭제
export async function DELETE(request: NextRequest) {
  try {
    const _auth = await requireAdmin();
    if (!_auth.ok) return _auth.response;

    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");
    if (!id) {
      return NextResponse.json({ error: "id 파라미터 필요" }, { status: 400 });
    }

    const target = await prisma.shiftPattern.findUnique({
      where: { id: Number(id) },
    });
    if (!target) {
      return NextResponse.json(
        { error: "시프트 패턴을 찾을 수 없습니다." },
        { status: 404 }
      );
    }

    // 참조 무결성 — employee_shifts / attendance_daily 사용 중 확인
    const [empShiftCount, dailyCount] = await Promise.all([
      prisma.employeeShift.count({ where: { patternId: Number(id) } }),
      prisma.attendanceDaily.count({ where: { shiftPatternId: Number(id) } }),
    ]);

    if (empShiftCount > 0 || dailyCount > 0) {
      const refs: string[] = [];
      if (empShiftCount > 0) refs.push(`직원 배정 ${empShiftCount}건`);
      if (dailyCount > 0) refs.push(`일별 근태 ${dailyCount}건`);
      return NextResponse.json(
        {
          error: `이 시프트 패턴을 사용 중입니다 (${refs.join(", ")}). 비활성 처리를 사용하세요.`,
        },
        { status: 409 }
      );
    }

    await prisma.shiftPattern.delete({ where: { id: Number(id) } });

    return NextResponse.json({ message: "시프트 패턴이 삭제되었습니다." });
  } catch (error) {
    console.error("DELETE /api/shifts error:", error);
    return NextResponse.json(
      { error: "시프트 패턴 삭제 실패" },
      { status: 500 }
    );
  }
}

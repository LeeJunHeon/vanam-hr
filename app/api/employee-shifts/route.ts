import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth-helpers";

// YYYY-MM-DD 문자열을 Date로 변환
function parseDate(s: string | null | undefined): Date | null {
  if (!s) return null;
  if (typeof s !== "string") return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(s + "T00:00:00.000Z");
  if (isNaN(d.getTime())) return null;
  return d;
}

function fmtDate(d: Date | null | undefined): string | null {
  if (!d) return null;
  return d.toISOString().split("T")[0];
}

// GET /api/employee-shifts?employeeId=N&activeOnly=true
// 전체 직원-시프트 배정 조회 (관리자)
export async function GET(request: NextRequest) {
  try {
    const _auth = await requireAdmin();
    if (!_auth.ok) return _auth.response;

    const { searchParams } = new URL(request.url);
    const employeeIdRaw = searchParams.get("employeeId");
    const activeOnly = searchParams.get("activeOnly") === "true";

    const where: Record<string, unknown> = {};
    if (employeeIdRaw) {
      const v = Number(employeeIdRaw);
      if (Number.isInteger(v)) where.employeeId = v;
    }
    if (activeOnly) {
      // 오늘 이전 시작 + (종료 없음 또는 오늘 이후 종료)
      const today = new Date();
      const todayDate = new Date(
        today.getFullYear(),
        today.getMonth(),
        today.getDate()
      );
      where.startDate = { lte: todayDate };
      where.OR = [
        { endDate: null },
        { endDate: { gte: todayDate } },
      ];
    }

    const assignments = await prisma.employeeShift.findMany({
      where,
      orderBy: [{ employeeId: "asc" }, { startDate: "desc" }],
      include: {
        employee: {
          select: {
            id: true,
            employeeNo: true,
            name: true,
            department: { select: { name: true } },
          },
        },
        pattern: {
          select: {
            id: true,
            name: true,
            description: true,
            isActive: true,
          },
        },
      },
    });

    return NextResponse.json(
      assignments.map((a) => ({
        id: a.id,
        employeeId: a.employeeId,
        employeeNo: a.employee.employeeNo,
        employeeName: a.employee.name,
        departmentName: a.employee.department?.name ?? null,
        patternId: a.patternId,
        patternName: a.pattern.name,
        patternDescription: a.pattern.description,
        patternIsActive: a.pattern.isActive,
        startDate: fmtDate(a.startDate),
        endDate: fmtDate(a.endDate),
      }))
    );
  } catch (error) {
    console.error("GET /api/employee-shifts error:", error);
    return NextResponse.json(
      { error: "시프트 배정 조회 실패" },
      { status: 500 }
    );
  }
}

// POST /api/employee-shifts
// body: { employeeId, patternId, startDate, endDate? }
export async function POST(request: NextRequest) {
  try {
    const _auth = await requireAdmin();
    if (!_auth.ok) return _auth.response;

    const body = await request.json();
    const { employeeId, patternId, startDate, endDate } = body;

    if (!employeeId || !patternId || !startDate) {
      return NextResponse.json(
        { error: "employeeId, patternId, startDate는 필수입니다." },
        { status: 400 }
      );
    }

    const empIdNum = Number(employeeId);
    const patIdNum = Number(patternId);
    if (!Number.isInteger(empIdNum) || !Number.isInteger(patIdNum)) {
      return NextResponse.json(
        { error: "employeeId, patternId는 정수여야 합니다." },
        { status: 400 }
      );
    }

    const startDateDate = parseDate(startDate);
    if (!startDateDate) {
      return NextResponse.json(
        { error: "startDate 형식이 잘못되었습니다 (YYYY-MM-DD)." },
        { status: 400 }
      );
    }

    let endDateDate: Date | null = null;
    if (endDate) {
      endDateDate = parseDate(endDate);
      if (!endDateDate) {
        return NextResponse.json(
          { error: "endDate 형식이 잘못되었습니다 (YYYY-MM-DD)." },
          { status: 400 }
        );
      }
      if (endDateDate < startDateDate) {
        return NextResponse.json(
          { error: "endDate는 startDate 이후여야 합니다." },
          { status: 400 }
        );
      }
    }

    // 검증: 직원/패턴 존재
    const [emp, pat] = await Promise.all([
      prisma.employee.findUnique({ where: { id: empIdNum } }),
      prisma.shiftPattern.findUnique({ where: { id: patIdNum } }),
    ]);
    if (!emp) {
      return NextResponse.json(
        { error: `직원 id ${empIdNum}를 찾을 수 없습니다.` },
        { status: 400 }
      );
    }
    if (!pat) {
      return NextResponse.json(
        { error: `시프트 패턴 id ${patIdNum}를 찾을 수 없습니다.` },
        { status: 400 }
      );
    }

    const created = await prisma.employeeShift.create({
      data: {
        employeeId: empIdNum,
        patternId: patIdNum,
        startDate: startDateDate,
        endDate: endDateDate,
      },
    });

    return NextResponse.json(
      {
        id: created.id,
        employeeId: created.employeeId,
        patternId: created.patternId,
        startDate: fmtDate(created.startDate),
        endDate: fmtDate(created.endDate),
      },
      { status: 201 }
    );
  } catch (error) {
    console.error("POST /api/employee-shifts error:", error);
    return NextResponse.json(
      { error: "시프트 배정 등록 실패" },
      { status: 500 }
    );
  }
}

// PUT /api/employee-shifts?id=N
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
    const { patternId, startDate, endDate } = body;

    const before = await prisma.employeeShift.findUnique({
      where: { id: Number(id) },
    });
    if (!before) {
      return NextResponse.json(
        { error: "시프트 배정을 찾을 수 없습니다." },
        { status: 404 }
      );
    }

    // patternId 검증
    let patternIdUpdate: number | undefined = undefined;
    if (patternId !== undefined) {
      const v = Number(patternId);
      if (!Number.isInteger(v)) {
        return NextResponse.json(
          { error: "patternId는 정수여야 합니다." },
          { status: 400 }
        );
      }
      const pat = await prisma.shiftPattern.findUnique({ where: { id: v } });
      if (!pat) {
        return NextResponse.json(
          { error: `시프트 패턴 id ${v}를 찾을 수 없습니다.` },
          { status: 400 }
        );
      }
      patternIdUpdate = v;
    }

    // startDate 검증
    let startDateUpdate: Date | undefined = undefined;
    if (startDate !== undefined) {
      const parsed = parseDate(startDate);
      if (!parsed) {
        return NextResponse.json(
          { error: "startDate 형식이 잘못되었습니다 (YYYY-MM-DD)." },
          { status: 400 }
        );
      }
      startDateUpdate = parsed;
    }

    // endDate 검증
    let endDateUpdate: Date | null | undefined = undefined;
    if (endDate !== undefined) {
      if (endDate === null || endDate === "") {
        endDateUpdate = null;
      } else {
        const parsed = parseDate(endDate);
        if (!parsed) {
          return NextResponse.json(
            { error: "endDate 형식이 잘못되었습니다 (YYYY-MM-DD)." },
            { status: 400 }
          );
        }
        const effectiveStart = startDateUpdate ?? before.startDate;
        if (parsed < effectiveStart) {
          return NextResponse.json(
            { error: "endDate는 startDate 이후여야 합니다." },
            { status: 400 }
          );
        }
        endDateUpdate = parsed;
      }
    }

    const updated = await prisma.employeeShift.update({
      where: { id: Number(id) },
      data: {
        ...(patternIdUpdate !== undefined && { patternId: patternIdUpdate }),
        ...(startDateUpdate !== undefined && { startDate: startDateUpdate }),
        ...(endDateUpdate !== undefined && { endDate: endDateUpdate }),
      },
    });

    return NextResponse.json({
      id: updated.id,
      employeeId: updated.employeeId,
      patternId: updated.patternId,
      startDate: fmtDate(updated.startDate),
      endDate: fmtDate(updated.endDate),
    });
  } catch (error) {
    console.error("PUT /api/employee-shifts error:", error);
    return NextResponse.json(
      { error: "시프트 배정 수정 실패" },
      { status: 500 }
    );
  }
}

// DELETE /api/employee-shifts?id=N
export async function DELETE(request: NextRequest) {
  try {
    const _auth = await requireAdmin();
    if (!_auth.ok) return _auth.response;

    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");
    if (!id) {
      return NextResponse.json({ error: "id 파라미터 필요" }, { status: 400 });
    }

    const target = await prisma.employeeShift.findUnique({
      where: { id: Number(id) },
    });
    if (!target) {
      return NextResponse.json(
        { error: "시프트 배정을 찾을 수 없습니다." },
        { status: 404 }
      );
    }

    await prisma.employeeShift.delete({ where: { id: Number(id) } });

    return NextResponse.json({ message: "시프트 배정이 삭제되었습니다." });
  } catch (error) {
    console.error("DELETE /api/employee-shifts error:", error);
    return NextResponse.json(
      { error: "시프트 배정 삭제 실패" },
      { status: 500 }
    );
  }
}

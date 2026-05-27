import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth-helpers";

// YYYY-MM-DD 문자열을 Date로 변환 (잘못된 형식이면 null)
function parseDate(s: string | null | undefined): Date | null {
  if (!s) return null;
  if (typeof s !== "string") return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(s + "T00:00:00.000Z");
  if (isNaN(d.getTime())) return null;
  return d;
}

// Date를 "YYYY-MM-DD"로 (UTC 기준)
function fmtDate(d: Date | null | undefined): string | null {
  if (!d) return null;
  return d.toISOString().split("T")[0];
}

// GET /api/employees?search=...&departmentId=...&positionId=...&includeInactive=true
export async function GET(request: NextRequest) {
  try {
    const _auth = await requireAdmin();
    if (!_auth.ok) return _auth.response;

    const { searchParams } = new URL(request.url);
    const search = searchParams.get("search") || "";
    const departmentIdRaw = searchParams.get("departmentId");
    const positionIdRaw = searchParams.get("positionId");
    const includeInactive = searchParams.get("includeInactive") === "true";

    const where: any = {};
    if (!includeInactive) where.isActive = true;
    if (search) {
      where.OR = [
        { employeeNo: { contains: search, mode: "insensitive" } },
        { name: { contains: search, mode: "insensitive" } },
        { email: { contains: search, mode: "insensitive" } },
      ];
    }
    if (departmentIdRaw) {
      const v = Number(departmentIdRaw);
      if (Number.isInteger(v)) where.departmentId = v;
    }
    if (positionIdRaw) {
      const v = Number(positionIdRaw);
      if (Number.isInteger(v)) where.positionId = v;
    }

    const employees = await prisma.employee.findMany({
      where,
      orderBy: [{ employeeNo: "asc" }],
      include: {
        department: { select: { id: true, code: true, name: true } },
        position: { select: { id: true, code: true, name: true } },
      },
    });

    return NextResponse.json(
      employees.map((e) => ({
        id: e.id,
        employeeNo: e.employeeNo,
        userId: e.userId,
        name: e.name,
        email: e.email,
        departmentId: e.departmentId,
        departmentCode: e.department?.code ?? null,
        departmentName: e.department?.name ?? null,
        positionId: e.positionId,
        positionCode: e.position?.code ?? null,
        positionName: e.position?.name ?? null,
        phone: e.phone,
        hiredAt: fmtDate(e.hiredAt),
        resignedAt: fmtDate(e.resignedAt),
        isActive: e.isActive,
        note: e.note,
      }))
    );
  } catch (error) {
    console.error("GET /api/employees error:", error);
    return NextResponse.json({ error: "직원 조회 실패" }, { status: 500 });
  }
}

// POST /api/employees — 직원 추가
export async function POST(request: NextRequest) {
  try {
    const _auth = await requireAdmin();
    if (!_auth.ok) return _auth.response;

    const body = await request.json();
    const {
      employeeNo,
      userId,
      name,
      email,
      departmentId,
      positionId,
      phone,
      hiredAt,
      resignedAt,
      note,
    } = body;

    if (!name?.trim()) {
      return NextResponse.json(
        { error: "이름은 필수입니다." },
        { status: 400 }
      );
    }
    if (!positionId || positionId === "" || positionId === null) {
      return NextResponse.json(
        { error: "직급은 필수입니다." },
        { status: 400 }
      );
    }

    // hiredAt: 빈 값 / null / undefined 모두 허용 (선택 입력)
    let hiredAtDate: Date | null = null;
    if (hiredAt) {
      hiredAtDate = parseDate(hiredAt);
      if (!hiredAtDate) {
        return NextResponse.json(
          { error: "입사일 형식이 잘못되었습니다 (YYYY-MM-DD)." },
          { status: 400 }
        );
      }
    }

    let resignedAtDate: Date | null = null;
    if (resignedAt) {
      resignedAtDate = parseDate(resignedAt);
      if (!resignedAtDate) {
        return NextResponse.json(
          { error: "퇴사일 형식이 잘못되었습니다 (YYYY-MM-DD)." },
          { status: 400 }
        );
      }
      // 입사일이 있을 때만 비교
      if (hiredAtDate && resignedAtDate < hiredAtDate) {
        return NextResponse.json(
          { error: "퇴사일은 입사일 이후여야 합니다." },
          { status: 400 }
        );
      }
    }

    // 사번 중복 — 사번이 있을 때만 검사
    if (employeeNo?.trim()) {
      const exists = await prisma.employee.findUnique({
        where: { employeeNo: employeeNo.trim() },
      });
      if (exists) {
        return NextResponse.json(
          { error: `사번 "${employeeNo}"가 이미 존재합니다.` },
          { status: 409 }
        );
      }
    }

    // userId 검증
    let userIdNum: number | null = null;
    if (userId !== undefined && userId !== null && userId !== "") {
      userIdNum = Number(userId);
      if (!Number.isInteger(userIdNum)) {
        return NextResponse.json(
          { error: "userId는 정수여야 합니다." },
          { status: 400 }
        );
      }
      const user = await prisma.user.findUnique({ where: { id: userIdNum } });
      if (!user || user.isActive !== "Y") {
        return NextResponse.json(
          { error: `SSO 사용자 id ${userIdNum}가 존재하지 않거나 비활성입니다.` },
          { status: 400 }
        );
      }
      const dupMap = await prisma.employee.findUnique({
        where: { userId: userIdNum },
      });
      if (dupMap) {
        return NextResponse.json(
          {
            error: `이미 다른 직원(${dupMap.employeeNo} / ${dupMap.name})에게 매핑된 사용자입니다.`,
          },
          { status: 409 }
        );
      }
    }

    // departmentId 검증
    let departmentIdNum: number | null = null;
    if (departmentId !== undefined && departmentId !== null && departmentId !== "") {
      departmentIdNum = Number(departmentId);
      if (!Number.isInteger(departmentIdNum)) {
        return NextResponse.json(
          { error: "departmentId는 정수여야 합니다." },
          { status: 400 }
        );
      }
      const dept = await prisma.department.findUnique({
        where: { id: departmentIdNum },
      });
      if (!dept) {
        return NextResponse.json(
          { error: `부서 id ${departmentIdNum}를 찾을 수 없습니다.` },
          { status: 400 }
        );
      }
    }

    // positionId 검증
    let positionIdNum: number | null = null;
    if (positionId !== undefined && positionId !== null && positionId !== "") {
      positionIdNum = Number(positionId);
      if (!Number.isInteger(positionIdNum)) {
        return NextResponse.json(
          { error: "positionId는 정수여야 합니다." },
          { status: 400 }
        );
      }
      const pos = await prisma.position.findUnique({
        where: { id: positionIdNum },
      });
      if (!pos) {
        return NextResponse.json(
          { error: `직급 id ${positionIdNum}를 찾을 수 없습니다.` },
          { status: 400 }
        );
      }
    }

    const emp = await prisma.employee.create({
      data: {
        employeeNo: employeeNo?.trim() || null,
        userId: userIdNum,
        name: name.trim(),
        email: email?.trim() || null,
        departmentId: departmentIdNum,
        positionId: positionIdNum,
        phone: phone?.trim() || null,
        hiredAt: hiredAtDate,
        resignedAt: resignedAtDate,
        note: note?.trim() || null,
      },
      include: {
        department: { select: { id: true, code: true, name: true } },
        position: { select: { id: true, code: true, name: true } },
      },
    });

    return NextResponse.json(
      {
        id: emp.id,
        employeeNo: emp.employeeNo,
        userId: emp.userId,
        name: emp.name,
        email: emp.email,
        departmentId: emp.departmentId,
        departmentCode: emp.department?.code ?? null,
        departmentName: emp.department?.name ?? null,
        positionId: emp.positionId,
        positionCode: emp.position?.code ?? null,
        positionName: emp.position?.name ?? null,
        phone: emp.phone,
        hiredAt: fmtDate(emp.hiredAt),
        resignedAt: fmtDate(emp.resignedAt),
        isActive: emp.isActive,
        note: emp.note,
      },
      { status: 201 }
    );
  } catch (error) {
    console.error("POST /api/employees error:", error);
    return NextResponse.json({ error: "직원 등록 실패" }, { status: 500 });
  }
}

// PUT /api/employees?id=1 — 직원 수정
export async function PUT(request: NextRequest) {
  try {
    const _auth = await requireAdmin();
    if (!_auth.ok) return _auth.response;

    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");
    if (!id) {
      return NextResponse.json({ error: "id 파라미터 필요" }, { status: 400 });
    }
    const idNum = Number(id);

    const body = await request.json();
    const {
      employeeNo,
      userId,
      name,
      email,
      departmentId,
      positionId,
      phone,
      hiredAt,
      resignedAt,
      note,
      isActive,
    } = body;

    const before = await prisma.employee.findUnique({ where: { id: idNum } });
    if (!before) {
      return NextResponse.json(
        { error: "직원을 찾을 수 없습니다." },
        { status: 404 }
      );
    }

    // employeeNo 중복 검증 (변경되었을 때만)
    let employeeNoUpdate: string | null | undefined = undefined;
    if (employeeNo !== undefined) {
      const trimmed = (employeeNo ?? "").trim();
      if (trimmed === "") {
        employeeNoUpdate = null;
      } else if (trimmed !== before.employeeNo) {
        const dup = await prisma.employee.findUnique({
          where: { employeeNo: trimmed },
        });
        if (dup && dup.id !== idNum) {
          return NextResponse.json(
            { error: `사번 "${trimmed}"가 이미 존재합니다.` },
            { status: 409 }
          );
        }
        employeeNoUpdate = trimmed;
      } else {
        employeeNoUpdate = trimmed;
      }
    }

    // userId 검증
    let userIdUpdate: number | null | undefined = undefined;
    if (userId !== undefined) {
      if (userId === null || userId === "") {
        userIdUpdate = null;
      } else {
        const userIdNum = Number(userId);
        if (!Number.isInteger(userIdNum)) {
          return NextResponse.json(
            { error: "userId는 정수여야 합니다." },
            { status: 400 }
          );
        }
        const user = await prisma.user.findUnique({
          where: { id: userIdNum },
        });
        if (!user || user.isActive !== "Y") {
          return NextResponse.json(
            {
              error: `SSO 사용자 id ${userIdNum}가 존재하지 않거나 비활성입니다.`,
            },
            { status: 400 }
          );
        }
        // 다른 employee에 매핑되어 있는지
        const dupMap = await prisma.employee.findUnique({
          where: { userId: userIdNum },
        });
        if (dupMap && dupMap.id !== idNum) {
          return NextResponse.json(
            {
              error: `이미 다른 직원(${dupMap.employeeNo} / ${dupMap.name})에게 매핑된 사용자입니다.`,
            },
            { status: 409 }
          );
        }
        userIdUpdate = userIdNum;
      }
    }

    // departmentId 검증
    let departmentIdUpdate: number | null | undefined = undefined;
    if (departmentId !== undefined) {
      if (departmentId === null || departmentId === "") {
        departmentIdUpdate = null;
      } else {
        const v = Number(departmentId);
        if (!Number.isInteger(v)) {
          return NextResponse.json(
            { error: "departmentId는 정수여야 합니다." },
            { status: 400 }
          );
        }
        const dept = await prisma.department.findUnique({ where: { id: v } });
        if (!dept) {
          return NextResponse.json(
            { error: `부서 id ${v}를 찾을 수 없습니다.` },
            { status: 400 }
          );
        }
        departmentIdUpdate = v;
      }
    }

    // positionId 검증
    let positionIdUpdate: number | null | undefined = undefined;
    if (positionId !== undefined) {
      if (positionId === null || positionId === "") {
        positionIdUpdate = null;
      } else {
        const v = Number(positionId);
        if (!Number.isInteger(v)) {
          return NextResponse.json(
            { error: "positionId는 정수여야 합니다." },
            { status: 400 }
          );
        }
        const pos = await prisma.position.findUnique({ where: { id: v } });
        if (!pos) {
          return NextResponse.json(
            { error: `직급 id ${v}를 찾을 수 없습니다.` },
            { status: 400 }
          );
        }
        positionIdUpdate = v;
      }
    }

    // hiredAt 검증 — null/빈 문자열 허용
    let hiredAtUpdate: Date | null | undefined = undefined;
    if (hiredAt !== undefined) {
      if (hiredAt === null || hiredAt === "") {
        hiredAtUpdate = null;
      } else {
        const parsed = parseDate(hiredAt);
        if (!parsed) {
          return NextResponse.json(
            { error: "입사일 형식이 잘못되었습니다 (YYYY-MM-DD)." },
            { status: 400 }
          );
        }
        hiredAtUpdate = parsed;
      }
    }

    // resignedAt 검증 + 입사일 이후 체크
    let resignedAtUpdate: Date | null | undefined = undefined;
    if (resignedAt !== undefined) {
      if (resignedAt === null || resignedAt === "") {
        resignedAtUpdate = null;
      } else {
        const parsed = parseDate(resignedAt);
        if (!parsed) {
          return NextResponse.json(
            { error: "퇴사일 형식이 잘못되었습니다 (YYYY-MM-DD)." },
            { status: 400 }
          );
        }
        // 입사일이 있는 경우에만 비교
        const effectiveHired = hiredAtUpdate !== undefined ? hiredAtUpdate : before.hiredAt;
        if (effectiveHired && parsed < effectiveHired) {
          return NextResponse.json(
            { error: "퇴사일은 입사일 이후여야 합니다." },
            { status: 400 }
          );
        }
        resignedAtUpdate = parsed;
      }
    } else if (hiredAtUpdate) {
      // hiredAt만 바뀌고 resignedAt은 안 바뀐 경우, 기존 resignedAt이 새 hiredAt보다 이전이면 차단
      if (before.resignedAt && before.resignedAt < hiredAtUpdate) {
        return NextResponse.json(
          {
            error: "변경한 입사일이 기존 퇴사일보다 이후입니다. 퇴사일도 함께 갱신하세요.",
          },
          { status: 400 }
        );
      }
    }

    const emp = await prisma.employee.update({
      where: { id: idNum },
      data: {
        ...(employeeNoUpdate !== undefined && { employeeNo: employeeNoUpdate }),
        ...(userIdUpdate !== undefined && { userId: userIdUpdate }),
        ...(name !== undefined && { name: name.trim() }),
        ...(email !== undefined && { email: email?.trim() || null }),
        ...(departmentIdUpdate !== undefined && { departmentId: departmentIdUpdate }),
        ...(positionIdUpdate !== undefined && { positionId: positionIdUpdate }),
        ...(phone !== undefined && { phone: phone?.trim() || null }),
        ...(hiredAtUpdate !== undefined && { hiredAt: hiredAtUpdate }),
        ...(resignedAtUpdate !== undefined && { resignedAt: resignedAtUpdate }),
        ...(note !== undefined && { note: note?.trim() || null }),
        ...(isActive !== undefined && { isActive: Boolean(isActive) }),
      },
      include: {
        department: { select: { id: true, code: true, name: true } },
        position: { select: { id: true, code: true, name: true } },
      },
    });

    return NextResponse.json({
      id: emp.id,
      employeeNo: emp.employeeNo,
      userId: emp.userId,
      name: emp.name,
      email: emp.email,
      departmentId: emp.departmentId,
      departmentCode: emp.department?.code ?? null,
      departmentName: emp.department?.name ?? null,
      positionId: emp.positionId,
      positionCode: emp.position?.code ?? null,
      positionName: emp.position?.name ?? null,
      phone: emp.phone,
      hiredAt: fmtDate(emp.hiredAt),
      resignedAt: fmtDate(emp.resignedAt),
      isActive: emp.isActive,
      note: emp.note,
    });
  } catch (error) {
    console.error("PUT /api/employees error:", error);
    return NextResponse.json({ error: "직원 수정 실패" }, { status: 500 });
  }
}

// DELETE /api/employees?id=1
export async function DELETE(request: NextRequest) {
  try {
    const _auth = await requireAdmin();
    if (!_auth.ok) return _auth.response;

    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");
    if (!id) {
      return NextResponse.json({ error: "id 파라미터 필요" }, { status: 400 });
    }
    const idNum = Number(id);

    const target = await prisma.employee.findUnique({ where: { id: idNum } });
    if (!target) {
      return NextResponse.json(
        { error: "직원을 찾을 수 없습니다." },
        { status: 404 }
      );
    }

    const [
      deviceCount,
      shiftCount,
      dailyCount,
      requestCount,
      primaryCount,
      deputyCount,
    ] = await Promise.all([
      prisma.device.count({ where: { employeeId: idNum } }),
      prisma.employeeShift.count({ where: { employeeId: idNum } }),
      prisma.attendanceDaily.count({ where: { employeeId: idNum } }),
      prisma.attendanceRequest.count({ where: { employeeId: idNum } }),
      prisma.approvalLine.count({ where: { primaryApproverId: idNum } }),
      prisma.approvalLine.count({ where: { deputyApproverId: idNum } }),
    ]);

    if (
      deviceCount > 0 ||
      shiftCount > 0 ||
      dailyCount > 0 ||
      requestCount > 0 ||
      primaryCount > 0 ||
      deputyCount > 0
    ) {
      const refs: string[] = [];
      if (deviceCount > 0) refs.push(`디바이스 ${deviceCount}건`);
      if (shiftCount > 0) refs.push(`시프트 배정 ${shiftCount}건`);
      if (dailyCount > 0) refs.push(`일별 근태 ${dailyCount}건`);
      if (requestCount > 0) refs.push(`결재 요청 ${requestCount}건`);
      if (primaryCount > 0) refs.push(`결재선(메인) ${primaryCount}건`);
      if (deputyCount > 0) refs.push(`결재선(대리) ${deputyCount}건`);
      return NextResponse.json(
        {
          error: `이 직원을 사용 중입니다 (${refs.join(", ")}). 비활성 처리를 사용하세요.`,
        },
        { status: 409 }
      );
    }

    await prisma.employee.delete({ where: { id: idNum } });

    return NextResponse.json({ message: "직원이 삭제되었습니다." });
  } catch (error) {
    console.error("DELETE /api/employees error:", error);
    return NextResponse.json({ error: "직원 삭제 실패" }, { status: 500 });
  }
}

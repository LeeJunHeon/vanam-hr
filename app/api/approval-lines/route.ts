import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth-helpers";

// 직원 활성 검증 헬퍼
async function validateActiveEmployee(
  id: number,
  label: string
): Promise<string | null> {
  const emp = await prisma.employee.findUnique({ where: { id } });
  if (!emp) return `${label} 직원 id ${id}를 찾을 수 없습니다.`;
  if (!emp.isActive) return `${label} 직원이 비활성 상태입니다.`;
  return null;
}

// GET /api/approval-lines?search=...
export async function GET(request: NextRequest) {
  try {
    const _auth = await requireAdmin();
    if (!_auth.ok) return _auth.response;

    const { searchParams } = new URL(request.url);
    const search = searchParams.get("search") || "";

    const where: any = {};
    if (search) {
      where.OR = [
        { department: { code: { contains: search, mode: "insensitive" } } },
        { department: { name: { contains: search, mode: "insensitive" } } },
        {
          primaryApprover: {
            name: { contains: search, mode: "insensitive" },
          },
        },
      ];
    }

    const lines = await prisma.approvalLine.findMany({
      where,
      orderBy: [{ department: { sortOrder: "asc" } }],
      include: {
        department: { select: { id: true, code: true, name: true } },
        primaryApprover: {
          select: { id: true, employeeNo: true, name: true },
        },
        deputyApprover: {
          select: { id: true, employeeNo: true, name: true },
        },
      },
    });

    return NextResponse.json(
      lines.map((l) => ({
        id: l.id,
        departmentId: l.departmentId,
        departmentCode: l.department.code,
        departmentName: l.department.name,
        primaryApproverId: l.primaryApproverId,
        primaryApproverNo: l.primaryApprover.employeeNo,
        primaryApproverName: l.primaryApprover.name,
        deputyApproverId: l.deputyApproverId,
        deputyApproverNo: l.deputyApprover?.employeeNo ?? null,
        deputyApproverName: l.deputyApprover?.name ?? null,
        autoDelegateHours: l.autoDelegateHours,
      }))
    );
  } catch (error) {
    console.error("GET /api/approval-lines error:", error);
    return NextResponse.json(
      { error: "결재선 조회 실패" },
      { status: 500 }
    );
  }
}

// POST /api/approval-lines
export async function POST(request: NextRequest) {
  try {
    const _auth = await requireAdmin();
    if (!_auth.ok) return _auth.response;

    const body = await request.json();
    const {
      departmentId,
      primaryApproverId,
      deputyApproverId,
      autoDelegateHours,
    } = body;

    if (
      departmentId === undefined ||
      departmentId === null ||
      departmentId === "" ||
      primaryApproverId === undefined ||
      primaryApproverId === null ||
      primaryApproverId === ""
    ) {
      return NextResponse.json(
        { error: "부서, 메인 결재자는 필수입니다." },
        { status: 400 }
      );
    }

    const deptIdNum = Number(departmentId);
    const primaryIdNum = Number(primaryApproverId);
    if (!Number.isInteger(deptIdNum) || !Number.isInteger(primaryIdNum)) {
      return NextResponse.json(
        { error: "departmentId, primaryApproverId는 정수여야 합니다." },
        { status: 400 }
      );
    }

    // 부서 존재 + 결재선 중복 검증
    const dept = await prisma.department.findUnique({
      where: { id: deptIdNum },
    });
    if (!dept) {
      return NextResponse.json(
        { error: `부서 id ${deptIdNum}를 찾을 수 없습니다.` },
        { status: 400 }
      );
    }
    const existing = await prisma.approvalLine.findUnique({
      where: { departmentId: deptIdNum },
    });
    if (existing) {
      return NextResponse.json(
        { error: `부서 "${dept.name}"에 이미 결재선이 존재합니다.` },
        { status: 409 }
      );
    }

    // 메인 결재자 활성 검증
    const primaryErr = await validateActiveEmployee(primaryIdNum, "메인 결재자");
    if (primaryErr) {
      return NextResponse.json({ error: primaryErr }, { status: 400 });
    }

    // 대리 결재자 검증 (선택)
    let deputyIdNum: number | null = null;
    if (
      deputyApproverId !== undefined &&
      deputyApproverId !== null &&
      deputyApproverId !== ""
    ) {
      const v = Number(deputyApproverId);
      if (!Number.isInteger(v)) {
        return NextResponse.json(
          { error: "deputyApproverId는 정수여야 합니다." },
          { status: 400 }
        );
      }
      if (v === primaryIdNum) {
        return NextResponse.json(
          { error: "메인과 대리 결재자는 같을 수 없습니다." },
          { status: 400 }
        );
      }
      const err = await validateActiveEmployee(v, "대리 결재자");
      if (err) return NextResponse.json({ error: err }, { status: 400 });
      deputyIdNum = v;
    }

    // autoDelegateHours 검증
    const hours = Number(autoDelegateHours ?? 24);
    if (!Number.isInteger(hours) || hours < 1) {
      return NextResponse.json(
        { error: "autoDelegateHours는 1 이상 정수여야 합니다." },
        { status: 400 }
      );
    }

    const line = await prisma.approvalLine.create({
      data: {
        departmentId: deptIdNum,
        primaryApproverId: primaryIdNum,
        deputyApproverId: deputyIdNum,
        autoDelegateHours: hours,
      },
      include: {
        department: { select: { id: true, code: true, name: true } },
        primaryApprover: {
          select: { id: true, employeeNo: true, name: true },
        },
        deputyApprover: {
          select: { id: true, employeeNo: true, name: true },
        },
      },
    });

    return NextResponse.json(
      {
        id: line.id,
        departmentId: line.departmentId,
        departmentCode: line.department.code,
        departmentName: line.department.name,
        primaryApproverId: line.primaryApproverId,
        primaryApproverNo: line.primaryApprover.employeeNo,
        primaryApproverName: line.primaryApprover.name,
        deputyApproverId: line.deputyApproverId,
        deputyApproverNo: line.deputyApprover?.employeeNo ?? null,
        deputyApproverName: line.deputyApprover?.name ?? null,
        autoDelegateHours: line.autoDelegateHours,
      },
      { status: 201 }
    );
  } catch (error) {
    console.error("POST /api/approval-lines error:", error);
    return NextResponse.json(
      { error: "결재선 등록 실패" },
      { status: 500 }
    );
  }
}

// PUT /api/approval-lines?id=1 — departmentId 제외 부분 업데이트
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
    const { primaryApproverId, deputyApproverId, autoDelegateHours } = body;

    const before = await prisma.approvalLine.findUnique({
      where: { id: idNum },
    });
    if (!before) {
      return NextResponse.json(
        { error: "결재선을 찾을 수 없습니다." },
        { status: 404 }
      );
    }

    // 새 메인/대리 결정 (요청에 없으면 기존값 유지)
    let newPrimary: number = before.primaryApproverId;
    if (
      primaryApproverId !== undefined &&
      primaryApproverId !== null &&
      primaryApproverId !== ""
    ) {
      const v = Number(primaryApproverId);
      if (!Number.isInteger(v)) {
        return NextResponse.json(
          { error: "primaryApproverId는 정수여야 합니다." },
          { status: 400 }
        );
      }
      if (v !== before.primaryApproverId) {
        const err = await validateActiveEmployee(v, "메인 결재자");
        if (err) return NextResponse.json({ error: err }, { status: 400 });
      }
      newPrimary = v;
    }

    let newDeputy: number | null = before.deputyApproverId;
    if (deputyApproverId !== undefined) {
      if (deputyApproverId === null || deputyApproverId === "") {
        newDeputy = null;
      } else {
        const v = Number(deputyApproverId);
        if (!Number.isInteger(v)) {
          return NextResponse.json(
            { error: "deputyApproverId는 정수여야 합니다." },
            { status: 400 }
          );
        }
        if (v !== before.deputyApproverId) {
          const err = await validateActiveEmployee(v, "대리 결재자");
          if (err) return NextResponse.json({ error: err }, { status: 400 });
        }
        newDeputy = v;
      }
    }

    if (newDeputy !== null && newDeputy === newPrimary) {
      return NextResponse.json(
        { error: "메인과 대리 결재자는 같을 수 없습니다." },
        { status: 400 }
      );
    }

    // autoDelegateHours
    let hoursUpdate: number | undefined = undefined;
    if (autoDelegateHours !== undefined) {
      const hours = Number(autoDelegateHours);
      if (!Number.isInteger(hours) || hours < 1) {
        return NextResponse.json(
          { error: "autoDelegateHours는 1 이상 정수여야 합니다." },
          { status: 400 }
        );
      }
      hoursUpdate = hours;
    }

    const line = await prisma.approvalLine.update({
      where: { id: idNum },
      data: {
        ...(primaryApproverId !== undefined &&
          primaryApproverId !== null &&
          primaryApproverId !== "" && { primaryApproverId: newPrimary }),
        ...(deputyApproverId !== undefined && { deputyApproverId: newDeputy }),
        ...(hoursUpdate !== undefined && { autoDelegateHours: hoursUpdate }),
        // departmentId 변경 불가 — 본문에 포함되어도 무시
      },
      include: {
        department: { select: { id: true, code: true, name: true } },
        primaryApprover: {
          select: { id: true, employeeNo: true, name: true },
        },
        deputyApprover: {
          select: { id: true, employeeNo: true, name: true },
        },
      },
    });

    return NextResponse.json({
      id: line.id,
      departmentId: line.departmentId,
      departmentCode: line.department.code,
      departmentName: line.department.name,
      primaryApproverId: line.primaryApproverId,
      primaryApproverNo: line.primaryApprover.employeeNo,
      primaryApproverName: line.primaryApprover.name,
      deputyApproverId: line.deputyApproverId,
      deputyApproverNo: line.deputyApprover?.employeeNo ?? null,
      deputyApproverName: line.deputyApprover?.name ?? null,
      autoDelegateHours: line.autoDelegateHours,
    });
  } catch (error) {
    console.error("PUT /api/approval-lines error:", error);
    return NextResponse.json(
      { error: "결재선 수정 실패" },
      { status: 500 }
    );
  }
}

// DELETE /api/approval-lines?id=1
// 참조 무결성 검증 없음 — attendance_requests는 결재 시점에 결재자 id를 복사하므로 결재선 삭제 영향 없음
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

    const target = await prisma.approvalLine.findUnique({
      where: { id: idNum },
    });
    if (!target) {
      return NextResponse.json(
        { error: "결재선을 찾을 수 없습니다." },
        { status: 404 }
      );
    }

    await prisma.approvalLine.delete({ where: { id: idNum } });

    return NextResponse.json({ message: "결재선이 삭제되었습니다." });
  } catch (error) {
    console.error("DELETE /api/approval-lines error:", error);
    return NextResponse.json(
      { error: "결재선 삭제 실패" },
      { status: 500 }
    );
  }
}

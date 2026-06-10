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

    // 결재자 이름 배치 조회 (approver_ids 표시용)
    const allApproverIds = Array.from(
      new Set(lines.flatMap((l) => l.approverIds ?? []))
    );
    const approverNameMap = new Map<
      number,
      { employeeNo: string | null; name: string }
    >();
    if (allApproverIds.length > 0) {
      const emps = await prisma.employee.findMany({
        where: { id: { in: allApproverIds } },
        select: { id: true, employeeNo: true, name: true },
      });
      for (const e of emps)
        approverNameMap.set(e.id, { employeeNo: e.employeeNo, name: e.name });
    }

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
        approverIds: l.approverIds,
        approvalMode: l.approvalMode,
        approvers: (l.approverIds ?? []).map((id) => ({
          id,
          employeeNo: approverNameMap.get(id)?.employeeNo ?? null,
          name: approverNameMap.get(id)?.name ?? null,
        })),
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
    const { departmentId, approverIds, approvalMode, deputyApproverId, autoDelegateHours } = body;

    if (departmentId === undefined || departmentId === null || departmentId === "") {
      return NextResponse.json({ error: "부서는 필수입니다." }, { status: 400 });
    }
    const deptIdNum = Number(departmentId);
    if (!Number.isInteger(deptIdNum)) {
      return NextResponse.json({ error: "departmentId는 정수여야 합니다." }, { status: 400 });
    }

    // 결재자 배열 검증 (1명 이상, 중복 제거, 활성, CEO 제외)
    if (!Array.isArray(approverIds) || approverIds.length === 0) {
      return NextResponse.json({ error: "결재자를 1명 이상 지정해야 합니다." }, { status: 400 });
    }
    const ids = Array.from(new Set(approverIds.map((v: unknown) => Number(v))));
    if (ids.some((n) => !Number.isInteger(n))) {
      return NextResponse.json({ error: "결재자 id는 정수여야 합니다." }, { status: 400 });
    }
    const approverEmps = await prisma.employee.findMany({
      where: { id: { in: ids } },
      include: { position: { select: { code: true } } },
    });
    if (approverEmps.length !== ids.length) {
      return NextResponse.json({ error: "존재하지 않는 결재자가 포함되어 있습니다." }, { status: 400 });
    }
    for (const e of approverEmps) {
      if (!e.isActive) return NextResponse.json({ error: `비활성 직원(${e.name})은 결재자로 지정할 수 없습니다.` }, { status: 400 });
      if (e.position?.code === "CEO") return NextResponse.json({ error: `CEO(${e.name})는 결재자로 지정할 수 없습니다.` }, { status: 400 });
    }

    const mode = approvalMode === "any" ? "any" : "all";

    const dept = await prisma.department.findUnique({ where: { id: deptIdNum } });
    if (!dept) return NextResponse.json({ error: `부서 id ${deptIdNum}를 찾을 수 없습니다.` }, { status: 400 });
    const existing = await prisma.approvalLine.findUnique({ where: { departmentId: deptIdNum } });
    if (existing) return NextResponse.json({ error: `부서 "${dept.name}"에 이미 결재선이 존재합니다.` }, { status: 409 });

    // 대리(선택)
    let deputyIdNum: number | null = null;
    if (deputyApproverId !== undefined && deputyApproverId !== null && deputyApproverId !== "") {
      const v = Number(deputyApproverId);
      if (!Number.isInteger(v)) return NextResponse.json({ error: "deputyApproverId는 정수여야 합니다." }, { status: 400 });
      const err = await validateActiveEmployee(v, "대리 결재자");
      if (err) return NextResponse.json({ error: err }, { status: 400 });
      deputyIdNum = v;
    }

    const hours = Number(autoDelegateHours ?? 24);
    if (!Number.isInteger(hours) || hours < 1) {
      return NextResponse.json({ error: "autoDelegateHours는 1 이상 정수여야 합니다." }, { status: 400 });
    }

    const line = await prisma.approvalLine.create({
      data: {
        departmentId: deptIdNum,
        approverIds: ids,
        approvalMode: mode,
        primaryApproverId: ids[0], // NOT NULL 호환
        deputyApproverId: deputyIdNum,
        autoDelegateHours: hours,
      },
      include: {
        department: { select: { id: true, code: true, name: true } },
        deputyApprover: { select: { id: true, employeeNo: true, name: true } },
      },
    });

    const nameMap = new Map(approverEmps.map((e) => [e.id, { employeeNo: e.employeeNo, name: e.name }]));
    return NextResponse.json(
      {
        id: line.id,
        departmentId: line.departmentId,
        departmentCode: line.department.code,
        departmentName: line.department.name,
        approverIds: line.approverIds,
        approvalMode: line.approvalMode,
        approvers: line.approverIds.map((id) => ({
          id,
          employeeNo: nameMap.get(id)?.employeeNo ?? null,
          name: nameMap.get(id)?.name ?? null,
        })),
        deputyApproverId: line.deputyApproverId,
        deputyApproverNo: line.deputyApprover?.employeeNo ?? null,
        deputyApproverName: line.deputyApprover?.name ?? null,
        autoDelegateHours: line.autoDelegateHours,
        primaryApproverId: line.primaryApproverId,
        primaryApproverName: nameMap.get(line.primaryApproverId ?? -1)?.name ?? null,
      },
      { status: 201 }
    );
  } catch (error) {
    console.error("POST /api/approval-lines error:", error);
    return NextResponse.json({ error: "결재선 등록 실패" }, { status: 500 });
  }
}

// PUT /api/approval-lines?id=1 — departmentId 제외 부분 업데이트
export async function PUT(request: NextRequest) {
  try {
    const _auth = await requireAdmin();
    if (!_auth.ok) return _auth.response;

    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");
    if (!id) return NextResponse.json({ error: "id 파라미터 필요" }, { status: 400 });
    const idNum = Number(id);

    const body = await request.json();
    const { approverIds, approvalMode, deputyApproverId, autoDelegateHours } = body;

    const before = await prisma.approvalLine.findUnique({ where: { id: idNum } });
    if (!before) return NextResponse.json({ error: "결재선을 찾을 수 없습니다." }, { status: 404 });

    const data: {
      approverIds?: number[];
      approvalMode?: string;
      primaryApproverId?: number;
      deputyApproverId?: number | null;
      autoDelegateHours?: number;
    } = {};

    // 결재자 배열 (제공 시 1명 이상, 활성, CEO 제외)
    if (approverIds !== undefined) {
      if (!Array.isArray(approverIds) || approverIds.length === 0) {
        return NextResponse.json({ error: "결재자를 1명 이상 지정해야 합니다." }, { status: 400 });
      }
      const ids = Array.from(new Set(approverIds.map((v: unknown) => Number(v))));
      if (ids.some((n) => !Number.isInteger(n))) {
        return NextResponse.json({ error: "결재자 id는 정수여야 합니다." }, { status: 400 });
      }
      const emps = await prisma.employee.findMany({
        where: { id: { in: ids } },
        include: { position: { select: { code: true } } },
      });
      if (emps.length !== ids.length) {
        return NextResponse.json({ error: "존재하지 않는 결재자가 포함되어 있습니다." }, { status: 400 });
      }
      for (const e of emps) {
        if (!e.isActive) return NextResponse.json({ error: `비활성 직원(${e.name})은 결재자로 지정할 수 없습니다.` }, { status: 400 });
        if (e.position?.code === "CEO") return NextResponse.json({ error: `CEO(${e.name})는 결재자로 지정할 수 없습니다.` }, { status: 400 });
      }
      data.approverIds = ids;
      data.primaryApproverId = ids[0]; // NOT NULL 호환
    }

    if (approvalMode !== undefined) {
      data.approvalMode = approvalMode === "any" ? "any" : "all";
    }

    if (deputyApproverId !== undefined) {
      if (deputyApproverId === null || deputyApproverId === "") {
        data.deputyApproverId = null;
      } else {
        const v = Number(deputyApproverId);
        if (!Number.isInteger(v)) return NextResponse.json({ error: "deputyApproverId는 정수여야 합니다." }, { status: 400 });
        const err = await validateActiveEmployee(v, "대리 결재자");
        if (err) return NextResponse.json({ error: err }, { status: 400 });
        data.deputyApproverId = v;
      }
    }

    if (autoDelegateHours !== undefined) {
      const hours = Number(autoDelegateHours);
      if (!Number.isInteger(hours) || hours < 1) {
        return NextResponse.json({ error: "autoDelegateHours는 1 이상 정수여야 합니다." }, { status: 400 });
      }
      data.autoDelegateHours = hours;
    }

    const line = await prisma.approvalLine.update({
      where: { id: idNum },
      data,
      include: {
        department: { select: { id: true, code: true, name: true } },
        deputyApprover: { select: { id: true, employeeNo: true, name: true } },
      },
    });

    const nm = new Map<number, { employeeNo: string | null; name: string }>();
    if (line.approverIds.length > 0) {
      const emps = await prisma.employee.findMany({
        where: { id: { in: line.approverIds } },
        select: { id: true, employeeNo: true, name: true },
      });
      for (const e of emps) nm.set(e.id, { employeeNo: e.employeeNo, name: e.name });
    }
    return NextResponse.json({
      id: line.id,
      departmentId: line.departmentId,
      departmentCode: line.department.code,
      departmentName: line.department.name,
      approverIds: line.approverIds,
      approvalMode: line.approvalMode,
      approvers: line.approverIds.map((id) => ({
        id,
        employeeNo: nm.get(id)?.employeeNo ?? null,
        name: nm.get(id)?.name ?? null,
      })),
      deputyApproverId: line.deputyApproverId,
      deputyApproverNo: line.deputyApprover?.employeeNo ?? null,
      deputyApproverName: line.deputyApprover?.name ?? null,
      autoDelegateHours: line.autoDelegateHours,
      primaryApproverId: line.primaryApproverId,
      primaryApproverName: nm.get(line.primaryApproverId ?? -1)?.name ?? null,
    });
  } catch (error) {
    console.error("PUT /api/approval-lines error:", error);
    return NextResponse.json({ error: "결재선 수정 실패" }, { status: 500 });
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

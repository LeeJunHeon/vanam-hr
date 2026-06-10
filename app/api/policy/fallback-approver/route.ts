import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth-helpers";

const KEY = "fallback_approver_employee_id";

// GET /api/policy/fallback-approver — 현재 대체 결재자
export async function GET() {
  try {
    const _auth = await requireAdmin();
    if (!_auth.ok) return _auth.response;

    const row = await prisma.policySetting.findUnique({ where: { key: KEY } });
    const empId = row ? Number(row.value) : NaN;
    if (!Number.isInteger(empId)) {
      return NextResponse.json({ employeeId: null, employeeNo: null, name: null, isActive: false });
    }
    const emp = await prisma.employee.findUnique({
      where: { id: empId },
      select: { id: true, employeeNo: true, name: true, isActive: true },
    });
    return NextResponse.json({
      employeeId: emp?.id ?? empId,
      employeeNo: emp?.employeeNo ?? null,
      name: emp?.name ?? null,
      isActive: emp?.isActive ?? false,
    });
  } catch (error) {
    console.error("GET /api/policy/fallback-approver error:", error);
    return NextResponse.json({ error: "대체 결재자 조회 실패" }, { status: 500 });
  }
}

// PUT /api/policy/fallback-approver  body: { employeeId }
export async function PUT(request: NextRequest) {
  try {
    const _auth = await requireAdmin();
    if (!_auth.ok) return _auth.response;

    const body = await request.json();
    const employeeId = Number(body.employeeId);
    if (!Number.isInteger(employeeId)) {
      return NextResponse.json({ error: "employeeId는 정수여야 합니다." }, { status: 400 });
    }
    const emp = await prisma.employee.findUnique({
      where: { id: employeeId },
      include: { position: { select: { code: true } } },
    });
    if (!emp) return NextResponse.json({ error: "직원을 찾을 수 없습니다." }, { status: 400 });
    if (!emp.isActive) return NextResponse.json({ error: "비활성 직원은 대체 결재자로 지정할 수 없습니다." }, { status: 400 });
    if (emp.position?.code === "CEO") return NextResponse.json({ error: "CEO는 대체 결재자로 지정할 수 없습니다." }, { status: 400 });

    await prisma.policySetting.upsert({
      where: { key: KEY },
      create: { key: KEY, value: String(employeeId), description: "결재선이 없는 신청자(부서 결재선 미설정/부서 없음)의 단독 결재자 직원 id", updatedAt: new Date() },
      update: { value: String(employeeId), updatedAt: new Date() },
    });

    return NextResponse.json({
      employeeId: emp.id,
      employeeNo: emp.employeeNo,
      name: emp.name,
      isActive: emp.isActive,
    });
  } catch (error) {
    console.error("PUT /api/policy/fallback-approver error:", error);
    return NextResponse.json({ error: "대체 결재자 변경 실패" }, { status: 500 });
  }
}

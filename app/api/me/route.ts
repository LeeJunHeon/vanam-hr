import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession, isAdminSession, isCeoSession } from "@/lib/auth-helpers";

// GET /api/me
// 현재 로그인 세션 기반 본인 정보 반환.
// useCurrentEmployee 훅이 이 엔드포인트를 호출한다.
export async function GET() {
  const r = await requireSession();
  if (!r.ok) return r.response;
  const { session } = r;

  const employeeId = session.user.employeeId;
  const isAdmin = isAdminSession(session);
  const isCeo = isCeoSession(session);

  // employeeId가 없으면 매핑되지 않은 사용자
  if (!Number.isInteger(employeeId)) {
    return NextResponse.json({
      id: null,
      employeeNo: session.user.employeeNo ?? null,
      name: session.user.name ?? null,
      email: session.user.email ?? null,
      departmentId: null,
      departmentName: null,
      positionId: null,
      positionName: null,
      positionCode: null,
      isActive: false,
      role: session.user.role ?? "employee",
      isAdmin,
      isCeo,
      isMapped: false,
    });
  }

  const employee = await prisma.employee.findUnique({
    where: { id: employeeId as number },
    include: {
      department: { select: { id: true, name: true } },
      position: { select: { id: true, name: true, code: true } },
    },
  });

  if (!employee) {
    // 세션에 employeeId가 있는데 DB에는 없는 (삭제된) 경우
    return NextResponse.json({
      id: null,
      employeeNo: session.user.employeeNo ?? null,
      name: session.user.name ?? null,
      email: session.user.email ?? null,
      departmentId: null,
      departmentName: null,
      positionId: null,
      positionName: null,
      positionCode: null,
      isActive: false,
      role: session.user.role ?? "employee",
      isAdmin,
      isCeo,
      isMapped: false,
    });
  }

  return NextResponse.json({
    id: employee.id,
    employeeNo: employee.employeeNo,
    name: employee.name,
    email: employee.email ?? session.user.email ?? null,
    departmentId: employee.departmentId,
    departmentName: employee.department?.name ?? null,
    positionId: employee.positionId,
    positionName: employee.position?.name ?? null,
    positionCode: employee.position?.code ?? null,
    isActive: employee.isActive,
    role: session.user.role ?? "employee",
    isAdmin,
    isCeo,
    isMapped: true,
  });
}

import { prisma } from "@/lib/prisma";

// 신뢰된 email(포털 세션 주입) → HR 신원 해석.
// auth.ts session() 콜백과 동일 체인. 권한 함수가 기대하는 필드 그대로 산출.
export interface HrIdentity {
  email: string;
  dbId: number | null;
  employeeId: number | null;
  employeeNo: string | null;
  departmentId: number | null;
  role: "ceo" | "admin" | "employee";
  positionCode: string | null;
  employeeActive: boolean;
}

export async function resolveHrIdentity(email: string): Promise<HrIdentity> {
  const base: HrIdentity = {
    email, dbId: null, employeeId: null, employeeNo: null,
    departmentId: null, role: "employee", positionCode: null, employeeActive: false,
  };

  const dbUser = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (!dbUser) return base;

  const employee = await prisma.employee.findUnique({
    where: { userId: dbUser.id },
    select: {
      id: true, employeeNo: true, isActive: true, departmentId: true,
      position: { select: { code: true } },
    },
  });

  const positionCode = employee?.position?.code ?? null;
  const role = positionCode === "CEO" ? "ceo" : positionCode === "ADMIN" ? "admin" : "employee";

  return {
    email,
    dbId: dbUser.id,
    employeeId: employee?.id ?? null,
    employeeNo: employee?.employeeNo ?? null,
    departmentId: employee?.departmentId ?? null,
    role,
    positionCode,
    employeeActive: employee?.isActive ?? false,
  };
}

import { NextResponse } from "next/server";
import type { Session } from "next-auth";
import { auth } from "@/auth";

// 로컬 UI 확인용 인증 우회 (proxy.ts와 동일 패턴)
// DISABLE_AUTH=true 일 때만 적용, 운영에서는 절대 활성화하지 말 것.
const DISABLE_AUTH = process.env.DISABLE_AUTH === "true";

/**
 * 로컬 우회 모드에서 사용할 가짜 세션.
 * employeeId는 null로 둬서 매핑이 필요한 분기에서 자연스럽게 처리되게 한다.
 * 개발자가 본인 employeeId로 테스트하고 싶으면 DEV_EMPLOYEE_ID 환경변수로 주입 가능.
 */
function makeDevSession(): Session {
  const devEmployeeIdRaw = process.env.DEV_EMPLOYEE_ID;
  const devEmployeeId = devEmployeeIdRaw ? Number(devEmployeeIdRaw) : null;
  return {
    user: {
      name: "Dev User",
      email: "dev@local",
      dbId: 0,
      role: "ceo",
      positionCode: "CEO",
      departmentId: null,
      employeeId: Number.isInteger(devEmployeeId) ? devEmployeeId : null,
      employeeNo: null,
      employeeActive: true,
    },
    expires: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  } as Session;
}

/**
 * 세션을 요구한다. 없으면 401을 NextResponse로 반환할 수 있도록 결과 객체를 돌려준다.
 * 호출처:
 *   const r = await requireSession();
 *   if (!r.ok) return r.response;
 *   const { session } = r;
 */
export async function requireSession(): Promise<
  | { ok: true; session: Session }
  | { ok: false; response: NextResponse }
> {
  if (DISABLE_AUTH) {
    return { ok: true, session: makeDevSession() };
  }
  const session = await auth();
  if (!session?.user) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "로그인이 필요합니다." },
        { status: 401 }
      ),
    };
  }
  return { ok: true, session };
}

/** 세션이 admin 또는 ceo 권한인지 (관리 기능 접근용) */
export function isAdminSession(session: Session | null | undefined): boolean {
  const role = session?.user?.role;
  return role === "admin" || role === "ceo";
}

/** 세션이 ceo 권한인지 (전체 조회 가능 여부) */
export function isCeoSession(session: Session | null | undefined): boolean {
  return session?.user?.role === "ceo";
}

/**
 * 세션이 전체 직원 조회 권한이 있는지.
 * - CEO: 항상 true
 * - ADMIN + departmentId가 NULL: true (인사 담당 패턴)
 * - 그 외: false
 */
export function canViewAllEmployees(session: Session | null | undefined): boolean {
  if (!session?.user) return false;
  if (session.user.role === "ceo") return true;
  if (session.user.role === "admin" && session.user.departmentId == null) {
    return true;
  }
  return false;
}

/**
 * 세션이 특정 부서의 직원 정보를 조회할 권한이 있는지.
 * - canViewAllEmployees가 true이면 모든 부서 OK
 * - ADMIN + departmentId === targetDepartmentId: OK
 * - 그 외: false
 */
export function canViewDepartment(
  session: Session | null | undefined,
  targetDepartmentId: number | null,
): boolean {
  if (canViewAllEmployees(session)) return true;
  if (
    session?.user?.role === "admin" &&
    session.user.departmentId != null &&
    session.user.departmentId === targetDepartmentId
  ) {
    return true;
  }
  return false;
}

/**
 * 세션이 특정 직원 한 명의 데이터를 조회할 권한이 있는지.
 * - canViewAllEmployees가 true이면 OK
 * - 본인이면 OK
 * - ADMIN이고 대상 직원이 자기 부서면 OK (조회용 — 대상 직원의 departmentId를 별도 인자로 받음)
 *
 * 호출 예:
 *   const target = await prisma.employee.findUnique({ where: { id }, select: { departmentId: true } });
 *   if (!canViewEmployee(session, id, target?.departmentId ?? null)) return 403;
 */
export function canViewEmployee(
  session: Session | null | undefined,
  targetEmployeeId: number,
  targetEmployeeDepartmentId: number | null,
): boolean {
  if (canViewAllEmployees(session)) return true;
  if (session?.user?.employeeId === targetEmployeeId) return true;
  if (
    session?.user?.role === "admin" &&
    session.user.departmentId != null &&
    session.user.departmentId === targetEmployeeDepartmentId
  ) {
    return true;
  }
  return false;
}

/**
 * 관리자 권한을 요구한다. 미로그인은 401, 비관리자는 403.
 */
export async function requireAdmin(): Promise<
  | { ok: true; session: Session }
  | { ok: false; response: NextResponse }
> {
  const r = await requireSession();
  if (!r.ok) return r;
  if (!isAdminSession(r.session)) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "관리자 권한이 필요합니다." },
        { status: 403 }
      ),
    };
  }
  return r;
}

/**
 * 본인 데이터 API에서 "조회 대상 employeeId"를 결정한다.
 * 규칙:
 *   - 관리자는 ?employeeId=N 쿼리로 다른 직원 데이터 조회 가능 (지정 안 하면 본인)
 *   - 비관리자는 항상 본인 employeeId만 (쿼리는 무시되거나, 본인과 다르면 403)
 * 반환:
 *   - ok=true: employeeId (number)
 *   - ok=false: NextResponse (401/403/400)
 */
export async function getTargetEmployeeId(
  request: Request
): Promise<
  | { ok: true; employeeId: number; session: Session }
  | { ok: false; response: NextResponse }
> {
  const r = await requireSession();
  if (!r.ok) return r;
  const { session } = r;

  const url = new URL(request.url);
  const requestedRaw = url.searchParams.get("employeeId");
  const requested = requestedRaw !== null ? Number(requestedRaw) : null;
  if (requestedRaw !== null && !Number.isInteger(requested)) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "employeeId는 정수여야 합니다." },
        { status: 400 }
      ),
    };
  }

  const isAdmin = isAdminSession(session);
  const ownId = session.user.employeeId;

  if (isAdmin) {
    // 관리자: 요청 값이 있으면 그 값, 없으면 본인 id (없으면 400)
    const target = requested ?? ownId;
    if (!Number.isInteger(target)) {
      return {
        ok: false,
        response: NextResponse.json(
          {
            error:
              "조회할 직원이 지정되지 않았습니다. employeeId 쿼리 파라미터가 필요합니다.",
          },
          { status: 400 }
        ),
      };
    }
    return { ok: true, employeeId: target as number, session };
  }

  // 비관리자
  if (!Number.isInteger(ownId)) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          error:
            "본인 직원 정보가 매핑되어 있지 않습니다. 관리자에게 직원 등록을 요청하세요.",
        },
        { status: 403 }
      ),
    };
  }
  if (requested !== null && requested !== ownId) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "본인 데이터만 조회할 수 있습니다." },
        { status: 403 }
      ),
    };
  }
  return { ok: true, employeeId: ownId as number, session };
}

/**
 * 결재 API에서 "결재자 employeeId"를 결정한다.
 * 규칙:
 *   - 관리자: ?approverId=N 지정 가능 (없으면 본인)
 *   - 비관리자: 본인만, 다른 값 지정 시 403
 *   - body의 approverId도 동일 규칙으로 검증할 수 있도록 결정값 반환
 */
export async function getApproverId(
  request: Request,
  bodyApproverId?: unknown
): Promise<
  | { ok: true; approverId: number; session: Session }
  | { ok: false; response: NextResponse }
> {
  const r = await requireSession();
  if (!r.ok) return r;
  const { session } = r;

  const url = new URL(request.url);
  const qRaw = url.searchParams.get("approverId");
  const qNum = qRaw !== null ? Number(qRaw) : null;
  if (qRaw !== null && !Number.isInteger(qNum)) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "approverId는 정수여야 합니다." },
        { status: 400 }
      ),
    };
  }
  const bNum =
    bodyApproverId !== undefined && bodyApproverId !== null && bodyApproverId !== ""
      ? Number(bodyApproverId)
      : null;
  if (bodyApproverId !== undefined && bodyApproverId !== null && bodyApproverId !== "" && !Number.isInteger(bNum)) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "approverId는 정수여야 합니다." },
        { status: 400 }
      ),
    };
  }

  const isAdmin = isAdminSession(session);
  const ownId = session.user.employeeId;
  const requested = bNum ?? qNum;

  if (isAdmin) {
    const target = requested ?? ownId;
    if (!Number.isInteger(target)) {
      return {
        ok: false,
        response: NextResponse.json(
          { error: "approverId가 필요합니다." },
          { status: 400 }
        ),
      };
    }
    return { ok: true, approverId: target as number, session };
  }

  if (!Number.isInteger(ownId)) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          error:
            "본인 직원 정보가 매핑되어 있지 않습니다. 관리자에게 직원 등록을 요청하세요.",
        },
        { status: 403 }
      ),
    };
  }
  if (requested !== null && requested !== ownId) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "본인 결재함만 조회할 수 있습니다." },
        { status: 403 }
      ),
    };
  }
  return { ok: true, approverId: ownId as number, session };
}

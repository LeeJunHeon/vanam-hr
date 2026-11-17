import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  requireSession,
  canViewAllEmployees,
  canViewEmployee,
} from "@/lib/auth-helpers";
import { assembleAttendanceRows } from "@/lib/attendance-rows";

export const dynamic = "force-dynamic";

// GET /api/attendance/work-hours — 전체 근무시간 조회 화면(관리자 메뉴 work-hours) 데이터.
//   ?startDate=2026-11-01&endDate=2026-11-30
//   &departmentId=3  (선택 — 전체 조회 권한자만. 부서 있는 ADMIN 은 본인 부서로 강제, 다른 부서면 403)
//   &employeeId=8    (선택 — 일별 상세. 볼 수 없는 직원이면 403)
// 권한·부서 강제는 /api/attendance/overview 와 같다. 근태 행은 lib/attendance-rows 그대로.
// 근무시간 계산은 화면(lib/work-hours)이 한다.
//
// 응답: {
//   range: { startDate, endDate }, scope: 'all' | 'department', departmentId,
//   departments: [{ id, name }] | null   // 전체 조회 권한자만 (부서 선택용)
//   employees: [{ id, name, departmentName, isActive }]   // 표 행 (재직자 + 기간 내 기록 있는 퇴사자)
//   detailEmployee: { id, name, departmentName, isActive } | null
//   rows: [{ employeeId, workDate, checkIn, checkOut, originalCheckIn, originalCheckOut,
//            autoStatus, categoryName, categoryType }]
// }

const MAX_RANGE_DAYS = 62;

function validYmd(s: string | null): s is string {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + "T00:00:00.000Z");
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export async function GET(request: NextRequest) {
  try {
    const r = await requireSession();
    if (!r.ok) return r.response;
    const { session } = r;

    // 권한: CEO 또는 ADMIN만 (EMPLOYEE는 403)
    const role = session.user.role;
    if (role !== "ceo" && role !== "admin") {
      return NextResponse.json({ error: "관리자 권한이 필요합니다." }, { status: 403 });
    }

    const { searchParams } = new URL(request.url);
    const startDate = searchParams.get("startDate");
    const endDate = searchParams.get("endDate");
    const requestedDept = searchParams.get("departmentId");
    const requestedEmpRaw = searchParams.get("employeeId");

    if (!validYmd(startDate) || !validYmd(endDate) || startDate > endDate) {
      return NextResponse.json({ error: "조회 기간이 올바르지 않습니다." }, { status: 400 });
    }
    const days = (Date.parse(endDate) - Date.parse(startDate)) / 86400000 + 1;
    if (days > MAX_RANGE_DAYS) {
      return NextResponse.json({ error: `조회 기간은 ${MAX_RANGE_DAYS}일 이내여야 합니다.` }, { status: 400 });
    }

    let requestedDeptId: number | null = null;
    if (requestedDept && requestedDept !== "all") {
      const n = Number(requestedDept);
      if (Number.isInteger(n)) requestedDeptId = n;
    }
    let requestedEmployeeId: number | null = null;
    if (requestedEmpRaw) {
      const n = Number(requestedEmpRaw);
      if (Number.isInteger(n)) requestedEmployeeId = n;
    }

    // 부서 필터 결정 (overview 와 같은 규칙)
    // - CEO 또는 ADMIN(부서 미지정): 전체 OR 사용자가 선택한 부서
    // - ADMIN(부서 지정): 본인 부서 강제. 다른 부서를 명시해 요청하면 403
    const viewAll = canViewAllEmployees(session);
    let departmentFilter: number | null = null;
    if (viewAll) {
      departmentFilter = requestedDeptId;
    } else {
      const ownDept = session.user.departmentId;
      if (ownDept == null) {
        return NextResponse.json({ error: "조회 가능한 부서가 없습니다." }, { status: 403 });
      }
      if (requestedDeptId !== null && requestedDeptId !== ownDept) {
        return NextResponse.json({ error: "다른 부서는 조회할 수 없습니다." }, { status: 403 });
      }
      departmentFilter = ownDept;
    }

    // 특정 직원 지정 시 권한 체크
    let detailEmployee: { id: number; name: string; departmentName: string | null; isActive: boolean; employeeNo: string | null } | null = null;
    if (requestedEmployeeId !== null) {
      const target = await prisma.employee.findUnique({
        where: { id: requestedEmployeeId },
        select: {
          id: true,
          name: true,
          employeeNo: true,
          isActive: true,
          departmentId: true,
          department: { select: { name: true } },
        },
      });
      if (!target) {
        return NextResponse.json({ error: "직원을 찾을 수 없습니다." }, { status: 404 });
      }
      if (!canViewEmployee(session, requestedEmployeeId, target.departmentId ?? null)) {
        return NextResponse.json({ error: "해당 직원 조회 권한이 없습니다." }, { status: 403 });
      }
      detailEmployee = {
        id: target.id,
        name: target.name,
        employeeNo: target.employeeNo,
        isActive: target.isActive,
        departmentName: target.department?.name ?? null,
      };
    }

    // 직원 목록 — 전체 근태 조회와 같은 기준(재직, 근태 대상) + 기간 안에 근태 기록이 있는 퇴사자
    const range = {
      gte: new Date(startDate + "T00:00:00.000Z"),
      lte: new Date(endDate + "T00:00:00.000Z"),
    };
    const employees = await prisma.employee.findMany({
      where: {
        isHrOnly: false,
        ...(departmentFilter !== null && { departmentId: departmentFilter }),
        OR: [{ isActive: true }, { attendanceDailies: { some: { workDate: range } } }],
      },
      select: {
        id: true,
        employeeNo: true,
        name: true,
        isActive: true,
        department: { select: { name: true } },
        position: { select: { name: true } },
      },
      orderBy: [{ department: { sortOrder: "asc" } }, { employeeNo: "asc" }],
    });

    const assembleTargets = employees.map((e) => ({
      id: e.id,
      employeeNo: e.employeeNo,
      name: e.name,
      departmentName: e.department?.name ?? null,
      positionName: e.position?.name ?? null,
    }));
    // 상세 직원이 표 목록 밖(부서 필터 밖 등)이어도 그 직원의 근태 행은 함께 읽는다
    if (detailEmployee && !assembleTargets.some((e) => e.id === detailEmployee.id)) {
      assembleTargets.push({
        id: detailEmployee.id,
        employeeNo: detailEmployee.employeeNo,
        name: detailEmployee.name,
        departmentName: detailEmployee.departmentName,
        positionName: null,
      });
    }

    const [rows, departments] = await Promise.all([
      assembleAttendanceRows({ employees: assembleTargets, startDate, endDate }),
      viewAll
        ? prisma.department.findMany({
            where: { isActive: true },
            orderBy: [{ sortOrder: "asc" }, { code: "asc" }],
            select: { id: true, name: true },
          })
        : Promise.resolve(null),
    ]);

    return NextResponse.json({
      range: { startDate, endDate },
      scope: departmentFilter === null ? "all" : "department",
      departmentId: departmentFilter,
      departments,
      employees: employees.map((e) => ({
        id: e.id,
        name: e.name,
        departmentName: e.department?.name ?? null,
        isActive: e.isActive,
      })),
      detailEmployee: detailEmployee
        ? {
            id: detailEmployee.id,
            name: detailEmployee.name,
            departmentName: detailEmployee.departmentName,
            isActive: detailEmployee.isActive,
          }
        : null,
      rows: rows.map((row) => ({
        employeeId: row.employeeId,
        workDate: row.workDate,
        checkIn: row.checkIn,
        checkOut: row.checkOut,
        originalCheckIn: row.originalCheckIn,
        originalCheckOut: row.originalCheckOut,
        autoStatus: row.autoStatus,
        categoryName: row.categoryName,
        categoryType: row.categoryType,
      })),
    });
  } catch (error) {
    console.error("GET /api/attendance/work-hours error:", error);
    return NextResponse.json({ error: "근무시간 조회 실패" }, { status: 500 });
  }
}

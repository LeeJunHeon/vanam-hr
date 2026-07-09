import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  requireSession,
  canViewAllEmployees,
  canViewEmployee,
} from "@/lib/auth-helpers";
import { assembleAttendanceRows } from "@/lib/attendance-rows";

// GET /api/attendance/overview
//   ?startDate=2026-05-01&endDate=2026-05-31
//   &departmentId=2  (선택, ADMIN이면 본인 부서로 자동 강제)
//
// 응답: {
//   range: { startDate, endDate },
//   scope: 'all' | 'department',
//   departmentId: number | null,
//   rows: Array<{
//     employeeId, employeeNo, name, departmentName, positionName,
//     workDate, checkIn, checkOut, workMinutes, autoStatus, isOverridden,
//     categoryId, categoryCode, categoryName, categoryColor,
//     reason  // calendar_auto 요청의 reason (캘린더 일정 제목)
//   }>
// }
export async function GET(request: NextRequest) {
  try {
    const r = await requireSession();
    if (!r.ok) return r.response;
    const { session } = r;

    // 권한: CEO 또는 ADMIN만 (EMPLOYEE는 403)
    const role = session.user.role;
    if (role !== "ceo" && role !== "admin") {
      return NextResponse.json(
        { error: "관리자 권한이 필요합니다." },
        { status: 403 }
      );
    }

    const { searchParams } = new URL(request.url);
    const startDate = searchParams.get("startDate");
    const endDate = searchParams.get("endDate");
    const requestedDept = searchParams.get("departmentId");
    const requestedEmpRaw = searchParams.get("employeeId");

    if (!startDate || !endDate) {
      return NextResponse.json(
        { error: "startDate, endDate 필수" },
        { status: 400 }
      );
    }

    let requestedEmployeeId: number | null = null;
    if (requestedEmpRaw) {
      const n = Number(requestedEmpRaw);
      if (Number.isInteger(n)) {
        requestedEmployeeId = n;
      }
    }

    // 부서 필터 결정
    // - CEO 또는 ADMIN(부서 미지정): 전체 OR 사용자가 선택한 부서
    // - ADMIN(부서 지정): 본인 부서로 강제 (요청 무시)
    let departmentFilter: number | null = null;
    let scope: "all" | "department" = "all";

    if (canViewAllEmployees(session)) {
      // 전체 권한 사용자
      if (requestedDept && requestedDept !== "all") {
        const n = Number(requestedDept);
        if (Number.isInteger(n)) {
          departmentFilter = n;
          scope = "department";
        }
      }
    } else {
      // ADMIN with departmentId — 본인 부서 강제
      const ownDept = session.user.departmentId;
      if (ownDept == null) {
        // 이 케이스는 canViewAllEmployees=true 였어야 하므로 도달 불가
        return NextResponse.json(
          { error: "조회 가능한 부서가 없습니다." },
          { status: 403 }
        );
      }
      departmentFilter = ownDept;
      scope = "department";
    }

    // 특정 직원 지정 시 권한 체크
    if (requestedEmployeeId !== null) {
      const target = await prisma.employee.findUnique({
        where: { id: requestedEmployeeId },
        select: { id: true, departmentId: true, isActive: true },
      });
      if (!target) {
        return NextResponse.json(
          { error: "직원을 찾을 수 없습니다." },
          { status: 404 }
        );
      }
      if (
        !canViewEmployee(
          session,
          requestedEmployeeId,
          target.departmentId ?? null
        )
      ) {
        return NextResponse.json(
          { error: "해당 직원 조회 권한이 없습니다." },
          { status: 403 }
        );
      }
    }

    // 직원 + attendance_daily 조회
    const employees = await prisma.employee.findMany({
      where: {
        isActive: true,
        isHrOnly: false,
        ...(departmentFilter !== null && { departmentId: departmentFilter }),
        ...(requestedEmployeeId !== null && { id: requestedEmployeeId }),
      },
      select: {
        id: true,
        employeeNo: true,
        name: true,
        department: { select: { name: true } },
        position: { select: { name: true } },
      },
      orderBy: [
        { department: { sortOrder: "asc" } },
        { employeeNo: "asc" },
      ],
    });

    // 근태 행 조립은 lib/attendance-rows로 이동(리팩터링 1단계, 동작 동일).
    // 응답 JSON 스키마·값은 리팩터링 전과 완전히 동일하다.
    const rows = await assembleAttendanceRows({
      employees: employees.map((e) => ({
        id: e.id,
        employeeNo: e.employeeNo,
        name: e.name,
        departmentName: e.department?.name ?? null,
        positionName: e.position?.name ?? null,
      })),
      startDate,
      endDate,
    });

    return NextResponse.json({
      range: { startDate, endDate },
      scope,
      departmentId: departmentFilter,
      employeeId: requestedEmployeeId,
      rows,
    });
  } catch (error) {
    console.error("GET /api/attendance/overview error:", error);
    return NextResponse.json(
      { error: "출퇴근 조회 실패" },
      { status: 500 }
    );
  }
}

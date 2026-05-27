import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  requireSession,
  canViewAllEmployees,
} from "@/lib/auth-helpers";

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
//     workDate, checkIn, checkOut, workMinutes, isOverridden
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

    if (!startDate || !endDate) {
      return NextResponse.json(
        { error: "startDate, endDate 필수" },
        { status: 400 }
      );
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

    // 직원 + attendance_daily 조회
    const employees = await prisma.employee.findMany({
      where: {
        isActive: true,
        ...(departmentFilter !== null && { departmentId: departmentFilter }),
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

    const employeeIds = employees.map((e) => e.id);

    const attendance =
      employeeIds.length > 0
        ? await prisma.attendanceDaily.findMany({
            where: {
              employeeId: { in: employeeIds },
              workDate: {
                gte: new Date(startDate),
                lte: new Date(endDate),
              },
            },
            select: {
              employeeId: true,
              workDate: true,
              checkIn: true,
              checkOut: true,
              workMinutes: true,
              autoStatus: true,
              isOverridden: true,
            },
            orderBy: [{ workDate: "desc" }, { employeeId: "asc" }],
          })
        : [];

    // employees + attendance 조인
    const empMap = new Map(employees.map((e) => [e.id, e]));
    const rows = attendance.map((a) => {
      const emp = empMap.get(a.employeeId);
      return {
        employeeId: a.employeeId,
        employeeNo: emp?.employeeNo ?? "",
        name: emp?.name ?? "",
        departmentName: emp?.department?.name ?? null,
        positionName: emp?.position?.name ?? null,
        workDate: a.workDate.toISOString().split("T")[0],
        checkIn: a.checkIn ? a.checkIn.toISOString() : null,
        checkOut: a.checkOut ? a.checkOut.toISOString() : null,
        workMinutes: a.workMinutes ?? null,
        autoStatus: a.autoStatus ?? null,
        isOverridden: a.isOverridden,
      };
    });

    return NextResponse.json({
      range: { startDate, endDate },
      scope,
      departmentId: departmentFilter,
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

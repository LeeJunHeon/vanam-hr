import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  requireSession,
  canViewAllEmployees,
  canViewEmployee,
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
              categoryId: true,
              category: {
                select: {
                  code: true,
                  name: true,
                  displayColor: true,
                },
              },
            },
            orderBy: [{ workDate: "desc" }, { employeeId: "asc" }],
          })
        : [];

    // 캘린더 자동 등록 사유 조회 (calendar_auto + auto_approved + google_calendar)
    // start_date~end_date 범위가 조회 기간과 겹치는 모든 요청 가져옴
    const requests =
      employeeIds.length > 0
        ? await prisma.attendanceRequest.findMany({
            where: {
              employeeId: { in: employeeIds },
              requestType: "calendar_auto",
              status: "auto_approved",
              externalSource: "google_calendar",
              startDate: { lte: new Date(endDate) },
              endDate: { gte: new Date(startDate) },
            },
            select: {
              employeeId: true,
              startDate: true,
              endDate: true,
              reason: true,
              correctedCheckIn: true,
              correctedCheckOut: true,
            },
          })
        : [];

    // employeeId_YYYY-MM-DD → reason 매핑 (start~end 범위 모든 날짜에 동일 reason)
    // 그리고 같은 키 형식으로 corrected_check_in/out 시간대도 매핑(시간대 일정만 값 존재).
    const reasonMap = new Map<string, string>();
    const correctedMap = new Map<
      string,
      { in: string | null; out: string | null }
    >();
    for (const req of requests) {
      const start = new Date(req.startDate);
      const end = new Date(req.endDate);
      const d = new Date(start);
      while (d <= end) {
        const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(
          2,
          "0"
        )}-${String(d.getDate()).padStart(2, "0")}`;
        const key = `${req.employeeId}_${ymd}`;
        if (!reasonMap.has(key)) {
          reasonMap.set(key, req.reason ?? "");
        }
        if (!correctedMap.has(key)) {
          correctedMap.set(key, {
            in: req.correctedCheckIn
              ? req.correctedCheckIn.toISOString()
              : null,
            out: req.correctedCheckOut
              ? req.correctedCheckOut.toISOString()
              : null,
          });
        }
        d.setDate(d.getDate() + 1);
      }
    }

    // employees + attendance 조인
    const empMap = new Map(employees.map((e) => [e.id, e]));
    const rows = attendance.map((a) => {
      const emp = empMap.get(a.employeeId);
      const ymd = a.workDate.toISOString().split("T")[0];
      const reasonKey = `${a.employeeId}_${ymd}`;
      return {
        employeeId: a.employeeId,
        employeeNo: emp?.employeeNo ?? "",
        name: emp?.name ?? "",
        departmentName: emp?.department?.name ?? null,
        positionName: emp?.position?.name ?? null,
        workDate: ymd,
        checkIn: a.checkIn ? a.checkIn.toISOString() : null,
        checkOut: a.checkOut ? a.checkOut.toISOString() : null,
        workMinutes: a.workMinutes ?? null,
        autoStatus: a.autoStatus ?? null,
        isOverridden: a.isOverridden,
        categoryId: a.categoryId ?? null,
        categoryCode: a.category?.code ?? null,
        categoryName: a.category?.name ?? null,
        categoryColor: a.category?.displayColor ?? null,
        reason: reasonMap.get(reasonKey) ?? null,
        correctedCheckIn: correctedMap.get(reasonKey)?.in ?? null,
        correctedCheckOut: correctedMap.get(reasonKey)?.out ?? null,
      };
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

import { NextRequest, NextResponse } from "next/server";
import {
  requireSession,
  canViewAllEmployees,
} from "@/lib/auth-helpers";
import { prisma } from "@/lib/prisma";

// GET /api/attendance/calendar?yearMonth=2026-06[&employeeId=123]
//
// 월 단위 attendance_daily + attendance_requests 를 캘린더 뷰용으로 반환.
// 권한 (employeeId 없을 때):
// - CEO 또는 ADMIN(부서 미지정): 전체 직원
// - ADMIN(부서 지정): 본인 부서 직원만
// - EMPLOYEE: 본인만
// 권한 (employeeId 지정 시):
// - 본인이면 허용 (역할 무관)
// - canViewAll(CEO/부서없는admin)이면 허용
// - 부서 admin이면 대상 직원이 본인 부서 소속일 때만 허용 (그 외 403)
// - 그 외 403
//
// 응답: { yearMonth, employees, daily, requests, holidays }
export async function GET(request: NextRequest) {
  try {
    const r = await requireSession();
    if (!r.ok) return r.response;
    const { session } = r;

    const { searchParams } = new URL(request.url);
    const yearMonth = searchParams.get("yearMonth");
    if (!yearMonth || !/^\d{4}-\d{2}$/.test(yearMonth)) {
      return NextResponse.json(
        { error: "yearMonth 형식: YYYY-MM" },
        { status: 400 }
      );
    }

    const [yy, mm] = yearMonth.split("-").map(Number);
    // KST 자정 기준 월 시작/종료. attendance_daily.workDate는 date 컬럼이므로 UTC midnight 가짜만 맞추면 됨.
    const monthStart = new Date(Date.UTC(yy, mm - 1, 1));
    const monthEnd = new Date(Date.UTC(yy, mm, 0)); // 그 달 마지막일

    // 권한 분기
    const canViewAll = canViewAllEmployees(session);
    const userDeptId = session.user.departmentId;
    const role = session.user.role;
    const ownEmployeeId = session.user.employeeId;

    // employeeId 쿼리 파라미터 — 지정되면 그 직원 1명으로 강제 (권한 확인 후)
    const employeeIdRaw = searchParams.get("employeeId");
    let targetEmployeeId: number | null = null;
    if (employeeIdRaw !== null) {
      const n = Number(employeeIdRaw);
      if (!Number.isInteger(n) || n <= 0) {
        return NextResponse.json(
          { error: "employeeId는 양의 정수여야 합니다." },
          { status: 400 }
        );
      }
      targetEmployeeId = n;

      // 권한 검증
      const isSelf = ownEmployeeId === targetEmployeeId;
      if (isSelf) {
        // 본인은 항상 허용 (역할 무관)
      } else if (canViewAll) {
        // CEO 또는 부서 없는 ADMIN: 모든 직원 허용
      } else if (role === "admin" && userDeptId != null) {
        // 부서 ADMIN: 대상 직원이 본인 부서 소속인지 조회
        const target = await prisma.employee.findUnique({
          where: { id: targetEmployeeId },
          select: { departmentId: true },
        });
        if (!target || target.departmentId !== userDeptId) {
          return NextResponse.json(
            { error: "해당 직원 조회 권한이 없습니다." },
            { status: 403 }
          );
        }
      } else {
        return NextResponse.json(
          { error: "해당 직원 조회 권한이 없습니다." },
          { status: 403 }
        );
      }
    }

    let employeeFilter: { isActive: true; departmentId?: number; id?: number };
    if (targetEmployeeId !== null) {
      // 권한 통과한 단일 직원으로 강제
      employeeFilter = { isActive: true, id: targetEmployeeId };
    } else if (canViewAll) {
      employeeFilter = { isActive: true };
    } else if (role === "admin" && userDeptId != null) {
      employeeFilter = { isActive: true, departmentId: userDeptId };
    } else if (role !== "admin" && role !== "ceo" && ownEmployeeId != null) {
      // 일반 직원은 본인만
      employeeFilter = { isActive: true, id: ownEmployeeId };
    } else {
      return NextResponse.json({ error: "권한 부족" }, { status: 403 });
    }

    const employees = await prisma.employee.findMany({
      where: employeeFilter,
      select: {
        id: true,
        employeeNo: true,
        name: true,
        department: { select: { id: true, name: true } },
        position: { select: { name: true } },
      },
      orderBy: [{ department: { name: "asc" } }, { name: "asc" }],
    });

    const empIds = employees.map((e) => e.id);

    if (empIds.length === 0) {
      return NextResponse.json({
        yearMonth,
        employees: [],
        daily: [],
        requests: [],
      });
    }

    // 해당 월 attendance_daily
    const daily = await prisma.attendanceDaily.findMany({
      where: {
        employeeId: { in: empIds },
        workDate: { gte: monthStart, lte: monthEnd },
      },
      select: {
        id: true,
        employeeId: true,
        workDate: true,
        checkIn: true,
        checkOut: true,
        originalCheckIn: true,
        originalCheckOut: true,
        autoStatus: true,
        categoryId: true,
        isOverridden: true,
        workMinutes: true,
        note: true,
        statusReason: true,
        category: {
          select: {
            id: true,
            code: true,
            name: true,
            type: true,
            displayColor: true,
          },
        },
      },
    });

    // 해당 월에 활성인 attendance_requests (approved + auto_approved + 기간 겹침)
    const requests = await prisma.attendanceRequest.findMany({
      where: {
        employeeId: { in: empIds },
        status: { in: ["approved", "auto_approved"] },
        startDate: { lte: monthEnd },
        endDate: { gte: monthStart },
      },
      select: {
        id: true,
        employeeId: true,
        categoryId: true,
        startDate: true,
        endDate: true,
        correctedCheckIn: true,
        correctedCheckOut: true,
        reason: true,
        category: { select: { code: true, name: true } },
      },
    });

    // Phase 6-2L+ B-4: 조회 월 범위의 공휴일 함께 반환 (UI 라벨용)
    const holidays = await prisma.holiday.findMany({
      where: {
        holidayDate: { gte: monthStart, lte: monthEnd },
      },
      select: { holidayDate: true, name: true },
      orderBy: { holidayDate: "asc" },
    });

    return NextResponse.json({
      yearMonth,
      employees,
      holidays: holidays.map((h) => ({
        date: h.holidayDate.toISOString().split("T")[0],
        name: h.name,
      })),
      daily: daily.map((d) => ({
        id: d.id,
        employeeId: d.employeeId,
        workDate: d.workDate.toISOString().split("T")[0],
        checkIn: d.checkIn ? d.checkIn.toISOString() : null,
        checkOut: d.checkOut ? d.checkOut.toISOString() : null,
        originalCheckIn: d.originalCheckIn
          ? d.originalCheckIn.toISOString()
          : null,
        originalCheckOut: d.originalCheckOut
          ? d.originalCheckOut.toISOString()
          : null,
        autoStatus: d.autoStatus,
        categoryId: d.categoryId,
        categoryCode: d.category?.code ?? null,
        categoryName: d.category?.name ?? null,
        isOverridden: d.isOverridden,
        workMinutes: d.workMinutes,
        note: d.note,
        statusReason: d.statusReason ?? null,
      })),
      requests: requests.map((req) => ({
        id: req.id,
        employeeId: req.employeeId,
        startDate: req.startDate.toISOString().split("T")[0],
        endDate: req.endDate.toISOString().split("T")[0],
        correctedCheckIn: req.correctedCheckIn
          ? req.correctedCheckIn.toISOString()
          : null,
        correctedCheckOut: req.correctedCheckOut
          ? req.correctedCheckOut.toISOString()
          : null,
        categoryCode: req.category?.code ?? null,
        categoryName: req.category?.name ?? null,
        reason: req.reason,
      })),
    });
  } catch (error) {
    console.error("GET /api/attendance/calendar error:", error);
    return NextResponse.json(
      { error: "캘린더 데이터를 가져올 수 없습니다." },
      { status: 500 }
    );
  }
}

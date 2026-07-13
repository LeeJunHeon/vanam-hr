import { NextRequest, NextResponse } from "next/server";
import {
  requireSession,
  canViewAllEmployees,
  canViewEmployee,
} from "@/lib/auth-helpers";
import { prisma } from "@/lib/prisma";
import { assembleAttendanceRows } from "@/lib/attendance-rows";
import { buildAttendanceWorkbook } from "@/lib/excel/attendanceWorkbook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/attendance/export
//   ?scope=month&yearMonth=YYYY-MM[&employeeId=N]
//   ?scope=employee&employeeId=N
//
// 근태 전용 엑셀. 세로=출근/퇴근/평가/사유, 가로=날짜, 월 블록 과거→현재 stack.

function xlsxResponse(bytes: Uint8Array<ArrayBuffer>, filename: string): Response {
  return new Response(bytes, {
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="export.xlsx"; filename*=UTF-8''${encodeURIComponent(
        filename
      )}`,
      "Cache-Control": "no-store",
    },
  });
}

export async function GET(request: NextRequest) {
  try {
    const r = await requireSession();
    if (!r.ok) return r.response;
    const { session } = r;

    const { searchParams } = new URL(request.url);
    const scope = searchParams.get("scope");

    // KST 오늘
    const todayYmd = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Seoul",
    }).format(new Date());

    if (scope === "month") {
      const yearMonth = searchParams.get("yearMonth");
      if (!yearMonth || !/^\d{4}-\d{2}$/.test(yearMonth)) {
        return NextResponse.json(
          { error: "yearMonth 형식: YYYY-MM" },
          { status: 400 }
        );
      }
      const [yy, mm] = yearMonth.split("-").map(Number);

      // 권한 분기 (calendar route와 동일)
      const canViewAll = canViewAllEmployees(session);
      const userDeptId = session.user.departmentId;
      const role = session.user.role;
      const ownEmployeeId = session.user.employeeId;

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

        const isSelf = ownEmployeeId === targetEmployeeId;
        if (isSelf) {
          // 본인은 항상 허용 (역할 무관)
        } else if (canViewAll) {
          // CEO 또는 부서 없는 ADMIN
        } else if (role === "admin" && userDeptId != null) {
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

      let employeeFilter: {
        isActive: true;
        isHrOnly?: boolean;
        departmentId?: number;
        id?: number;
      };
      if (targetEmployeeId !== null) {
        employeeFilter = { isActive: true, id: targetEmployeeId };
      } else if (canViewAll) {
        employeeFilter = { isActive: true };
      } else if (role === "admin" && userDeptId != null) {
        employeeFilter = { isActive: true, departmentId: userDeptId };
      } else if (role !== "admin" && role !== "ceo" && ownEmployeeId != null) {
        employeeFilter = { isActive: true, id: ownEmployeeId };
      } else {
        return NextResponse.json({ error: "권한 부족" }, { status: 403 });
      }
      employeeFilter.isHrOnly = false;

      const employees = await prisma.employee.findMany({
        where: employeeFilter,
        select: {
          id: true,
          employeeNo: true,
          name: true,
          department: { select: { name: true } },
          position: { select: { name: true } },
        },
        orderBy: [{ department: { name: "asc" } }, { name: "asc" }],
      });

      const startDate = `${yearMonth}-01`;
      const lastDay = new Date(Date.UTC(yy, mm, 0)).getUTCDate();
      const endDate = `${yearMonth}-${String(lastDay).padStart(2, "0")}`;

      const wbEmployees = employees.map((e) => ({
        id: e.id,
        employeeNo: e.employeeNo,
        name: e.name,
        departmentName: e.department?.name ?? null,
        positionName: e.position?.name ?? null,
      }));

      const rows = await assembleAttendanceRows({
        employees: wbEmployees,
        startDate,
        endDate,
      });

      const holidays = await prisma.holiday.findMany({
        where: {
          holidayDate: { gte: new Date(startDate), lte: new Date(endDate) },
        },
        select: { holidayDate: true, name: true },
        orderBy: { holidayDate: "asc" },
      });

      const wb = buildAttendanceWorkbook({
        employees: wbEmployees,
        rows,
        holidays: holidays.map((h) => ({
          date: h.holidayDate.toISOString().split("T")[0],
          name: h.name,
        })),
        startDate,
        endDate,
        todayYmd,
      });

      const buffer = await wb.xlsx.writeBuffer();
      return xlsxResponse(
        new Uint8Array(buffer as ArrayBuffer),
        `근태_${yearMonth}.xlsx`
      );
    }

    if (scope === "employee") {
      const employeeIdRaw = searchParams.get("employeeId");
      const employeeId = employeeIdRaw !== null ? Number(employeeIdRaw) : NaN;
      if (!Number.isInteger(employeeId) || employeeId <= 0) {
        return NextResponse.json(
          { error: "employeeId는 양의 정수여야 합니다." },
          { status: 400 }
        );
      }

      const target = await prisma.employee.findUnique({
        where: { id: employeeId },
        select: {
          id: true,
          employeeNo: true,
          name: true,
          departmentId: true,
          hiredAt: true,
          department: { select: { name: true } },
          position: { select: { name: true } },
        },
      });
      if (!target) {
        return NextResponse.json(
          { error: "직원을 찾을 수 없습니다." },
          { status: 404 }
        );
      }
      if (!canViewEmployee(session, employeeId, target.departmentId ?? null)) {
        return NextResponse.json(
          { error: "해당 직원 조회 권한이 없습니다." },
          { status: 403 }
        );
      }

      // startDate = attendance_daily MIN(workDate) → hiredAt → todayYmd
      const minAgg = await prisma.attendanceDaily.aggregate({
        where: { employeeId },
        _min: { workDate: true },
      });
      let startDate: string;
      if (minAgg._min.workDate) {
        startDate = minAgg._min.workDate.toISOString().split("T")[0];
      } else if (target.hiredAt) {
        startDate = target.hiredAt.toISOString().split("T")[0];
      } else {
        startDate = todayYmd;
      }
      const endDate = todayYmd;
      // 방어: 시작이 종료보다 뒤면 오늘로 맞춤 (미래 입사일 등)
      if (startDate > endDate) startDate = endDate;

      const wbEmployees = [
        {
          id: target.id,
          employeeNo: target.employeeNo,
          name: target.name,
          departmentName: target.department?.name ?? null,
          positionName: target.position?.name ?? null,
        },
      ];

      const rows = await assembleAttendanceRows({
        employees: wbEmployees,
        startDate,
        endDate,
      });

      const holidays = await prisma.holiday.findMany({
        where: {
          holidayDate: { gte: new Date(startDate), lte: new Date(endDate) },
        },
        select: { holidayDate: true, name: true },
        orderBy: { holidayDate: "asc" },
      });

      const wb = buildAttendanceWorkbook({
        employees: wbEmployees,
        rows,
        holidays: holidays.map((h) => ({
          date: h.holidayDate.toISOString().split("T")[0],
          name: h.name,
        })),
        startDate,
        endDate,
        todayYmd,
      });

      const buffer = await wb.xlsx.writeBuffer();
      return xlsxResponse(
        new Uint8Array(buffer as ArrayBuffer),
        `근태_${target.name}_${startDate}~${endDate}.xlsx`
      );
    }

    return NextResponse.json(
      { error: "scope는 month 또는 employee 여야 합니다." },
      { status: 400 }
    );
  } catch (error) {
    console.error("GET /api/attendance/export error:", error);
    return NextResponse.json(
      { error: "근태 엑셀 생성에 실패했습니다." },
      { status: 500 }
    );
  }
}

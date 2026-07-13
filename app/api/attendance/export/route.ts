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
//   ?endDate=YYYY-MM-DD          (필수)
//   [&startDate=YYYY-MM-DD]      (생략 시 MIN(work_date) 사용 = "전체 기간")
//   [&employeeId=N]              (생략 시 권한 범위 전체 직원)
//
// 근태 전용 엑셀. 세로=출근/퇴근/평가/사유, 가로=날짜, 월 블록 과거→현재 stack.

const YMD = /^\d{4}-\d{2}-\d{2}$/;

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

interface WbEmployee {
  id: number;
  employeeNo: string | null;
  name: string;
  departmentName: string | null;
  positionName: string | null;
}

export async function GET(request: NextRequest) {
  try {
    const r = await requireSession();
    if (!r.ok) return r.response;
    const { session } = r;

    const { searchParams } = new URL(request.url);

    // KST 오늘
    const todayYmd = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Seoul",
    }).format(new Date());

    // 1) 파라미터 검증
    const endDateRaw = searchParams.get("endDate");
    if (!endDateRaw || !YMD.test(endDateRaw)) {
      return NextResponse.json(
        { error: "endDate 형식: YYYY-MM-DD" },
        { status: 400 }
      );
    }
    const startDateRaw = searchParams.get("startDate");
    if (startDateRaw !== null && !YMD.test(startDateRaw)) {
      return NextResponse.json(
        { error: "startDate 형식: YYYY-MM-DD" },
        { status: 400 }
      );
    }
    const employeeIdRaw = searchParams.get("employeeId");
    let employeeId: number | null = null;
    if (employeeIdRaw !== null) {
      const n = Number(employeeIdRaw);
      if (!Number.isInteger(n) || n <= 0) {
        return NextResponse.json(
          { error: "employeeId는 양의 정수여야 합니다." },
          { status: 400 }
        );
      }
      employeeId = n;
    }

    // 2) 권한 + 대상 직원 확정
    let employees: WbEmployee[];
    let singleTargetHiredAt: Date | null = null;

    if (employeeId !== null) {
      // 특정 직원 1명 — canViewEmployee 로 검증
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
      employees = [
        {
          id: target.id,
          employeeNo: target.employeeNo,
          name: target.name,
          departmentName: target.department?.name ?? null,
          positionName: target.position?.name ?? null,
        },
      ];
      singleTargetHiredAt = target.hiredAt;
    } else {
      // 권한 범위 전체 직원 (canViewAll / 부서 admin / 일반 직원(본인))
      const canViewAll = canViewAllEmployees(session);
      const userDeptId = session.user.departmentId;
      const role = session.user.role;
      const ownEmployeeId = session.user.employeeId;

      let employeeFilter: {
        isActive: true;
        isHrOnly?: boolean;
        departmentId?: number;
        id?: number;
      };
      if (canViewAll) {
        employeeFilter = { isActive: true };
      } else if (role === "admin" && userDeptId != null) {
        employeeFilter = { isActive: true, departmentId: userDeptId };
      } else if (role !== "admin" && role !== "ceo" && ownEmployeeId != null) {
        employeeFilter = { isActive: true, id: ownEmployeeId };
      } else {
        return NextResponse.json({ error: "권한 부족" }, { status: 403 });
      }
      employeeFilter.isHrOnly = false;

      const list = await prisma.employee.findMany({
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
      employees = list.map((e) => ({
        id: e.id,
        employeeNo: e.employeeNo,
        name: e.name,
        departmentName: e.department?.name ?? null,
        positionName: e.position?.name ?? null,
      }));
    }

    if (employees.length === 0) {
      return NextResponse.json(
        { error: "대상 직원이 없습니다." },
        { status: 400 }
      );
    }

    // 3) 기간 확정
    // endDate 는 오늘(KST)로 clamp → 이번 달을 뽑아도 미래 빈 열이 없다.
    const end = endDateRaw > todayYmd ? todayYmd : endDateRaw;
    let start: string;
    if (startDateRaw) {
      start = startDateRaw;
    } else {
      // 전체 기간 — 대상 직원들의 MIN(work_date)
      const minAgg = await prisma.attendanceDaily.aggregate({
        where: { employeeId: { in: employees.map((e) => e.id) } },
        _min: { workDate: true },
      });
      if (minAgg._min.workDate) {
        start = minAgg._min.workDate.toISOString().split("T")[0];
      } else if (employees.length === 1 && singleTargetHiredAt) {
        start = singleTargetHiredAt.toISOString().split("T")[0];
      } else {
        start = end;
      }
    }
    // 방어: 시작이 종료보다 뒤면 종료로 맞춤
    if (start > end) start = end;

    // 최대 기간 5년 가드
    const startMs = new Date(start + "T00:00:00Z").getTime();
    const endMs = new Date(end + "T00:00:00Z").getTime();
    const FIVE_YEARS_MS = 5 * 366 * 24 * 60 * 60 * 1000;
    if (endMs - startMs > FIVE_YEARS_MS) {
      return NextResponse.json(
        { error: "조회 기간은 최대 5년입니다." },
        { status: 400 }
      );
    }

    // 4) 데이터 + 워크북
    const rows = await assembleAttendanceRows({
      employees,
      startDate: start,
      endDate: end,
    });

    const holidays = await prisma.holiday.findMany({
      where: { holidayDate: { gte: new Date(start), lte: new Date(end) } },
      select: { holidayDate: true, name: true },
      orderBy: { holidayDate: "asc" },
    });

    const wb = buildAttendanceWorkbook({
      employees,
      rows,
      holidays: holidays.map((h) => ({
        date: h.holidayDate.toISOString().split("T")[0],
        name: h.name,
      })),
      startDate: start,
      endDate: end,
      todayYmd,
    });

    // 5) 파일명
    const filename =
      employees.length === 1
        ? `근태_${employees[0].name}_${start}~${end}.xlsx`
        : `근태_${start}~${end}.xlsx`;

    const buffer = await wb.xlsx.writeBuffer();
    return xlsxResponse(new Uint8Array(buffer as ArrayBuffer), filename);
  } catch (error) {
    console.error("GET /api/attendance/export error:", error);
    return NextResponse.json(
      { error: "근태 엑셀 생성에 실패했습니다." },
      { status: 500 }
    );
  }
}

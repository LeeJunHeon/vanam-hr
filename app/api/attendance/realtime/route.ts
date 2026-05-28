import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  requireSession,
  canViewAllEmployees,
} from "@/lib/auth-helpers";

// GET /api/attendance/realtime
// 활성 직원의 실시간 연결 상태 (오늘 기준)
// 권한 모델은 /api/attendance/overview와 동일
//
// 응답: {
//   scope: 'all' | 'department',
//   departmentId: number | null,
//   asOf: ISO string,
//   graceMinutes: number,
//   rows: Array<{
//     employeeId, employeeNo, name, departmentName, positionName,
//     realtimeStatus: 'working' | 'disconnected',
//     latestStatus: 'online' | 'offline' | null,
//     latestCheckedAt: ISO string | null,
//     latestLocation: string | null,
//     todayCheckIn: ISO string | null,
//   }>
// }
export async function GET(request: NextRequest) {
  try {
    const r = await requireSession();
    if (!r.ok) return r.response;
    const { session } = r;

    const role = session.user.role;
    if (role !== "ceo" && role !== "admin") {
      return NextResponse.json(
        { error: "관리자 권한이 필요합니다." },
        { status: 403 }
      );
    }

    // 부서 필터 결정 (overview와 동일 로직)
    let departmentFilter: number | null = null;
    let scope: "all" | "department" = "all";

    if (canViewAllEmployees(session)) {
      // CEO/ADMIN(전체) — 전체 조회 (필터 옵션 추후 추가 가능)
    } else {
      const ownDept = session.user.departmentId;
      if (ownDept == null) {
        return NextResponse.json(
          { error: "조회 가능한 부서가 없습니다." },
          { status: 403 }
        );
      }
      departmentFilter = ownDept;
      scope = "department";
    }

    // 정책: grace_minutes (60 기본)
    const policy = await prisma.policySetting.findUnique({
      where: { key: "debounce_minutes" },
    });
    const graceMinutes =
      policy && /^\d+$/.test(policy.value) ? parseInt(policy.value, 10) : 60;

    // 활성 직원 조회
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

    if (employeeIds.length === 0) {
      return NextResponse.json({
        scope,
        departmentId: departmentFilter,
        asOf: new Date().toISOString(),
        graceMinutes,
        rows: [],
      });
    }

    // 1쿼리 — 각 직원의 오늘(KST) 최신 presence_raw row + 오늘 check_in
    type LatestRow = {
      employee_id: number;
      latest_status: string | null;
      latest_checked_at: Date | null;
      latest_location: string | null;
      today_check_in: Date | null;
    };

    const latestRows = await prisma.$queryRaw<LatestRow[]>`
      WITH today_kst AS (
        SELECT (NOW() AT TIME ZONE 'Asia/Seoul')::date AS d
      ),
      today_raw AS (
        SELECT
          employee_id,
          checked_at,
          status,
          location
        FROM hr.presence_raw
        WHERE employee_id = ANY(${employeeIds}::int[])
          AND (checked_at AT TIME ZONE 'Asia/Seoul')::date = (SELECT d FROM today_kst)
      ),
      latest_per_emp AS (
        SELECT DISTINCT ON (employee_id)
          employee_id,
          status AS latest_status,
          checked_at AS latest_checked_at,
          location AS latest_location
        FROM today_raw
        ORDER BY employee_id, checked_at DESC
      ),
      today_daily AS (
        SELECT employee_id, check_in
        FROM hr.attendance_daily
        WHERE employee_id = ANY(${employeeIds}::int[])
          AND work_date = (SELECT d FROM today_kst)
      )
      SELECT
        e.id AS employee_id,
        l.latest_status,
        l.latest_checked_at,
        l.latest_location,
        d.check_in AS today_check_in
      FROM (SELECT UNNEST(${employeeIds}::int[]) AS id) e
      LEFT JOIN latest_per_emp l ON l.employee_id = e.id
      LEFT JOIN today_daily d ON d.employee_id = e.id
    `;

    // 직원 정보 맵
    const empMap = new Map(employees.map((e) => [e.id, e]));

    // 판정 함수
    const now = Date.now();
    const graceMs = graceMinutes * 60 * 1000;

    const rows = latestRows.map((r) => {
      const emp = empMap.get(r.employee_id);
      let realtimeStatus: "working" | "disconnected" = "disconnected";

      if (r.latest_status === "online") {
        realtimeStatus = "working";
      } else if (r.latest_status === "offline" && r.latest_checked_at) {
        const elapsed = now - r.latest_checked_at.getTime();
        if (elapsed < graceMs) {
          realtimeStatus = "working"; // grace 이내 끊김
        }
      }

      return {
        employeeId: r.employee_id,
        employeeNo: emp?.employeeNo ?? "",
        name: emp?.name ?? "",
        departmentName: emp?.department?.name ?? null,
        positionName: emp?.position?.name ?? null,
        realtimeStatus,
        latestStatus: r.latest_status,
        latestCheckedAt: r.latest_checked_at
          ? r.latest_checked_at.toISOString()
          : null,
        latestLocation: r.latest_location,
        todayCheckIn: r.today_check_in
          ? r.today_check_in.toISOString()
          : null,
      };
    });

    return NextResponse.json({
      scope,
      departmentId: departmentFilter,
      asOf: new Date().toISOString(),
      graceMinutes,
      rows,
    });
  } catch (error) {
    console.error("GET /api/attendance/realtime error:", error);
    return NextResponse.json(
      { error: "실시간 현황 조회 실패" },
      { status: 500 }
    );
  }
}

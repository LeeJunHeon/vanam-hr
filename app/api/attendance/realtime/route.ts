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
//     todayCheckOut: ISO string | null,
//     todayWorkMinutes: number | null,
//     todayAutoStatus: string | null,
//     todayCategoryId: number | null,
//     todayCategoryCode: string | null,
//     todayCategoryName: string | null,
//     todayCategoryColor: string | null,
//     todayIsOverridden: boolean,
//     todayReason: string | null,
//     progressStatus: 'working' | 'away' | 'completed' | 'absent_today'
//                   | 'category_working' | 'category_completed',
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
      today_check_out: Date | null;
      today_work_minutes: number | null;
      today_auto_status: string | null;
      today_category_id: number | null;
      today_category_code: string | null;
      today_category_name: string | null;
      today_category_color: string | null;
      today_is_overridden: boolean | null;
      today_reason: string | null;
      // 외근/출장 등 시간대 일정의 시작/종료 시각 — 시간대 기반 진행상태 판정용
      today_corrected_in: Date | null;
      today_corrected_out: Date | null;
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
        SELECT
          ad.employee_id,
          ad.check_in,
          ad.check_out,
          ad.work_minutes,
          ad.auto_status,
          ad.category_id,
          ad.is_overridden,
          ac.code AS category_code,
          ac.name AS category_name,
          ac.display_color AS category_color
        FROM hr.attendance_daily ad
        LEFT JOIN hr.attendance_categories ac ON ac.id = ad.category_id
        WHERE ad.employee_id = ANY(${employeeIds}::int[])
          AND ad.work_date = (SELECT d FROM today_kst)
      ),
      today_request AS (
        SELECT DISTINCT ON (employee_id)
          employee_id,
          reason,
          corrected_check_in,
          corrected_check_out
        FROM hr.attendance_requests
        WHERE employee_id = ANY(${employeeIds}::int[])
          AND status IN ('approved', 'auto_approved', 'auto_delegated')
          AND start_date <= (SELECT d FROM today_kst)
          AND end_date >= (SELECT d FROM today_kst)
        ORDER BY
          employee_id,
          -- 1순위: 지금 진행 중인 시간형 일정 (현재 시각 포함)
          (
            corrected_check_in IS NOT NULL
            AND corrected_check_out IS NOT NULL
            AND corrected_check_in <= NOW()
            AND corrected_check_out > NOW()
          ) DESC,
          -- 2순위: 이미 시작된(과거) 시간형 일정 — 늦게 끝난 것 우선
          (
            corrected_check_in IS NOT NULL
            AND corrected_check_in <= NOW()
          ) DESC,
          -- 3순위: 종일 일정 (시간형이 진행/과거에 없을 때만)
          (corrected_check_in IS NULL OR corrected_check_out IS NULL) DESC,
          -- 4순위: 미래 시작 시간형은 가장 뒤로
          corrected_check_out DESC NULLS LAST,
          requested_at DESC
      )
      SELECT
        e.id AS employee_id,
        l.latest_status,
        l.latest_checked_at,
        l.latest_location,
        d.check_in AS today_check_in,
        d.check_out AS today_check_out,
        d.work_minutes AS today_work_minutes,
        d.auto_status AS today_auto_status,
        d.category_id AS today_category_id,
        d.category_code AS today_category_code,
        d.category_name AS today_category_name,
        d.category_color AS today_category_color,
        d.is_overridden AS today_is_overridden,
        r.reason AS today_reason,
        r.corrected_check_in AS today_corrected_in,
        r.corrected_check_out AS today_corrected_out
      FROM (SELECT UNNEST(${employeeIds}::int[]) AS id) e
      LEFT JOIN latest_per_emp l ON l.employee_id = e.id
      LEFT JOIN today_daily d ON d.employee_id = e.id
      LEFT JOIN today_request r ON r.employee_id = e.id
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

      // progressStatus: 클라이언트 편의 분류
      // 캘린더 보정(is_overridden + category_id) 우선. 그 안에서:
      //  - 시간대 일정(corrected_check_in/out 둘 다 있음, 예 외근 09:00~12:00):
      //    * now < cal_in            → 일정 시작 전: 캘린더 분기 skip, 일반 WiFi 로직으로 흐름
      //    * cal_in <= now < cal_out → "category_working"
      //    * now >= cal_out:
      //        realtimeStatus='working'             → "working"  (복귀해 자리에 있음)
      //        elif check_out > cal_out             → "completed" (복귀 후 정상 퇴근)
      //        else                                  → "category_completed" (미복귀)
      //  - 종일 일정(corrected 없음, 예 휴가): check_out 유무로 working/completed (기존 동작)
      // 일반(WiFi) 분기:
      //  - latestStatus 없음 → absent_today
      //  - online → working
      //  - offline + grace 미경과 → away / 경과 → completed
      let progressStatus:
        | "working"
        | "away"
        | "completed"
        | "absent_today"
        | "category_working"
        | "category_completed"
        | null = null;

      if (r.today_is_overridden && r.today_category_id !== null) {
        const calIn = r.today_corrected_in;
        const calOut = r.today_corrected_out;
        const isTimedCalendar = !!(calIn && calOut);
        if (isTimedCalendar) {
          const calInMs = calIn!.getTime();
          const calOutMs = calOut!.getTime();
          if (now < calInMs) {
            // 일정 시작 전 — 캘린더 분기 skip, 아래 WiFi 로직으로 흐른다.
            progressStatus = null;
          } else if (now < calOutMs) {
            progressStatus = "category_working";
          } else {
            // 종료 후
            if (realtimeStatus === "working") {
              progressStatus = "working";
            } else if (
              r.today_check_out &&
              r.today_check_out.getTime() > calOutMs
            ) {
              progressStatus = "completed";
            } else {
              progressStatus = "category_completed";
            }
          }
        } else {
          // 종일 일정 — 기존 동작 유지
          progressStatus = r.today_check_out
            ? "category_completed"
            : "category_working";
        }
      }

      if (progressStatus === null) {
        if (r.latest_status === null) {
          progressStatus = "absent_today";
        } else if (r.latest_status === "online") {
          progressStatus = "working";
        } else if (r.latest_status === "offline" && r.latest_checked_at) {
          const elapsed = now - r.latest_checked_at.getTime();
          progressStatus = elapsed < graceMs ? "away" : "completed";
        } else {
          // offline인데 checked_at이 없는 비정상 케이스 → 미출근 취급
          progressStatus = "absent_today";
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
        todayCheckOut: r.today_check_out
          ? r.today_check_out.toISOString()
          : null,
        todayWorkMinutes:
          r.today_work_minutes !== null && r.today_work_minutes !== undefined
            ? Number(r.today_work_minutes)
            : null,
        todayAutoStatus: r.today_auto_status ?? null,
        todayCategoryId: r.today_category_id ?? null,
        todayCategoryCode: r.today_category_code ?? null,
        todayCategoryName: r.today_category_name ?? null,
        todayCategoryColor: r.today_category_color ?? null,
        todayIsOverridden: r.today_is_overridden ?? false,
        todayReason: r.today_reason ?? null,
        progressStatus,
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

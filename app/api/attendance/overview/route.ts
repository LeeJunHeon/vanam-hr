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
              status: { in: ["approved", "auto_approved", "auto_delegated"] },
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
              requestedAt: true,
            },
            orderBy: { requestedAt: "asc" },
          })
        : [];

    // employeeId_YYYY-MM-DD → reason 매핑 (start~end 범위 모든 날짜에 동일 reason)
    // 그리고 같은 키 형식으로 corrected_check_in/out 시간대도 매핑(시간대 일정만 값 존재).
    // employeeId_YYYY-MM-DD → 대표 요청. 같은 날 여러 건이면 시간형(시작 빠른 순) 우선,
    // 시간형이 없으면 종일. requests는 requestedAt asc 정렬되어 있음.
    const reasonMap = new Map<string, string>();
    const correctedMap = new Map<
      string,
      { in: string | null; out: string | null }
    >();
    // 대표 선택용: 키별로 현재 채택된 요청의 "우선순위 점수"와 시작시각 보관
    const pickMeta = new Map<string, { timed: boolean; startMs: number }>();

    for (const req of requests) {
      const isTimed = !!(req.correctedCheckIn && req.correctedCheckOut);
      const startMs = req.correctedCheckIn
        ? req.correctedCheckIn.getTime()
        : Number.POSITIVE_INFINITY;
      const start = new Date(req.startDate);
      const end = new Date(req.endDate);
      const d = new Date(start);
      while (d <= end) {
        const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(
          2,
          "0"
        )}-${String(d.getDate()).padStart(2, "0")}`;
        const key = `${req.employeeId}_${ymd}`;

        const prev = pickMeta.get(key);
        // 채택 규칙: 시간형이 종일보다 우선, 시간형끼리는 시작 빠른 것 우선.
        let take = false;
        if (!prev) {
          take = true;
        } else if (isTimed && !prev.timed) {
          take = true; // 종일 → 시간형으로 교체
        } else if (isTimed && prev.timed && startMs < prev.startMs) {
          take = true; // 더 일찍 시작하는 시간형
        }

        if (take) {
          pickMeta.set(key, { timed: isTimed, startMs });
          reasonMap.set(key, req.reason ?? "");
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

    // ── 오늘(KST) WiFi 첫 연결 / 마지막 끊김 ──
    const _nowKst = new Date(Date.now() + 9 * 60 * 60 * 1000);
    const _ky = _nowKst.getUTCFullYear();
    const _km = _nowKst.getUTCMonth();
    const _kd = _nowKst.getUTCDate();
    const _pad = (n: number) => String(n).padStart(2, "0");
    const todayYmdKst = `${_ky}-${_pad(_km + 1)}-${_pad(_kd)}`;
    const todayStartUtc = new Date(Date.UTC(_ky, _km, _kd) - 9 * 60 * 60 * 1000);
    const todayEndUtc = new Date(todayStartUtc.getTime() + 24 * 60 * 60 * 1000);

    const firstOnlineMap = new Map<number, Date>();
    const lastOnlineMap = new Map<number, Date>();
    const lastOfflineMap = new Map<number, Date>();
    if (employeeIds.length > 0) {
      const [firstOnline, lastOffline] = await Promise.all([
        prisma.presenceRaw.groupBy({
          by: ["employeeId"],
          where: {
            employeeId: { in: employeeIds },
            status: "online",
            checkedAt: { gte: todayStartUtc, lt: todayEndUtc },
          },
          _min: { checkedAt: true },
          _max: { checkedAt: true },
        }),
        prisma.presenceRaw.groupBy({
          by: ["employeeId"],
          where: {
            employeeId: { in: employeeIds },
            status: "offline",
            checkedAt: { gte: todayStartUtc, lt: todayEndUtc },
          },
          _max: { checkedAt: true },
        }),
      ]);
      for (const row of firstOnline) {
        if (row.employeeId != null && row._min.checkedAt) {
          firstOnlineMap.set(row.employeeId, row._min.checkedAt);
        }
        if (row.employeeId != null && row._max.checkedAt) {
          lastOnlineMap.set(row.employeeId, row._max.checkedAt);
        }
      }
      for (const row of lastOffline) {
        if (row.employeeId != null && row._max.checkedAt) {
          lastOfflineMap.set(row.employeeId, row._max.checkedAt);
        }
      }
    }

    // 마지막 끊김이 마지막 연결보다 나중일 때만 "퇴근"으로 인정 (재연결 시 제외)
    const wifiOutMap = new Map<number, Date>();
    for (const [empId, lastOff] of lastOfflineMap) {
      const lastOn = lastOnlineMap.get(empId);
      if (!lastOn || lastOff > lastOn) {
        wifiOutMap.set(empId, lastOff);
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
        wifiCheckIn: ymd === todayYmdKst ? (firstOnlineMap.get(a.employeeId)?.toISOString() ?? null) : null,
        wifiCheckOut: ymd === todayYmdKst ? (wifiOutMap.get(a.employeeId)?.toISOString() ?? null) : null,
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

import { NextRequest, NextResponse } from "next/server";
import { kstTodayMidnightUtc } from "@/lib/kst-date";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth-helpers";
import { loadWorkDayChecker } from "@/lib/annual-leave";
import {
  isLeaveCategoryType,
  isNonWorkDayLeave,
  isWorkCategoryType,
  WORK_CATEGORY_TYPES,
} from "@/lib/category-kind";
import { rowEvalKeys } from "@/lib/attendance-summary";
import { countPendingInbox } from "@/lib/approval-inbox";
import { LIVE_REQUEST_STATUSES } from "@/lib/attendance-live-requests";

// GET /api/dashboard/stats?period=day|month|year&targetDate=YYYY-MM-DD&targetMonth=YYYY-MM&targetYear=YYYY
//
// 기간 내 "문제 근태(결근/지각/조퇴) + 휴가 + 출장·외근·재택"을 건수로 집계하고
// 각 항목의 상세 목록을 함께 반환한다.
// pendingRequests는 기간 무관. 로그인 사용자의 결재함 '결재 대기' 탭과 같은 범위(lib/approval-inbox).
export async function GET(request: NextRequest) {
  try {
    const _auth = await requireAdmin();
    if (!_auth.ok) return _auth.response;
    const viewerRole = _auth.session.user.role;
    const myEmployeeId = _auth.session.user.employeeId;

    const { searchParams } = new URL(request.url);
    const period = (searchParams.get("period") || "month") as
      | "day"
      | "month"
      | "year";
    const targetDate = searchParams.get("targetDate"); // YYYY-MM-DD
    const targetMonth = searchParams.get("targetMonth"); // YYYY-MM
    const targetYear = searchParams.get("targetYear"); // YYYY

    const now = new Date();

    // 기간 범위 계산 (KST 기준이 아닌 서버 시각 기준 — Prisma가 자동 변환)
    let rangeStart: Date;
    let rangeEnd: Date;

    // KST 기준 "오늘" (lib/kst-date — 서버가 UTC여도 한국 날짜)
    const kstToday = kstTodayMidnightUtc();
    const kstY = kstToday.getUTCFullYear();
    const kstM = kstToday.getUTCMonth();
    const kstD = kstToday.getUTCDate();

    if (period === "day") {
      let y = kstY, m = kstM, dd = kstD;
      if (targetDate && /^\d{4}-\d{2}-\d{2}$/.test(targetDate)) {
        const parts = targetDate.split("-");
        y = Number(parts[0]);
        m = Number(parts[1]) - 1;
        dd = Number(parts[2]);
      }
      // work_date(DATE)는 UTC 자정으로 저장되므로 range도 UTC 자정 기준으로 생성
      rangeStart = new Date(Date.UTC(y, m, dd));
      rangeEnd = new Date(Date.UTC(y, m, dd + 1));
    } else if (period === "month") {
      let y = kstY, m = kstM;
      if (targetMonth && /^\d{4}-\d{2}$/.test(targetMonth)) {
        const parts = targetMonth.split("-");
        y = Number(parts[0]);
        m = Number(parts[1]) - 1;
      }
      rangeStart = new Date(Date.UTC(y, m, 1));
      rangeEnd = new Date(Date.UTC(y, m + 1, 1));
    } else {
      // year
      let y = kstY;
      if (targetYear && /^\d{4}$/.test(targetYear)) {
        y = Number(targetYear);
      }
      rangeStart = new Date(Date.UTC(y, 0, 1));
      rangeEnd = new Date(Date.UTC(y + 1, 0, 1));
    }

    const [pendingInbox, dailies] = await Promise.all([
      // 결재 대기 — 로그인 사용자의 결재함 "결재 대기" 탭과 같은 범위.
      // 직원 미매핑이면 결재함 자체가 없으므로 0.
      Number.isInteger(myEmployeeId)
        ? countPendingInbox({ approverId: myEmployeeId as number, role: viewerRole })
        : Promise.resolve({ attendance: 0, trip: 0, invites: 0, total: 0 }),
      // 기간 내 attendance_daily — employee/category include 후 메모리 분류
      prisma.attendanceDaily.findMany({
        where: { workDate: { gte: rangeStart, lt: rangeEnd } },
        include: {
          employee: {
            select: {
              id: true,
              name: true,
              department: { select: { name: true } },
            },
          },
          category: {
            select: { code: true, name: true, type: true },
          },
        },
        orderBy: { workDate: "desc" },
      }),
    ]);

    // 결재 대기 = 근태·휴가 pending + 출장 결재 이벤트 수 + 내 출장 초대 수
    const pendingRequests = pendingInbox.total;
    const pendingBreakdown = {
      attendance: pendingInbox.attendance,
      trip: pendingInbox.trip,
      invites: pendingInbox.invites,
    };

    // 공통 필드 추출 헬퍼
    const base = (d: (typeof dailies)[number]) => ({
      employeeId: d.employee.id,
      name: d.employee.name,
      departmentName: d.employee.department?.name ?? null,
      workDate: d.workDate.toISOString().split("T")[0],
    });
    const iso = (v: Date | null) => (v ? v.toISOString() : null);

    // 출장·외근·재택 시간대(corrected_check_in/out) 조회 — attendance_requests에서.
    // details의 근무 type 행에 "09:00~12:00" 시간을 표시하기 위함.
    // 대표 시각은 lib/attendance-rows 와 같은 규칙: 시간형이 종일보다 우선, 시간형끼리는 시작이 늦은 것.
    const tripDailies = dailies.filter((d) => isWorkCategoryType(d.category?.type));
    const correctedTimeMap = new Map<
      string,
      { in: string | null; out: string | null; timed: boolean; startMs: number }
    >();
    if (tripDailies.length > 0) {
      const empIds = Array.from(new Set(tripDailies.map((d) => d.employeeId)));
      const reqs = await prisma.attendanceRequest.findMany({
        where: {
          employeeId: { in: empIds },
          status: { in: LIVE_REQUEST_STATUSES },
          startDate: { lte: rangeEnd },
          endDate: { gte: rangeStart },
          category: { type: { in: WORK_CATEGORY_TYPES } },
        },
        select: {
          employeeId: true,
          startDate: true,
          endDate: true,
          correctedCheckIn: true,
          correctedCheckOut: true,
        },
        orderBy: { requestedAt: "asc" },
      });
      // 각 일자별로 펼쳐 맵에 저장 (key = employeeId_YYYY-MM-DD)
      for (const req of reqs) {
        const timed = !!(req.correctedCheckIn && req.correctedCheckOut);
        const startMs = req.correctedCheckIn
          ? req.correctedCheckIn.getTime()
          : Number.POSITIVE_INFINITY;
        const cur = new Date(req.startDate);
        const end = new Date(req.endDate);
        while (cur <= end) {
          const ymd = cur.toISOString().split("T")[0];
          const key = `${req.employeeId}_${ymd}`;
          const prev = correctedTimeMap.get(key);
          const take =
            !prev ||
            (timed && !prev.timed) ||
            (timed && prev.timed && startMs > prev.startMs);
          if (take) {
            correctedTimeMap.set(key, {
              in: req.correctedCheckIn ? req.correctedCheckIn.toISOString() : null,
              out: req.correctedCheckOut ? req.correctedCheckOut.toISOString() : null,
              timed,
              startMs,
            });
          }
          cur.setUTCDate(cur.getUTCDate() + 1);
        }
      }
    }

    const details = {
      absent: [] as Array<ReturnType<typeof base>>,
      late: [] as Array<ReturnType<typeof base> & { checkIn: string | null }>,
      earlyLeave: [] as Array<
        ReturnType<typeof base> & { checkIn: string | null; checkOut: string | null }
      >,
      leave: [] as Array<ReturnType<typeof base> & { categoryName: string | null }>,
      tripExternal: [] as Array<
        ReturnType<typeof base> & {
          categoryName: string | null;
          reason: string | null;
          checkIn: string | null;
          checkOut: string | null;
        }
      >,
    };

    // 휴가자 집계는 근무일이 아닌 날(시프트 휴무·주말·공휴일)의 휴가 행은 세지 않는다.
    // (aggregator 는 캘린더 표시용으로 주말에도 연차 행을 만든다)
    const leaveEmpIds = Array.from(
      new Set(
        dailies
          .filter((d) => isLeaveCategoryType(d.category?.type))
          .map((d) => d.employeeId)
      )
    );
    const isWorkDay = await loadWorkDayChecker(
      leaveEmpIds,
      rangeStart.toISOString().split("T")[0],
      new Date(rangeEnd.getTime() - 86400000).toISOString().split("T")[0]
    );

    for (const d of dailies) {
      const categoryName = d.category?.name ?? null;
      const isLeave = isLeaveCategoryType(d.category?.type);

      // 휴가 / 출장·외근·재택 (category type 기준)
      if (isWorkCategoryType(d.category?.type)) {
        const t = correctedTimeMap.get(`${d.employeeId}_${d.workDate.toISOString().split("T")[0]}`);
        details.tripExternal.push({
          ...base(d), categoryName, reason: null,
          checkIn: t?.in ?? null, checkOut: t?.out ?? null,
        });
      } else if (isLeave && !isNonWorkDayLeave(d.category?.type, isWorkDay(d.employeeId, d.workDate))) {
        details.leave.push({ ...base(d), categoryName });
      }

      // 문제 근태 — 평가 키 기준(lib/attendance-summary). 지각·조퇴 둘 다면 두 목록 모두에 넣는다.
      const keys = rowEvalKeys(d);
      if (keys.includes("absent")) details.absent.push(base(d));
      if (keys.includes("late")) details.late.push({ ...base(d), checkIn: iso(d.checkIn) });
      if (keys.includes("early_leave")) {
        details.earlyLeave.push({
          ...base(d),
          checkIn: iso(d.checkIn),
          checkOut: iso(d.checkOut),
        });
      }
    }

    const counts = {
      absent: details.absent.length,
      late: details.late.length,
      earlyLeave: details.earlyLeave.length,
      leave: details.leave.length,
      tripExternal: details.tripExternal.length,
    };

    return NextResponse.json({
      period,
      range: {
        start: rangeStart.toISOString(),
        end: rangeEnd.toISOString(),
      },
      asOf: now.toISOString(),
      pendingRequests,
      pendingBreakdown,
      counts,
      details,
    });
  } catch (error) {
    console.error("GET /api/dashboard/stats error:", error);
    return NextResponse.json(
      { error: "대시보드 통계 조회 실패" },
      { status: 500 }
    );
  }
}

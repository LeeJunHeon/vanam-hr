import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth-helpers";

// GET /api/dashboard/stats?period=day|month|year&targetDate=YYYY-MM-DD&targetMonth=YYYY-MM&targetYear=YYYY
//
// 기간 내 "문제 근태(결근/지각/조퇴) + 휴가 + 출장 + 외근"을 건수로 집계하고
// 각 항목의 상세 목록을 함께 반환한다. pendingRequests는 기간 무관 현재 pending 전체.
export async function GET(request: NextRequest) {
  try {
    const _auth = await requireAdmin();
    if (!_auth.ok) return _auth.response;

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

    // KST 기준 "오늘"을 구하기 위한 보정 (서버가 UTC여도 한국 날짜를 쓰도록)
    const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
    const nowKst = new Date(now.getTime() + KST_OFFSET_MS);
    const kstY = nowKst.getUTCFullYear();
    const kstM = nowKst.getUTCMonth();
    const kstD = nowKst.getUTCDate();

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

    const [attendancePending, dailies, pendingTripEvents] = await Promise.all([
      // 결재 대기 (기간 무관, 현재 pending 전체) — 근태/휴가 신청
      prisma.attendanceRequest.count({ where: { status: "pending" } }),
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
            select: { code: true, name: true, annualLeaveDeduct: true },
          },
        },
        orderBy: { workDate: "desc" },
      }),
      // 출장 결재 대기 — approval_status='pending' 참석자가 1명 이상인 active trip_event 단위.
      // (결재함의 출장 카드 1장 = 이벤트 1건과 일치. 결재자 필터 없이 전사 기준.)
      prisma.tripParticipant.groupBy({
        by: ["tripEventId"],
        where: { approvalStatus: "pending", tripEvent: { status: "active" } },
      }),
    ]);

    // 결재 대기 = 근태/휴가 신청(pending) + 출장 결재 대기 이벤트 수
    const pendingRequests = attendancePending + pendingTripEvents.length;

    // 공통 필드 추출 헬퍼
    const base = (d: (typeof dailies)[number]) => ({
      employeeId: d.employee.id,
      name: d.employee.name,
      departmentName: d.employee.department?.name ?? null,
      workDate: d.workDate.toISOString().split("T")[0],
    });
    const iso = (v: Date | null) => (v ? v.toISOString() : null);

    // 출장/외근 시간대(corrected_check_in/out) 조회 — attendance_requests에서.
    // details의 출장/외근 행에 "09:00~12:00" 시간을 표시하기 위함.
    // 대상: 이번 기간 dailies 중 BUSINESS_TRIP/EXTERNAL_WORK인 (employeeId, workDate).
    const tripDailies = dailies.filter(
      (d) => d.category?.code === "BUSINESS_TRIP" || d.category?.code === "EXTERNAL_WORK"
    );
    const correctedTimeMap = new Map<string, { in: string | null; out: string | null }>();
    if (tripDailies.length > 0) {
      const empIds = Array.from(new Set(tripDailies.map((d) => d.employeeId)));
      const reqs = await prisma.attendanceRequest.findMany({
        where: {
          employeeId: { in: empIds },
          status: { in: ["approved", "auto_approved", "auto_delegated"] },
          startDate: { lte: rangeEnd },
          endDate: { gte: rangeStart },
          category: { code: { in: ["BUSINESS_TRIP", "EXTERNAL_WORK"] } },
        },
        select: {
          employeeId: true,
          startDate: true,
          endDate: true,
          correctedCheckIn: true,
          correctedCheckOut: true,
        },
      });
      // 각 일자별로 펼쳐 맵에 저장 (key = employeeId_YYYY-MM-DD)
      for (const req of reqs) {
        const cur = new Date(req.startDate);
        const end = new Date(req.endDate);
        while (cur <= end) {
          const ymd = cur.toISOString().split("T")[0];
          const key = `${req.employeeId}_${ymd}`;
          if (!correctedTimeMap.has(key)) {
            correctedTimeMap.set(key, {
              in: req.correctedCheckIn ? req.correctedCheckIn.toISOString() : null,
              out: req.correctedCheckOut ? req.correctedCheckOut.toISOString() : null,
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

    for (const d of dailies) {
      const code = d.category?.code ?? null;
      const categoryName = d.category?.name ?? null;
      const isLeave = d.category?.annualLeaveDeduct != null;

      // 휴가/출장/외근 (category 기준) — 이 행들은 auto_status가 normal이라
      // 결근/지각/조퇴 분류와 공존하지 않음
      if (code === "BUSINESS_TRIP" || code === "EXTERNAL_WORK") {
        const t = correctedTimeMap.get(`${d.employeeId}_${d.workDate.toISOString().split("T")[0]}`);
        details.tripExternal.push({
          ...base(d), categoryName, reason: null,
          checkIn: t?.in ?? null, checkOut: t?.out ?? null,
        });
      } else if (isLeave) {
        details.leave.push({ ...base(d), categoryName });
      }

      // 문제 근태 (auto_status 기준)
      switch (d.autoStatus) {
        case "absent":
          details.absent.push(base(d));
          break;
        case "late":
          details.late.push({ ...base(d), checkIn: iso(d.checkIn) });
          break;
        case "early_leave":
          details.earlyLeave.push({
            ...base(d),
            checkIn: iso(d.checkIn),
            checkOut: iso(d.checkOut),
          });
          break;
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

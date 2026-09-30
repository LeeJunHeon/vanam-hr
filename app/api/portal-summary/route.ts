import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/auth-helpers";
import { progressLabel } from "@/lib/attendanceLabels";
import { loadWorkDayChecker } from "@/lib/annual-leave";
import { computeProgressStatus } from "@/lib/realtime-presence";
import { summarizeDays } from "@/lib/attendance-summary";
import { loadTodayWorkDate } from "@/lib/kst-date";

export const dynamic = "force-dynamic";

// 미인증/직원 미매핑 공통 빈 응답 (포털에서 조용히 처리)
function emptyResponse() {
  return NextResponse.json(
    {
      hasEmployee: false,
      progressStatus: "unknown",
      statusLabel: "",
      week: { normal: 0, late: 0, earlyLeave: 0, absent: 0 },
    }
  );
}

// isVacationCategory / isLabelOnlyCategory / progressLabel 은 lib/attendanceLabels로 통합(3단계 dedupe).
// ⚠ 의도된 미세 통일: category_completed에서 카테고리명이 없을 때 폴백이 기존 "완료" → lib(OverviewPage 규칙) "부재중".
//    (category_* 상태는 카테고리 존재 시에만 세팅되어 실제로는 도달 불가능한 분기.)

// GET /api/portal-summary — 포털 근태 카드용. 본인 오늘 진행상태(realtime과 동일) + 이번주 집계.
// - 오늘 = 근무일(work_date_cutoff_hour 기준). presence_raw 귀속도 cutoff 기준 — 실시간 현황과 같다.
// - 진행 상태 = lib/realtime-presence computeProgressStatus (실시간 현황 카드와 같은 함수).
// - 이번 주 집계 = lib/attendance-summary summarizeDays (응답 필드 normal·late·earlyLeave·absent 유지).
export async function GET() {
  try {
    const r = await requireSession();
    if (!r.ok) return emptyResponse();
    const employeeId = r.session.user.employeeId;
    if (!Number.isInteger(employeeId)) return emptyResponse();
    const empId = employeeId as number;

    // grace 분 (debounce_minutes, 기본 60) — realtime 라우트와 동일
    const policy = await prisma.policySetting.findUnique({
      where: { key: "debounce_minutes" },
    });
    const graceMinutes =
      policy && /^\d+$/.test(policy.value) ? parseInt(policy.value, 10) : 60;
    const { date: todayWorkDate, ymd: todayYmd, cutoffHour } = await loadTodayWorkDate(prisma);

    // ── 본인 오늘(근무일) 최신 presence_raw + attendance_daily + 대표 신청 1건 ──
    type DetailRow = {
      latest_status: string | null;
      latest_checked_at: Date | null;
      today_check_out: Date | null;
      today_category_id: number | null;
      today_category_code: string | null;
      today_category_name: string | null;
      today_is_overridden: boolean | null;
      today_corrected_in: Date | null;
      today_corrected_out: Date | null;
    };

    const detailRows = await prisma.$queryRaw<DetailRow[]>`
      WITH today_kst AS (
        SELECT ${todayYmd}::date AS d
      ),
      latest_raw AS (
        SELECT status AS latest_status, checked_at AS latest_checked_at
        FROM hr.presence_raw
        WHERE employee_id = ${empId}
          AND CASE
            WHEN EXTRACT(HOUR FROM (checked_at AT TIME ZONE 'Asia/Seoul')) < ${cutoffHour}
            THEN ((checked_at AT TIME ZONE 'Asia/Seoul')::date - INTERVAL '1 day')::date
            ELSE (checked_at AT TIME ZONE 'Asia/Seoul')::date
          END = (SELECT d FROM today_kst)
        ORDER BY checked_at DESC
        LIMIT 1
      ),
      today_daily AS (
        SELECT
          ad.check_out,
          ad.category_id,
          ad.is_overridden,
          ac.code AS category_code,
          ac.name AS category_name
        FROM hr.attendance_daily ad
        LEFT JOIN hr.attendance_categories ac ON ac.id = ad.category_id
        WHERE ad.employee_id = ${empId}
          AND ad.work_date = (SELECT d FROM today_kst)
        LIMIT 1
      ),
      today_request AS (
        -- 진행 상태 판정용 대표 신청 (realtime 과 같은 순서). 근태 정정은 일정이 아니므로 뺀다.
        SELECT rq.corrected_check_in, rq.corrected_check_out
        FROM hr.attendance_requests rq
        JOIN hr.attendance_categories rc ON rc.id = rq.category_id
        WHERE rq.employee_id = ${empId}
          AND rq.status IN ('approved', 'auto_approved', 'auto_delegated')
          AND rq.start_date <= (SELECT d FROM today_kst)
          AND rq.end_date >= (SELECT d FROM today_kst)
          AND rc.type <> 'correction'
        ORDER BY
          (
            rq.corrected_check_in IS NOT NULL
            AND rq.corrected_check_out IS NOT NULL
            AND rq.corrected_check_in <= NOW()
            AND rq.corrected_check_out > NOW()
          ) DESC,
          (
            rq.corrected_check_in IS NOT NULL
            AND rq.corrected_check_in <= NOW()
          ) DESC,
          (rq.corrected_check_in IS NULL OR rq.corrected_check_out IS NULL) DESC,
          rq.corrected_check_out DESC NULLS LAST,
          rq.requested_at DESC
        LIMIT 1
      )
      SELECT
        l.latest_status,
        l.latest_checked_at,
        d.check_out AS today_check_out,
        d.category_id AS today_category_id,
        d.category_code AS today_category_code,
        d.category_name AS today_category_name,
        d.is_overridden AS today_is_overridden,
        r.corrected_check_in AS today_corrected_in,
        r.corrected_check_out AS today_corrected_out
      FROM (SELECT 1) one
      LEFT JOIN latest_raw l ON true
      LEFT JOIN today_daily d ON true
      LEFT JOIN today_request r ON true
    `;

    const row = detailRows[0];
    const progressStatus = computeProgressStatus({
      latestStatus: row?.latest_status ?? null,
      latestCheckedAt: row?.latest_checked_at ?? null,
      todayCheckOut: row?.today_check_out ?? null,
      todayIsOverridden: row?.today_is_overridden ?? false,
      todayCategoryId: row?.today_category_id ?? null,
      todayCorrectedIn: row?.today_corrected_in ?? null,
      todayCorrectedOut: row?.today_corrected_out ?? null,
      graceMs: graceMinutes * 60 * 1000,
      now: Date.now(),
    });

    const statusLabel = progressLabel(
      progressStatus,
      row?.today_category_name ?? null,
      row?.today_category_code ?? null
    );

    // ── 이번주(오늘 근무일이 속한 월~일) attendance_daily 집계 ──
    const monday = new Date(todayWorkDate);
    monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
    const sunday = new Date(monday);
    sunday.setUTCDate(sunday.getUTCDate() + 6);
    const weekDailies = await prisma.attendanceDaily.findMany({
      where: { employeeId: empId, workDate: { gte: monday, lte: sunday } },
      select: {
        workDate: true,
        checkIn: true,
        checkOut: true,
        autoStatus: true,
        isLate: true,
        isEarlyLeave: true,
        category: { select: { type: true } },
      },
    });

    const week = { normal: 0, late: 0, earlyLeave: 0, absent: 0 };
    if (weekDailies.length > 0) {
      const ymd = (d: Date) => d.toISOString().split("T")[0];
      const isWorkDay = await loadWorkDayChecker([empId], ymd(monday), ymd(sunday));
      const s = summarizeDays(
        weekDailies.map((w) => ({
          checkIn: w.checkIn,
          checkOut: w.checkOut,
          autoStatus: w.autoStatus,
          isLate: w.isLate,
          isEarlyLeave: w.isEarlyLeave,
          categoryType: w.category?.type ?? null,
          isWorkDay: isWorkDay(empId, w.workDate),
        }))
      );
      week.normal = s.normal;
      week.late = s.late;
      week.earlyLeave = s.earlyLeave;
      week.absent = s.absent;
    }

    return NextResponse.json(
      { hasEmployee: true, progressStatus, statusLabel, week }
    );
  } catch (error) {
    console.error("GET /api/portal-summary error:", error);
    return emptyResponse();
  }
}

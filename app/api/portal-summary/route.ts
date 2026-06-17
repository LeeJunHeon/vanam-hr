import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/auth-helpers";

export const dynamic = "force-dynamic";

const corsHeaders = {
  "Access-Control-Allow-Origin": "https://vanam.synology.me",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Credentials": "true",
};

type ProgressStatus =
  | "working"
  | "away"
  | "completed"
  | "absent_today"
  | "category_working"
  | "category_completed";

// 미인증/직원 미매핑 공통 빈 응답 (포털에서 조용히 처리)
function emptyResponse() {
  return NextResponse.json(
    {
      hasEmployee: false,
      progressStatus: "unknown",
      statusLabel: "",
      week: { normal: 0, late: 0, earlyLeave: 0, absent: 0 },
    },
    { headers: corsHeaders }
  );
}

// 휴가류 카테고리 — AttendanceOverviewPage와 동일
function isVacationCategory(code: string | null): boolean {
  if (!code) return false;
  return ["ANNUAL", "HALF_AM", "HALF_PM", "SICK", "FAMILY_EVENT"].includes(code);
}

// "진행/완료" 접미사 없이 카테고리명만 표시 = 휴가류 + 기타(ETC)
function isLabelOnlyCategory(code: string | null): boolean {
  return isVacationCategory(code) || code === "ETC";
}

// 진행 상태 한글 라벨 — AttendanceOverviewPage의 progressLabel과 동일 규칙
function progressLabel(
  s: ProgressStatus,
  categoryName: string | null,
  categoryCode: string | null
): string {
  switch (s) {
    case "working":
      return "근무중";
    case "away":
      return "자리비움";
    case "completed":
      return "완료";
    case "absent_today":
      return "미출근";
    case "category_working":
      if (categoryName) {
        return isLabelOnlyCategory(categoryCode)
          ? categoryName // "연차"/"병가"/"기타" 등 (접미사 X)
          : `${categoryName}중`; // "외근중"
      }
      return "부재중";
    case "category_completed":
      if (categoryName) {
        return isLabelOnlyCategory(categoryCode)
          ? categoryName // "연차"/"기타" 등 (접미사 X)
          : `${categoryName}완료`; // "외근완료"
      }
      return "완료";
  }
}

// GET /api/portal-summary — 포털 근태 카드용. 본인 오늘 진행상태(realtime과 동일) + 이번주 집계.
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

    // ── 본인 오늘(KST) 최신 presence_raw + attendance_daily + 활성 요청 1건 ──
    // realtime 라우트의 latestRows 쿼리를 본인 1명 기준으로 복제.
    type DetailRow = {
      latest_status: string | null;
      latest_checked_at: Date | null;
      today_check_in: Date | null;
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
        SELECT (NOW() AT TIME ZONE 'Asia/Seoul')::date AS d
      ),
      latest_raw AS (
        SELECT status AS latest_status, checked_at AS latest_checked_at
        FROM hr.presence_raw
        WHERE employee_id = ${empId}
          AND (checked_at AT TIME ZONE 'Asia/Seoul')::date = (SELECT d FROM today_kst)
        ORDER BY checked_at DESC
        LIMIT 1
      ),
      today_daily AS (
        SELECT
          ad.check_in,
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
        SELECT corrected_check_in, corrected_check_out
        FROM hr.attendance_requests
        WHERE employee_id = ${empId}
          AND status IN ('approved', 'auto_approved', 'auto_delegated')
          AND start_date <= (SELECT d FROM today_kst)
          AND end_date >= (SELECT d FROM today_kst)
        ORDER BY
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
        LIMIT 1
      )
      SELECT
        l.latest_status,
        l.latest_checked_at,
        d.check_in AS today_check_in,
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

    const row: DetailRow = detailRows[0] ?? {
      latest_status: null,
      latest_checked_at: null,
      today_check_in: null,
      today_check_out: null,
      today_category_id: null,
      today_category_code: null,
      today_category_name: null,
      today_is_overridden: null,
      today_corrected_in: null,
      today_corrected_out: null,
    };

    // ── realtimeStatus 산출 (realtime과 동일) ──
    const now = Date.now();
    const graceMs = graceMinutes * 60 * 1000;

    let realtimeStatus: "working" | "disconnected" = "disconnected";
    if (row.latest_status === "online") {
      realtimeStatus = "working";
    } else if (row.latest_status === "offline" && row.latest_checked_at) {
      const elapsed = now - row.latest_checked_at.getTime();
      if (elapsed < graceMs) realtimeStatus = "working";
    }

    // ── progressStatus 산출 (realtime과 동일 분기) ──
    let progressStatus: ProgressStatus | null = null;

    if (row.today_is_overridden && row.today_category_id !== null) {
      const calIn = row.today_corrected_in;
      const calOut = row.today_corrected_out;
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
            row.today_check_out &&
            row.today_check_out.getTime() > calOutMs
          ) {
            progressStatus = "completed";
          } else {
            progressStatus = "category_completed";
          }
        }
      } else {
        // 종일 일정 — check_out 유무로 working/completed
        progressStatus = row.today_check_out
          ? "category_completed"
          : "category_working";
      }
    }

    if (progressStatus === null) {
      if (row.latest_status === null) {
        progressStatus = "absent_today";
      } else if (row.latest_status === "online") {
        progressStatus = "working";
      } else if (row.latest_status === "offline" && row.latest_checked_at) {
        const elapsed = now - row.latest_checked_at.getTime();
        progressStatus = elapsed < graceMs ? "away" : "completed";
      } else {
        // offline인데 checked_at이 없는 비정상 케이스 → 미출근 취급
        progressStatus = "absent_today";
      }
    }

    const statusLabel = progressLabel(
      progressStatus,
      row.today_category_name,
      row.today_category_code
    );

    // ── 이번주(월~일, KST) attendance_daily auto_status 집계 (기존 그대로) ──
    const weekRows = await prisma.$queryRaw<
      { auto_status: string | null; cnt: bigint }[]
    >`
      WITH bounds AS (
        SELECT
          (date_trunc('week', (NOW() AT TIME ZONE 'Asia/Seoul')))::date AS monday,
          (date_trunc('week', (NOW() AT TIME ZONE 'Asia/Seoul')) + interval '6 days')::date AS sunday
      )
      SELECT auto_status, COUNT(*)::bigint AS cnt
      FROM hr.attendance_daily, bounds
      WHERE employee_id = ${empId}
        AND work_date >= (SELECT monday FROM bounds)
        AND work_date <= (SELECT sunday FROM bounds)
      GROUP BY auto_status
    `;

    const week = { normal: 0, late: 0, earlyLeave: 0, absent: 0 };
    for (const w of weekRows) {
      const c = Number(w.cnt);
      if (w.auto_status === "normal") week.normal = c;
      else if (w.auto_status === "late") week.late = c;
      else if (w.auto_status === "early_leave") week.earlyLeave = c;
      else if (w.auto_status === "absent") week.absent = c;
    }

    return NextResponse.json(
      { hasEmployee: true, progressStatus, statusLabel, week },
      { headers: corsHeaders }
    );
  } catch (error) {
    console.error("GET /api/portal-summary error:", error);
    return emptyResponse();
  }
}

// CORS preflight
export async function OPTIONS() {
  return new Response(null, { status: 204, headers: corsHeaders });
}

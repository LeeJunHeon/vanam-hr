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

// 미인증/직원 미매핑 공통 빈 응답 (포털에서 조용히 처리)
function emptyResponse() {
  return NextResponse.json(
    {
      hasEmployee: false,
      connection: "unknown",
      week: { normal: 0, late: 0, earlyLeave: 0, absent: 0 },
    },
    { headers: corsHeaders }
  );
}

// GET /api/portal-summary — 포털 근태 카드용. 본인 오늘 연결상태 + 이번주 집계.
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

    // ── ① 본인 오늘(KST) 최신 presence_raw 1건 → 연결 상태 판정 ──
    // 판정 로직은 attendance/realtime 라우트의 realtimeStatus와 동일:
    //   online → working / offline+grace이내 → working / 그 외(없음 포함) → disconnected
    const latest = await prisma.$queryRaw<
      { status: string | null; checked_at: Date | null }[]
    >`
      WITH today_kst AS (SELECT (NOW() AT TIME ZONE 'Asia/Seoul')::date AS d)
      SELECT status, checked_at
      FROM hr.presence_raw
      WHERE employee_id = ${empId}
        AND (checked_at AT TIME ZONE 'Asia/Seoul')::date = (SELECT d FROM today_kst)
      ORDER BY checked_at DESC
      LIMIT 1
    `;

    let connection: "working" | "disconnected" = "disconnected";
    if (latest.length > 0) {
      const row = latest[0];
      if (row.status === "online") {
        connection = "working";
      } else if (row.status === "offline" && row.checked_at) {
        const elapsed = Date.now() - row.checked_at.getTime();
        if (elapsed < graceMinutes * 60 * 1000) connection = "working";
      }
    }

    // ── ② 이번주(월~일, KST) attendance_daily auto_status 집계 ──
    // date_trunc('week')는 월요일 시작(ISO). 본인 행만 카운트.
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
    for (const row of weekRows) {
      const c = Number(row.cnt);
      if (row.auto_status === "normal") week.normal = c;
      else if (row.auto_status === "late") week.late = c;
      else if (row.auto_status === "early_leave") week.earlyLeave = c;
      else if (row.auto_status === "absent") week.absent = c;
    }

    return NextResponse.json(
      { hasEmployee: true, connection, week },
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

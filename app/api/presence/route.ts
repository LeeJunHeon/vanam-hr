import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getTargetEmployeeId } from "@/lib/auth-helpers";

// GET /api/presence?employeeId=N
// 신도림 단독 환경에서 본인의 오늘 presence_raw 요약을 반환.
// 비관리자: 본인만, 관리자: 다른 직원도 조회 가능.
export async function GET(request: NextRequest) {
  try {
    const r = await getTargetEmployeeId(request);
    if (!r.ok) return r.response;
    const employeeId = r.employeeId;

    // KST 기준 오늘 날짜를 계산하기 위해 raw query 사용 (Asia/Seoul 일자).
    // checked_at 컬럼이 timestamptz이므로 AT TIME ZONE 'Asia/Seoul' 변환 후 date 비교.
    // LATEST + LAST_ONLINE + LAST_OFFLINE + COUNT를 1쿼리로 집계.
    const result = await prisma.$queryRaw<
      Array<{
        current_status: string | null;
        last_online_at: Date | null;
        last_offline_at: Date | null;
        today_raw_count: bigint;
      }>
    >`
      WITH today_kst AS (
        SELECT (NOW() AT TIME ZONE 'Asia/Seoul')::date AS d
      ),
      today_raw AS (
        SELECT id, checked_at, status
        FROM hr.presence_raw
        WHERE employee_id = ${employeeId}
          AND (checked_at AT TIME ZONE 'Asia/Seoul')::date = (SELECT d FROM today_kst)
      ),
      latest AS (
        SELECT status
        FROM today_raw
        ORDER BY checked_at DESC, id DESC
        LIMIT 1
      ),
      last_online AS (
        SELECT checked_at
        FROM today_raw
        WHERE status = 'online'
        ORDER BY checked_at DESC, id DESC
        LIMIT 1
      ),
      last_offline AS (
        SELECT checked_at
        FROM today_raw
        WHERE status = 'offline'
        ORDER BY checked_at DESC, id DESC
        LIMIT 1
      )
      SELECT
        (SELECT status FROM latest) AS current_status,
        (SELECT checked_at FROM last_online) AS last_online_at,
        (SELECT checked_at FROM last_offline) AS last_offline_at,
        (SELECT COUNT(*) FROM today_raw)::bigint AS today_raw_count
    `;

    const row = result[0];

    return NextResponse.json({
      employeeId,
      currentStatus: row?.current_status ?? null,
      lastOnlineAt: row?.last_online_at
        ? row.last_online_at.toISOString()
        : null,
      lastOfflineAt: row?.last_offline_at
        ? row.last_offline_at.toISOString()
        : null,
      todayRawCount: row ? Number(row.today_raw_count) : 0,
    });
  } catch (error) {
    console.error("GET /api/presence error:", error);
    return NextResponse.json(
      { error: "presence 조회 실패" },
      { status: 500 }
    );
  }
}

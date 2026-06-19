import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireHrPortalAuth } from "@/lib/internal-portal-auth";
import { resolveHrIdentity } from "@/lib/internal-identity";

export const dynamic = "force-dynamic";

// GET /api/internal/my-presence — 본인 오늘(KST) 재실 상태.
export async function GET(request: NextRequest) {
  const auth = requireHrPortalAuth(request);
  if (!auth.ok) return auth.response;
  const identity = await resolveHrIdentity(auth.actingEmail);
  if (!Number.isInteger(identity.employeeId)) {
    return NextResponse.json({ mapped: false });
  }
  const employeeId = identity.employeeId as number;

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
      SELECT status FROM today_raw ORDER BY checked_at DESC, id DESC LIMIT 1
    ),
    last_online AS (
      SELECT checked_at FROM today_raw WHERE status = 'online' ORDER BY checked_at DESC, id DESC LIMIT 1
    ),
    last_offline AS (
      SELECT checked_at FROM today_raw WHERE status = 'offline' ORDER BY checked_at DESC, id DESC LIMIT 1
    )
    SELECT
      (SELECT status FROM latest) AS current_status,
      (SELECT checked_at FROM last_online) AS last_online_at,
      (SELECT checked_at FROM last_offline) AS last_offline_at,
      (SELECT COUNT(*) FROM today_raw)::bigint AS today_raw_count
  `;
  const row = result[0];
  return NextResponse.json({
    mapped: true,
    currentStatus: row?.current_status ?? null,
    lastOnlineAt: row?.last_online_at ? row.last_online_at.toISOString() : null,
    lastOfflineAt: row?.last_offline_at ? row.last_offline_at.toISOString() : null,
  });
}

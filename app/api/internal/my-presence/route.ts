import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireHrPortalAuth } from "@/lib/internal-portal-auth";
import { resolveHrIdentity } from "@/lib/internal-identity";
import { loadTodayWorkDate } from "@/lib/kst-date";
import { loadTodayPresenceSummary } from "@/lib/realtime-presence";

export const dynamic = "force-dynamic";

// GET /api/internal/my-presence — 본인 오늘(근무일 창) 재실 상태.
export async function GET(request: NextRequest) {
  const auth = requireHrPortalAuth(request);
  if (!auth.ok) return auth.response;
  const identity = await resolveHrIdentity(auth.actingEmail);
  if (!Number.isInteger(identity.employeeId)) {
    return NextResponse.json({ mapped: false });
  }
  const employeeId = identity.employeeId as number;

  // 오늘 = 근무일 창(cutoff). currentStatus 는 lib/realtime-presence 공용 판정(대시보드와 같음).
  const { date: todayWorkDate, cutoffHour } = await loadTodayWorkDate(prisma);
  const summary = await loadTodayPresenceSummary(prisma, employeeId, todayWorkDate, cutoffHour);
  return NextResponse.json({
    mapped: true,
    currentStatus: summary.currentStatus,
    lastOnlineAt: summary.lastOnlineAt ? summary.lastOnlineAt.toISOString() : null,
    lastOfflineAt: summary.lastOfflineAt ? summary.lastOfflineAt.toISOString() : null,
  });
}

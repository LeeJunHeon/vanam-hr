import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/auth-helpers";

// 읽은 알림 자동 정리 설정
const NOTIFICATION_RETENTION_DAYS = 7;           // 읽고 N일 지나면 삭제
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // 하루 1회만 정리 실행
let lastNotificationCleanupAt = 0;               // 마지막 정리 시각(ms). 서버 재시작 시 0 → 첫 GET에 1회 정리.

// 읽은 지 오래된 알림 삭제 (하루 1회, 비동기로 흘려보냄 — 조회를 막지 않음).
// isRead=true 인 것만 대상. 안 읽은 알림은 보존.
function cleanupOldNotifications(): void {
  const nowMs = Date.now();
  if (nowMs - lastNotificationCleanupAt <= CLEANUP_INTERVAL_MS) return;
  lastNotificationCleanupAt = nowMs;
  const cutoff = new Date(nowMs - NOTIFICATION_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  prisma.notification
    .deleteMany({
      where: { isRead: true, readAt: { lt: cutoff } },
    })
    .then((res) => {
      if (res.count > 0) {
        console.log(`[notify] 오래된 읽은 알림 ${res.count}건 정리 (${NOTIFICATION_RETENTION_DAYS}일 경과)`);
      }
    })
    .catch((e) => console.error("[notify] 오래된 알림 정리 실패:", e));
}

// GET /api/notifications?limit=20&unreadOnly=false
//   본인(session.user.employeeId)의 알림 최신순 + 안읽음 개수.
// 응답: { unreadCount: number, items: [{ id, type, title, body, linkPage, linkRefId, isRead, createdAt }] }
export async function GET(request: NextRequest) {
  try {
    const r = await requireSession();
    if (!r.ok) return r.response;
    const employeeId = r.session.user.employeeId;
    if (!Number.isInteger(employeeId)) {
      // 직원 매핑 없는 계정은 알림 없음 (빈 응답)
      return NextResponse.json({ unreadCount: 0, items: [] });
    }
    const empId = employeeId as number;

    // 읽은 지 오래된 알림 정리 (하루 1회, 비동기)
    cleanupOldNotifications();

    const { searchParams } = new URL(request.url);
    const limit = Math.min(50, Math.max(1, parseInt(searchParams.get("limit") || "20", 10)));
    const unreadOnly = searchParams.get("unreadOnly") === "true";

    const where = unreadOnly
      ? { employeeId: empId, isRead: false }
      : { employeeId: empId };

    const [items, unreadCount] = await Promise.all([
      prisma.notification.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: limit,
      }),
      prisma.notification.count({ where: { employeeId: empId, isRead: false } }),
    ]);

    return NextResponse.json({
      unreadCount,
      items: items.map((n) => ({
        id: Number(n.id),
        type: n.type,
        title: n.title,
        body: n.body,
        linkPage: n.linkPage,
        linkRefId: n.linkRefId != null ? Number(n.linkRefId) : null,
        isRead: n.isRead,
        createdAt: n.createdAt.toISOString(),
      })),
    });
  } catch (error) {
    console.error("GET /api/notifications error:", error);
    return NextResponse.json({ error: "알림 조회 실패" }, { status: 500 });
  }
}

// PATCH /api/notifications
//   body: { ids?: number[], all?: boolean }
//   - all=true: 본인 모든 안읽음 → 읽음
//   - ids: 해당 알림들만 읽음 (본인 것만)
export async function PATCH(request: NextRequest) {
  try {
    const r = await requireSession();
    if (!r.ok) return r.response;
    const employeeId = r.session.user.employeeId;
    if (!Number.isInteger(employeeId)) {
      return NextResponse.json({ error: "직원 매핑이 없습니다." }, { status: 403 });
    }
    const empId = employeeId as number;

    const body = await request.json().catch(() => ({}));
    const { ids, all } = body as { ids?: unknown; all?: unknown };
    const now = new Date();

    if (all === true) {
      const res = await prisma.notification.updateMany({
        where: { employeeId: empId, isRead: false },
        data: { isRead: true, readAt: now },
      });
      return NextResponse.json({ updated: res.count });
    }

    if (Array.isArray(ids) && ids.length > 0) {
      const numIds = ids
        .map((x) => Number(x))
        .filter((n) => Number.isInteger(n) && n > 0)
        .map((n) => BigInt(n));
      if (numIds.length === 0) {
        return NextResponse.json({ updated: 0 });
      }
      const res = await prisma.notification.updateMany({
        where: { id: { in: numIds }, employeeId: empId }, // employeeId로 본인 것만 보장
        data: { isRead: true, readAt: now },
      });
      return NextResponse.json({ updated: res.count });
    }

    return NextResponse.json({ error: "ids 또는 all 중 하나가 필요합니다." }, { status: 400 });
  } catch (error) {
    console.error("PATCH /api/notifications error:", error);
    return NextResponse.json({ error: "알림 읽음 처리 실패" }, { status: 500 });
  }
}

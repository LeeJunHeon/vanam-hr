import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/auth-helpers";

export const dynamic = "force-dynamic";

// GET /api/portal-notifications?limit=10
//   포털 TopBar 종 버튼/드롭다운용. 본인 알림 최신순 + 안읽음 수.
export async function GET(request: NextRequest) {
  try {
    const r = await requireSession();
    if (!r.ok) {
      // 미인증 — 빈 응답(포털에서 조용히 처리)
      return NextResponse.json({ unreadCount: 0, items: [] });
    }
    const employeeId = r.session.user.employeeId;
    if (!Number.isInteger(employeeId)) {
      return NextResponse.json({ unreadCount: 0, items: [] });
    }
    const empId = employeeId as number;

    const { searchParams } = new URL(request.url);
    const limit = Math.min(30, Math.max(1, parseInt(searchParams.get("limit") || "10", 10)));

    const [items, unreadCount] = await Promise.all([
      prisma.notification.findMany({
        where: { employeeId: empId },
        orderBy: { createdAt: "desc" },
        take: limit,
      }),
      prisma.notification.count({ where: { employeeId: empId, isRead: false } }),
    ]);

    return NextResponse.json(
      {
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
      }
    );
  } catch (error) {
    console.error("GET /api/portal-notifications error:", error);
    return NextResponse.json({ unreadCount: 0, items: [] });
  }
}

// PATCH /api/portal-notifications
//   body: { ids?: number[], all?: boolean } — 포털에서 읽음 처리.
export async function PATCH(request: NextRequest) {
  try {
    const r = await requireSession();
    if (!r.ok) {
      return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
    }
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
        where: { id: { in: numIds }, employeeId: empId },
        data: { isRead: true, readAt: now },
      });
      return NextResponse.json({ updated: res.count });
    }

    return NextResponse.json({ error: "ids 또는 all 중 하나가 필요합니다." }, { status: 400 });
  } catch (error) {
    console.error("PATCH /api/portal-notifications error:", error);
    return NextResponse.json({ error: "읽음 처리 실패" }, { status: 500 });
  }
}

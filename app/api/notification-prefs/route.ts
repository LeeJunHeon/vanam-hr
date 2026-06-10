import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/auth-helpers";

// 알림 종류 목록 (1차) — UI가 이 키들을 토글로 보여줌.
const NOTIFICATION_TYPES = [
  { type: "approval_request", label: "새 결재 요청" },
] as const;

// GET /api/notification-prefs
//   본인 설정 반환. 행이 없으면 enabled=true(기본 켜짐)로 채워서 반환.
// 응답: { prefs: [{ type, label, enabled }] }
export async function GET() {
  try {
    const r = await requireSession();
    if (!r.ok) return r.response;
    const employeeId = r.session.user.employeeId;
    if (!Number.isInteger(employeeId)) {
      return NextResponse.json({
        prefs: NOTIFICATION_TYPES.map((t) => ({ ...t, enabled: true })),
      });
    }

    const empId = employeeId as number;
    const rows = await prisma.notificationPref.findMany({
      where: { employeeId: empId },
      select: { type: true, enabled: true },
    });
    const map = new Map(rows.map((x) => [x.type, x.enabled]));

    return NextResponse.json({
      prefs: NOTIFICATION_TYPES.map((t) => ({
        type: t.type,
        label: t.label,
        enabled: map.has(t.type) ? (map.get(t.type) as boolean) : true,
      })),
    });
  } catch (error) {
    console.error("GET /api/notification-prefs error:", error);
    return NextResponse.json({ error: "알림 설정 조회 실패" }, { status: 500 });
  }
}

// PUT /api/notification-prefs
//   body: { type: string, enabled: boolean }
//   upsert (본인 + type 유일).
export async function PUT(request: NextRequest) {
  try {
    const r = await requireSession();
    if (!r.ok) return r.response;
    const employeeId = r.session.user.employeeId;
    if (!Number.isInteger(employeeId)) {
      return NextResponse.json({ error: "직원 매핑이 없습니다." }, { status: 403 });
    }

    const body = await request.json().catch(() => ({}));
    const { type, enabled } = body as { type?: unknown; enabled?: unknown };

    if (typeof type !== "string" || !NOTIFICATION_TYPES.some((t) => t.type === type)) {
      return NextResponse.json({ error: "유효한 type이 아닙니다." }, { status: 400 });
    }
    if (typeof enabled !== "boolean") {
      return NextResponse.json({ error: "enabled는 boolean이어야 합니다." }, { status: 400 });
    }

    const empId = employeeId as number;
    await prisma.notificationPref.upsert({
      where: { employeeId_type: { employeeId: empId, type } },
      update: { enabled, updatedAt: new Date() },
      create: { employeeId: empId, type, enabled },
    });

    return NextResponse.json({ ok: true, type, enabled });
  } catch (error) {
    console.error("PUT /api/notification-prefs error:", error);
    return NextResponse.json({ error: "알림 설정 저장 실패" }, { status: 500 });
  }
}

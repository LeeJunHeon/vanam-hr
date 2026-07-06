import { NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { createNotifications } from "@/lib/notify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/internal/notify — 내부 시스템(aggregator 등)이 알림을 요청하면
// createNotifications()로 위임하는 머신-투-머신 엔드포인트.
// 인증: Authorization: Bearer <INTERNAL_API_TOKEN>. acting-user 불필요(시스템 발신).

function safeStringEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export async function POST(request: Request) {
  const expected = process.env.INTERNAL_API_TOKEN;
  if (!expected || expected.length === 0) {
    return NextResponse.json({ error: "내부 토큰 미설정" }, { status: 500 });
  }
  const authHeader = request.headers.get("authorization") ?? "";
  const m = authHeader.match(/^Bearer\s+(.+)$/i);
  const token = m?.[1]?.trim() ?? "";
  if (!token || !safeStringEqual(token, expected)) {
    return NextResponse.json({ error: "인증 실패" }, { status: 401 });
  }

  let body: {
    employeeIds?: unknown;
    type?: unknown;
    title?: unknown;
    body?: unknown;
    linkPage?: unknown;
    linkRefId?: unknown;
    sourceType?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const rawIds = body.employeeIds;
  if (
    !Array.isArray(rawIds) ||
    rawIds.length === 0 ||
    !rawIds.every((n) => Number.isInteger(n))
  ) {
    return NextResponse.json(
      { error: "employeeIds는 1개 이상의 정수 배열이어야 합니다." },
      { status: 400 }
    );
  }
  const type = typeof body.type === "string" ? body.type.trim() : "";
  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (!type || !title) {
    return NextResponse.json(
      { error: "type과 title은 비어있지 않은 문자열이어야 합니다." },
      { status: 400 }
    );
  }

  const bodyText = typeof body.body === "string" ? body.body : undefined;
  const linkPage = typeof body.linkPage === "string" ? body.linkPage : undefined;
  const linkRefId = Number.isInteger(body.linkRefId)
    ? (body.linkRefId as number)
    : undefined;
  const sourceType =
    typeof body.sourceType === "string" ? body.sourceType : undefined;

  try {
    const count = await createNotifications({
      employeeIds: rawIds as number[],
      type,
      title,
      body: bodyText,
      linkPage,
      linkRefId,
      sourceType,
    });
    return NextResponse.json({ ok: true, count });
  } catch (e) {
    console.error("POST /api/internal/notify error:", e);
    return NextResponse.json({ error: "알림 처리 실패" }, { status: 500 });
  }
}

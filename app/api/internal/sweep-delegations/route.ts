import { NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { sweepEligibleDelegations } from "@/lib/sweep-delegations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/internal/sweep-delegations — 대리 위임 자동 마감 스윕.
// 대리결재자가 이미 승인했는데 위임 창(autoDelegateHours, 기본 24h) 경과 시점에
// 자동 확정이 안 되는 구멍을 메운다. 머신-투-머신(내부 시스템 전용).
// 인증: Authorization: Bearer <INTERNAL_API_TOKEN>. acting-user 불필요.
// 스윕 본체는 @/lib/sweep-delegations 로 공용화되어 있다.

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

  try {
    const finalized = await sweepEligibleDelegations();
    return NextResponse.json({ ok: true, finalized });
  } catch (error) {
    console.error("POST /api/internal/sweep-delegations error:", error);
    return NextResponse.json({ error: "위임 스윕 실패" }, { status: 500 });
  }
}

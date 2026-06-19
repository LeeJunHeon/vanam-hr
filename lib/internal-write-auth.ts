import { NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";

// 포털(세션 보유) → HR "쓰기(신청 생성)" API 인증. Bearer 토큰 = HR_WRITE_TOKEN.
// ⚠️ 조회용 HR_PORTAL_TOKEN과 별개(권한 분리). gemma/MCP는 보유하지 않는다.
// 신원: x-acting-user-email 필수 — 포털이 세션에서 주입한 신뢰된 이메일(본인 명의 보장).
export type HrWriteAuthResult =
  | { ok: true; actingEmail: string }
  | { ok: false; response: NextResponse };

function safeStringEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export function requireHrWriteAuth(request: Request): HrWriteAuthResult {
  const expected = process.env.HR_WRITE_TOKEN;
  if (!expected || expected.length === 0) {
    return { ok: false, response: NextResponse.json({ error: "HR 쓰기 토큰 미설정" }, { status: 500 }) };
  }
  const authHeader = request.headers.get("authorization") ?? "";
  const m = authHeader.match(/^Bearer\s+(.+)$/i);
  const token = m?.[1]?.trim() ?? "";
  if (!token || !safeStringEqual(token, expected)) {
    return { ok: false, response: NextResponse.json({ error: "인증 실패" }, { status: 401 }) };
  }
  const actingEmail = request.headers.get("x-acting-user-email")?.trim() || "";
  if (!actingEmail) {
    return { ok: false, response: NextResponse.json({ error: "행위자 이메일(x-acting-user-email)이 필요합니다." }, { status: 401 }) };
  }
  return { ok: true, actingEmail };
}

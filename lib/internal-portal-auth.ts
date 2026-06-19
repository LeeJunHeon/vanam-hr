import { NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";

// 포털(세션 보유) → HR "스코프 조회" API 인증.
// Authorization: Bearer <token> 가 process.env.HR_PORTAL_TOKEN 과 일치해야 통과.
// ⚠️ 조회용 HR_MCP_TOKEN(MCP 서버 보유)과는 별개의 토큰.
//    이 엔드포인트는 개인/부서 데이터를 신원 기반으로 돌려주므로,
//    MCP(gemma)가 호출하지 못하게 포털 전용 토큰을 요구한다(신원 위조 차단).
// 신원: x-acting-user-email 필수 — 포털이 세션에서 주입한 신뢰된 이메일.
// ⚠️ next-auth 세션 우회 안 함. 항상 머신 토큰 실검증.
export type HrPortalAuthResult =
  | { ok: true; actingEmail: string }
  | { ok: false; response: NextResponse };

function safeStringEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export function requireHrPortalAuth(request: Request): HrPortalAuthResult {
  const expected = process.env.HR_PORTAL_TOKEN;
  if (!expected || expected.length === 0) {
    return { ok: false, response: NextResponse.json({ error: "HR 포털 토큰 미설정" }, { status: 500 }) };
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

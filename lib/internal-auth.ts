import { NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";

// MCP 서버 등 내부 시스템 → HR 조회 API 인증 (읽기 전용 / 신원 불필요 도구 전용).
// Authorization: Bearer <token> 가 process.env.HR_MCP_TOKEN 과 일치해야 통과.
// ⚠️ next-auth 세션/DISABLE_AUTH 우회 절대 안 탐. 항상 머신 토큰 실검증.
// ⚠️ 이 게이트는 "비개인/비관리자" 엔드포인트 전용이다.
//    본인 기준/관리자 전용 데이터에는 절대 사용하지 말 것(별도 신원 해석이 필요).
export type HrReadAuthResult =
  | { ok: true }
  | { ok: false; response: NextResponse };

function safeStringEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export function requireHrReadAuth(request: Request): HrReadAuthResult {
  const expected = process.env.HR_MCP_TOKEN;
  if (!expected || expected.length === 0) {
    return {
      ok: false,
      response: NextResponse.json({ error: "HR MCP 토큰 미설정" }, { status: 500 }),
    };
  }
  const authHeader = request.headers.get("authorization") ?? "";
  const m = authHeader.match(/^Bearer\s+(.+)$/i);
  const token = m?.[1]?.trim() ?? "";
  if (!token || !safeStringEqual(token, expected)) {
    return {
      ok: false,
      response: NextResponse.json({ error: "인증 실패" }, { status: 401 }),
    };
  }
  return { ok: true };
}

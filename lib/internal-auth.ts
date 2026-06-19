import { NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";

// 공개(비개인) HR 조회 인증 — 신원 불필요 데이터(직원목록·외근·근태항목) 전용.
// 포털(/api/hr-read)이 HR_PORTAL_TOKEN(Bearer)으로 호출.
// ⚠️ 본인/관리자 데이터엔 사용 금지(그건 requireHrPortalAuth + resolveHrIdentity 경로).
export type HrReadAuthResult =
  | { ok: true }
  | { ok: false; response: NextResponse };

function safeStringEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export function requireHrPublicAuth(request: Request): HrReadAuthResult {
  const portal = process.env.HR_PORTAL_TOKEN;
  if (!portal || portal.length === 0) {
    return { ok: false, response: NextResponse.json({ error: "HR 토큰 미설정" }, { status: 500 }) };
  }
  const authHeader = request.headers.get("authorization") ?? "";
  const m = authHeader.match(/^Bearer\s+(.+)$/i);
  const token = m?.[1]?.trim() ?? "";
  if (token && safeStringEqual(token, portal)) return { ok: true };
  return { ok: false, response: NextResponse.json({ error: "인증 실패" }, { status: 401 }) };
}

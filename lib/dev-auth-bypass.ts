// 로컬 개발 전용 인증 우회 판정. 우회 분기(proxy.ts, lib/auth-helpers.ts 등)는 모두 이 값만 본다.
//
// next dev 는 NODE_ENV 를 "development", next build·next start 는 "production" 으로 정한다
// (node_modules/next/dist/docs/01-app/02-guides/environment-variables.md "Environment Variable Load Order").
// 그리고 Next 는 빌드할 때 코드의 process.env.NODE_ENV 를 그 문자열로 바꿔 넣는다.
// 그래서 운영 빌드에서는 앞 조건이 "production" === "development" → false 로 고정되고,
// 우회 분기는 빌드 산출물에서 지워진다. 실행 시 DISABLE_AUTH 를 어떤 값으로 넣어도 우회가 켜지지 않는다.
// DISABLE_AUTH=true 는 로컬 개발(npm run dev)에서만 통한다.
//
// proxy 와 서버 코드 양쪽에서 import 하므로 Node 전용 모듈은 import 하지 않는다.
export const DEV_AUTH_BYPASS =
  process.env.NODE_ENV === "development" && process.env.DISABLE_AUTH === "true";

if (DEV_AUTH_BYPASS) {
  // 우회가 켜져 있음을 서버 로그에 한 번만 남긴다 (여러 곳에서 import 돼도 같은 프로세스면 한 번)
  const g = globalThis as { __devAuthBypassWarned?: boolean };
  if (!g.__devAuthBypassWarned) {
    g.__devAuthBypassWarned = true;
    console.warn("[auth] 인증 우회 켜짐(개발 모드 전용) — DISABLE_AUTH=true");
  }
}

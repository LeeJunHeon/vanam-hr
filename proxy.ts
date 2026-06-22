import NextAuth from "next-auth";
import { authConfig } from "./auth.config";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// Edge Runtime용 — Prisma 미포함 authConfig만 사용
const { auth } = NextAuth(authConfig);

const isLocal = !process.env.NEXTAUTH_URL ||
  process.env.NEXTAUTH_URL.includes("localhost");

// 로컬 UI 확인용 인증 우회 (DISABLE_AUTH=true 설정 시 활성)
// 운영에서는 절대 활성화하지 말 것
const disableAuth = process.env.DISABLE_AUTH === "true";

export default auth((req: NextRequest & { auth: any }) => {
  const __basePath = process.env.NEXT_PUBLIC_BASE_PATH || "";
  const pathname =
    __basePath && req.nextUrl.pathname.startsWith(__basePath)
      ? req.nextUrl.pathname.slice(__basePath.length) || "/"
      : req.nextUrl.pathname;

  // ⚠️ 로컬 UI 확인 모드: 모든 요청 통과
  if (disableAuth) return NextResponse.next();

  // /api/auth/* 는 next-auth 내부 — 항상 허용
  if (pathname.startsWith("/api/auth")) return NextResponse.next();
  // /login 은 항상 허용
  if (pathname.startsWith("/login")) return NextResponse.next();

  // 포털용 cross-origin API(알림/요약) — route 핸들러가 자체 CORS(OPTIONS/미인증 빈 응답)를
  // 처리하므로, 미들웨어의 401(무 CORS)로 막지 않고 통과시킨다.
  // 실제 인증은 각 route의 requireSession()이 담당(미인증이면 빈 응답 반환).
  if (pathname === "/api/portal-notifications" || pathname === "/api/portal-summary") {
    return NextResponse.next();
  }

  // /api/internal/* 는 머신 토큰(HR_MCP_TOKEN)으로 자체 인증 — NextAuth 세션 불필요
  if (pathname.startsWith("/api/internal")) {
    return NextResponse.next();
  }

  // /api/* 미인증 시 401 JSON
  if (pathname.startsWith("/api/")) {
    if (!req.auth?.user) {
      return NextResponse.json(
        { error: "로그인이 필요합니다." },
        { status: 401 }
      );
    }
    return NextResponse.next();
  }

  // PWA 정적 자산(manifest.json, sw.js, 아이콘 등)은 인증 없이 통과시킨다.
  // 브라우저는 manifest/아이콘을 자격증명(쿠키) 없이 요청하므로, 인증 redirect가 끼면
  // JSON/이미지 대신 로그인 HTML이 와서 PWA(manifest 파싱·아이콘)가 깨진다.
  if (/\.(?:json|js|png|jpg|jpeg|gif|svg|ico|webmanifest)$/.test(pathname)) {
    return NextResponse.next();
  }

  // 페이지 라우트 미인증 시:
  //  - 로컬: 자체 /login
  //  - 운영: 포털 /login
  if (!req.auth?.user) {
    if (isLocal) {
      return NextResponse.redirect(new URL("/login", req.url));
    }
    return NextResponse.redirect(
      new URL("/login", "https://vanam.synology.me")
    );
  }

  return NextResponse.next();
});

export const config = {
  matcher: [
    "/api/((?!auth).*)",
    "/((?!_next/static|_next/image|favicon.ico).*)",
  ],
};

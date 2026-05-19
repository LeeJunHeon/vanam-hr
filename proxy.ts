import NextAuth from "next-auth";
import { authConfig } from "./auth.config";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// Edge Runtime용 — Prisma 미포함 authConfig만 사용
const { auth } = NextAuth(authConfig);

const isLocal = !process.env.NEXTAUTH_URL ||
  process.env.NEXTAUTH_URL.includes("localhost");

export default auth((req: NextRequest & { auth: any }) => {
  const { pathname } = req.nextUrl;

  // /api/auth/* 는 next-auth 내부 — 항상 허용
  if (pathname.startsWith("/api/auth")) return NextResponse.next();
  // /login 은 항상 허용
  if (pathname.startsWith("/login")) return NextResponse.next();

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

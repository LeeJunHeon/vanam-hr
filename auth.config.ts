import type { NextAuthConfig } from "next-auth";
import Google from "next-auth/providers/google";

const isLocal = !process.env.NEXTAUTH_URL ||
  process.env.NEXTAUTH_URL.includes("localhost");

// Edge Runtime용 — Prisma 미포함
export const authConfig: NextAuthConfig = {
  trustHost: true,
  providers: [
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    }),
  ],
  pages: {
    signIn: isLocal ? "/login" : "https://vanam.synology.me/login",
  },
  // SSO: 포털과 동일한 쿠키 이름+도메인으로 세션 공유
  ...(isLocal
    ? {}
    : {
        cookies: {
          sessionToken: {
            name: "__Secure-authjs.session-token",
            options: {
              httpOnly: true,
              sameSite: "lax" as const,
              path: "/",
              secure: true,
              domain: ".vanam.synology.me",
            },
          },
        },
      }),
};

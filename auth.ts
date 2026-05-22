import NextAuth from "next-auth";
import { prisma } from "@/lib/prisma";
import { authConfig } from "./auth.config";

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  callbacks: {
    async signIn({ user }) {
      if (!user.email) return false;

      const dbUser = await prisma.user.findUnique({
        where: { email: user.email },
      });

      // public.user 에 등록된 활성 사용자만 허용
      if (!dbUser || dbUser.isActive !== "Y") return false;

      return true;
    },

    async session({ session }) {
      if (!session.user?.email) return session;

      // public.user (inventory) 조회
      const dbUser = await prisma.user.findUnique({
        where: { email: session.user.email },
        select: {
          id: true,
          name: true,
          role: true,
        },
      });

      if (!dbUser) {
        // 매핑 안 된 사용자 — 기본값으로 채워 타입 호환 유지
        session.user.dbId = null;
        session.user.role = "viewer";
        session.user.employeeId = null;
        session.user.employeeNo = null;
        session.user.employeeActive = false;
        return session;
      }

      // hr.employees에서 user_id로 본인 직원 row 찾기
      const employee = await prisma.employee.findUnique({
        where: { userId: dbUser.id },
        select: { id: true, employeeNo: true, isActive: true },
      });

      session.user.name = dbUser.name;
      session.user.dbId = dbUser.id;
      session.user.role = dbUser.role ?? "viewer";
      session.user.employeeId = employee?.id ?? null;
      session.user.employeeNo = employee?.employeeNo ?? null;
      session.user.employeeActive = employee?.isActive ?? false;

      return session;
    },
  },
});

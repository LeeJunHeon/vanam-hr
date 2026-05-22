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

      // public.user (inventory) 조회 + 매핑된 hr.employees 조회를 1쿼리로
      const dbUser = await prisma.user.findUnique({
        where: { email: session.user.email },
        select: {
          id: true,
          name: true,
          role: true,
        },
      });

      if (!dbUser) return session;

      // hr.employees에서 user_id로 본인 직원 row 찾기
      const employee = await prisma.employee.findUnique({
        where: { userId: dbUser.id },
        select: { id: true, employeeNo: true, isActive: true },
      });

      session.user.name = dbUser.name;
      (session.user as any).role = dbUser.role ?? "viewer";
      (session.user as any).dbId = dbUser.id;

      // hr.employees 매핑 추가 (없으면 null — 매핑 안 된 사용자)
      (session.user as any).employeeId = employee?.id ?? null;
      (session.user as any).employeeNo = employee?.employeeNo ?? null;
      (session.user as any).employeeActive = employee?.isActive ?? false;

      return session;
    },
  },
});

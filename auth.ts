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

      // public.user (inventory) 조회 — 이름/이메일/userId 매핑 용도만
      const dbUser = await prisma.user.findUnique({
        where: { email: session.user.email },
        select: {
          id: true,
          name: true,
        },
      });

      if (!dbUser) {
        // 매핑 안 된 사용자 — 기본값 채워 타입 호환 유지
        session.user.dbId = null;
        session.user.role = "employee";
        session.user.positionCode = null;
        session.user.departmentId = null;
        session.user.employeeId = null;
        session.user.employeeNo = null;
        session.user.employeeActive = false;
        return session;
      }

      // hr.employees + position + department 조회
      const employee = await prisma.employee.findUnique({
        where: { userId: dbUser.id },
        select: {
          id: true,
          employeeNo: true,
          isActive: true,
          departmentId: true,
          position: { select: { code: true } },
        },
      });

      // hr 권한 source = position.code (CEO/ADMIN/EMPLOYEE)
      // 매핑 안 됐거나 position 미지정 시 'employee' (최소 권한)
      const positionCode = employee?.position?.code ?? null;
      const role =
        positionCode === "CEO"
          ? "ceo"
          : positionCode === "ADMIN"
          ? "admin"
          : "employee";

      session.user.name = dbUser.name;
      session.user.dbId = dbUser.id;
      session.user.role = role;
      session.user.positionCode = positionCode;
      session.user.departmentId = employee?.departmentId ?? null;
      session.user.employeeId = employee?.id ?? null;
      session.user.employeeNo = employee?.employeeNo ?? null;
      session.user.employeeActive = employee?.isActive ?? false;

      return session;
    },
  },
});

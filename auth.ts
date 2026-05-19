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

      const dbUser = await prisma.user.findUnique({
        where: { email: session.user.email },
        select: { id: true, name: true, role: true },
      });

      if (dbUser) {
        session.user.name = dbUser.name;
        (session.user as any).role = dbUser.role ?? "viewer";
        (session.user as any).dbId = dbUser.id;
      }

      return session;
    },
  },
});

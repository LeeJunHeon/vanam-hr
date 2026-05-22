import type { DefaultSession } from "next-auth";

/**
 * NextAuth v5 모듈 확장.
 * auth.ts의 session() 콜백이 session.user에 주입하는 필드를 타입으로 선언한다.
 *
 *  - dbId           : public.user.id (SSO 사용자)
 *  - role           : public.user.role ('admin' | 'viewer' 등)
 *  - employeeId     : hr.employees.id 매핑 (없으면 null)
 *  - employeeNo     : hr.employees.employee_no 매핑 (없으면 null)
 *  - employeeActive : hr.employees.is_active (없으면 false)
 */
declare module "next-auth" {
  interface Session {
    user: {
      dbId: number | null;
      role: string;
      employeeId: number | null;
      employeeNo: string | null;
      employeeActive: boolean;
    } & DefaultSession["user"];
  }
}

export {};

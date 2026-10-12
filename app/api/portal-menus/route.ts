import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession, isAdminSession } from "@/lib/auth-helpers";
import { visibleMenuItems } from "@/lib/menus";

export const dynamic = "force-dynamic";

// GET /api/portal-menus (실제 주소 /hr/api/portal-menus)
// 포털 런처용 — 지금 로그인한 사용자가 사이드바에서 볼 수 있는 메뉴를 사이드바 순서 그대로.
// 같은 origin 에서 부르므로 CORS 불필요, 미인증은 proxy 의 /api/* 401 규칙을 그대로 탄다.
// 권한 규칙은 사이드바·화면 가드와 같다(lib/menus). 직원 매핑이 안 된 일반 사용자는 모든 화면이
// 안내 페이지이므로 빈 목록(/api/me 의 isMapped 와 같은 판단).
export async function GET() {
  const r = await requireSession();
  if (!r.ok) return r.response;
  const { session } = r;

  const isAdmin = isAdminSession(session);
  let isMapped = false;
  const employeeId = session.user.employeeId;
  if (Number.isInteger(employeeId)) {
    const employee = await prisma.employee.findUnique({
      where: { id: employeeId as number },
      select: { id: true },
    });
    isMapped = employee != null;
  }

  const items = !isAdmin && !isMapped ? [] : visibleMenuItems(isAdmin);
  return NextResponse.json(
    {
      app: "hr",
      menus: items.map((i) => ({
        page: i.id,
        label: i.label,
        icon: i.icon,
        adminOnly: i.adminOnly === true,
      })),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

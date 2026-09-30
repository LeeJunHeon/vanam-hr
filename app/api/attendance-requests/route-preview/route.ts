import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession, isAdminSession } from "@/lib/auth-helpers";
import { decideApprovalRoute } from "@/lib/create-attendance-request";

export const dynamic = "force-dynamic";

// GET /api/attendance-requests/route-preview?categoryId=&employeeId=
// 신청 화면의 결재 안내 — 실제 신청과 같은 decideApprovalRoute 결과를 그대로 돌려준다.
// employeeId 는 선택(없으면 본인). 비관리자는 본인만, 관리자는 다른 직원도 가능.
export async function GET(request: NextRequest) {
  const r = await requireSession();
  if (!r.ok) return r.response;
  const { session } = r;
  const ownId = session.user.employeeId;

  const sp = new URL(request.url).searchParams;
  const categoryId = Number(sp.get("categoryId"));
  if (!Number.isInteger(categoryId)) {
    return NextResponse.json({ error: "categoryId 필요" }, { status: 400 });
  }
  const employeeParam = sp.get("employeeId");
  const employeeId = employeeParam ? Number(employeeParam) : ownId;
  if (!Number.isInteger(employeeId)) {
    return NextResponse.json(
      { error: "본인 직원 정보가 매핑되어 있지 않습니다. 관리자에게 직원 등록을 요청하세요." },
      { status: 403 }
    );
  }
  if (employeeId !== ownId && !isAdminSession(session)) {
    return NextResponse.json({ error: "본인 것만 조회할 수 있습니다." }, { status: 403 });
  }

  const emp = await prisma.employee.findUnique({
    where: { id: employeeId as number },
    include: { position: { select: { code: true } } },
  });
  if (!emp || !emp.isActive) {
    return NextResponse.json({ error: "활성 직원이 아닙니다." }, { status: 400 });
  }
  const category = await prisma.attendanceCategory.findUnique({ where: { id: categoryId } });
  if (!category || !category.isActive) {
    return NextResponse.json({ error: "활성 근태 항목이 아닙니다." }, { status: 400 });
  }

  const route = await decideApprovalRoute(emp, category);
  if (!route.ok) {
    // 결재자 없음 — 화면이 신청 버튼을 막고 이 문구를 보여준다 (200 으로 돌려 안내로 쓴다)
    return NextResponse.json({ error: route.error });
  }

  const people = route.approverIds.length
    ? await prisma.employee.findMany({
        where: { id: { in: route.approverIds } },
        select: { id: true, name: true },
      })
    : [];
  const nameOf = new Map(people.map((p) => [p.id, p.name]));

  return NextResponse.json({
    autoApprove: route.autoApprove,
    autoReason: route.autoReason,
    approvers: route.autoApprove
      ? []
      : route.approverIds.map((id) => ({ id, name: nameOf.get(id) ?? null })),
    approvalMode: route.approvalMode,
  });
}

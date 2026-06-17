import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requirePersonalInfoAccess } from "@/lib/auth-helpers";

// PATCH /api/personal-info/order — body: { order: number[] } (employeeId 순서)
export async function PATCH(request: NextRequest) {
  const r = await requirePersonalInfoAccess();
  if (!r.ok) return r.response;

  const body = await request.json().catch(() => ({}));
  const order = Array.isArray(body.order) ? body.order : null;
  if (!order || order.some((x: unknown) => !Number.isInteger(x))) {
    return NextResponse.json({ error: "order는 정수 배열이어야 합니다." }, { status: 400 });
  }

  // 인덱스를 hr_sort_order로 일괄 저장 (트랜잭션)
  await prisma.$transaction(
    order.map((employeeId: number, idx: number) =>
      prisma.employee.update({
        where: { id: employeeId },
        data: { hrSortOrder: idx },
      })
    )
  );

  return NextResponse.json({ ok: true });
}

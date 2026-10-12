import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth-helpers";
import { isValidYmd } from "@/lib/performance/rules";
import { parseEmployeeIds, ymdToDate } from "@/lib/performance/server";

export const dynamic = "force-dynamic";

function parseId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

// PUT /api/performance/cycles/[id] — 제출 기간·대상자 변경 { submitStart, submitEnd, targetEmployeeIds }
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const r = await requireAdmin();
    if (!r.ok) return r.response;

    const { id: idRaw } = await params;
    const id = parseId(idRaw);
    if (!id) return NextResponse.json({ error: "잘못된 회차 id입니다." }, { status: 400 });

    const cycle = await prisma.perfCycle.findUnique({ where: { id } });
    if (!cycle) return NextResponse.json({ error: "회차를 찾을 수 없습니다." }, { status: 404 });

    const body = await request.json().catch(() => ({}));
    const { submitStart, submitEnd } = body ?? {};
    if (!isValidYmd(submitStart) || !isValidYmd(submitEnd)) {
      return NextResponse.json({ error: "제출 기간 날짜가 올바르지 않습니다." }, { status: 400 });
    }
    if (submitStart > submitEnd) {
      return NextResponse.json(
        { error: "제출 시작일은 마감일보다 늦을 수 없습니다." },
        { status: 400 }
      );
    }
    const ids = parseEmployeeIds(body?.targetEmployeeIds);
    if (!ids || ids.length === 0) {
      return NextResponse.json({ error: "대상자를 1명 이상 선택해 주세요." }, { status: 400 });
    }
    const found = await prisma.employee.count({ where: { id: { in: ids } } });
    if (found !== ids.length) {
      return NextResponse.json({ error: "존재하지 않는 직원이 포함되어 있습니다." }, { status: 400 });
    }

    // 제출 이력이 있는 직원은 대상에서 뺄 수 없다
    const next = new Set(ids);
    const removed = cycle.targetEmployeeIds.filter((eid) => !next.has(eid));
    if (removed.length > 0) {
      const blocked = await prisma.perfSheet.findMany({
        where: {
          year: cycle.year,
          quarter: cycle.quarter,
          employeeId: { in: removed },
          submittedAt: { not: null },
        },
        select: { employee: { select: { name: true } } },
      });
      if (blocked.length > 0) {
        return NextResponse.json(
          {
            error: `제출 이력이 있는 직원은 대상에서 뺄 수 없습니다: ${blocked
              .map((b) => b.employee.name)
              .join(", ")}`,
          },
          { status: 409 }
        );
      }
    }

    await prisma.perfCycle.update({
      where: { id },
      data: {
        submitStart: ymdToDate(submitStart),
        submitEnd: ymdToDate(submitEnd),
        targetEmployeeIds: ids,
        updatedAt: new Date(),
      },
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("PUT /api/performance/cycles/[id] error:", error);
    return NextResponse.json({ error: "회차 수정 실패" }, { status: 500 });
  }
}

// DELETE /api/performance/cycles/[id] — 그 분기에 제출 이력이 없을 때만. 성과표는 지우지 않는다.
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const r = await requireAdmin();
    if (!r.ok) return r.response;

    const { id: idRaw } = await params;
    const id = parseId(idRaw);
    if (!id) return NextResponse.json({ error: "잘못된 회차 id입니다." }, { status: 400 });

    const cycle = await prisma.perfCycle.findUnique({ where: { id } });
    if (!cycle) return NextResponse.json({ error: "회차를 찾을 수 없습니다." }, { status: 404 });

    const submittedCount = await prisma.perfSheet.count({
      where: { year: cycle.year, quarter: cycle.quarter, submittedAt: { not: null } },
    });
    if (submittedCount > 0) {
      return NextResponse.json(
        { error: "제출 이력이 있는 회차는 삭제할 수 없습니다." },
        { status: 409 }
      );
    }

    await prisma.perfCycle.delete({ where: { id } });
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("DELETE /api/performance/cycles/[id] error:", error);
    return NextResponse.json({ error: "회차 삭제 실패" }, { status: 500 });
  }
}

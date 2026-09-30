import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getTargetEmployeeId } from "@/lib/auth-helpers";
import { loadWorkDayChecker } from "@/lib/annual-leave";

// GET /api/attendance-daily?employeeId=N&from=YYYY-MM-DD&to=YYYY-MM-DD
// 비관리자: employeeId는 본인만 (쿼리 무시 또는 본인과 다르면 403)
// 관리자: employeeId 미지정 시 본인, 지정 시 그 직원 데이터
export async function GET(request: NextRequest) {
  try {
    const r = await getTargetEmployeeId(request);
    if (!r.ok) return r.response;
    const employeeId = r.employeeId;

    const { searchParams } = new URL(request.url);
    const fromRaw = searchParams.get("from");
    const toRaw = searchParams.get("to");

    const where: any = { employeeId };
    if (fromRaw || toRaw) {
      where.workDate = {};
      if (fromRaw && /^\d{4}-\d{2}-\d{2}$/.test(fromRaw)) {
        where.workDate.gte = new Date(fromRaw + "T00:00:00.000Z");
      }
      if (toRaw && /^\d{4}-\d{2}-\d{2}$/.test(toRaw)) {
        const next = new Date(toRaw + "T00:00:00.000Z");
        next.setUTCDate(next.getUTCDate() + 1);
        where.workDate.lt = next;
      }
    }

    const dailies = await prisma.attendanceDaily.findMany({
      where,
      orderBy: [{ workDate: "asc" }],
      include: {
        category: {
          select: { id: true, code: true, name: true, displayColor: true, type: true },
        },
      },
    });

    // 요약 숫자에서 휴무일 휴가 줄을 가려내는 근무일 판정 (lib/attendance-summary summarizeDays)
    const ymd = (d: Date) => d.toISOString().split("T")[0];
    const isWorkDay =
      dailies.length > 0
        ? await loadWorkDayChecker(
            [employeeId],
            ymd(dailies[0].workDate),
            ymd(dailies[dailies.length - 1].workDate)
          )
        : () => true;

    return NextResponse.json(
      dailies.map((d) => ({
        id: d.id,
        workDate: d.workDate.toISOString().split("T")[0],
        checkIn: d.checkIn ? d.checkIn.toISOString() : null,
        checkOut: d.checkOut ? d.checkOut.toISOString() : null,
        autoStatus: d.autoStatus,
        categoryId: d.categoryId,
        categoryCode: d.category?.code ?? null,
        categoryName: d.category?.name ?? null,
        categoryColor: d.category?.displayColor ?? null,
        isOverridden: d.isOverridden,
        workMinutes: d.workMinutes,
        note: d.note,
        isConfirmed: d.isConfirmed,
        // 요약용 (기존 필드는 그대로 — RequestPage 정정 폼 등 다른 소비처 영향 없음)
        isLate: d.isLate,
        isEarlyLeave: d.isEarlyLeave,
        categoryType: d.category?.type ?? null,
        isWorkDay: isWorkDay(employeeId, d.workDate),
      }))
    );
  } catch (error) {
    console.error("GET /api/attendance-daily error:", error);
    return NextResponse.json({ error: "근태 조회 실패" }, { status: 500 });
  }
}

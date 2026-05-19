import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// GET /api/attendance-daily?employeeId=N&from=YYYY-MM-DD&to=YYYY-MM-DD
// from/to는 inclusive (서버는 to+1일 lt로 처리)
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const employeeIdRaw = searchParams.get("employeeId");
    const fromRaw = searchParams.get("from");
    const toRaw = searchParams.get("to");

    if (!employeeIdRaw) {
      return NextResponse.json(
        { error: "employeeId 파라미터가 필요합니다." },
        { status: 400 }
      );
    }
    const employeeId = Number(employeeIdRaw);
    if (!Number.isInteger(employeeId)) {
      return NextResponse.json(
        { error: "employeeId는 정수여야 합니다." },
        { status: 400 }
      );
    }

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
          select: { id: true, code: true, name: true, displayColor: true },
        },
      },
    });

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
      }))
    );
  } catch (error) {
    console.error("GET /api/attendance-daily error:", error);
    return NextResponse.json({ error: "근태 조회 실패" }, { status: 500 });
  }
}

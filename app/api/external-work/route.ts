import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-helpers";
import { prisma } from "@/lib/prisma";

function ymd(d: Date): string {
  return d.toISOString().split("T")[0];
}

// GET /api/external-work
// 전체 직원의 외근(EXTERNAL_WORK) 신청 목록. 로그인한 모든 사용자 접근(출장 목록과 동일 정책).
// 활성·예정/취소·지난 분류와 사용자 필터는 프론트에서 처리(모든 status 그대로 반환).
export async function GET() {
  try {
    const sessionR = await requireSession();
    if (!sessionR.ok) return sessionR.response;

    const rows = await prisma.attendanceRequest.findMany({
      where: { category: { code: "EXTERNAL_WORK" } },
      orderBy: [{ startDate: "desc" }, { requestedAt: "desc" }],
      include: {
        employee: {
          select: {
            id: true,
            employeeNo: true,
            name: true,
            department: { select: { name: true } },
          },
        },
        category: { select: { code: true, name: true, displayColor: true } },
      },
    });

    return NextResponse.json(
      rows.map((r) => ({
        id: r.id,
        employeeId: r.employeeId,
        employeeNo: r.employee?.employeeNo ?? null,
        employeeName: r.employee?.name ?? null,
        departmentName: r.employee?.department?.name ?? null,
        categoryName: r.category?.name ?? null,
        categoryColor: r.category?.displayColor ?? null,
        startDate: ymd(r.startDate),
        endDate: ymd(r.endDate),
        correctedCheckIn: r.correctedCheckIn
          ? r.correctedCheckIn.toISOString()
          : null,
        correctedCheckOut: r.correctedCheckOut
          ? r.correctedCheckOut.toISOString()
          : null,
        status: r.status,
        reason: r.reason,
        requestedAt: r.requestedAt.toISOString(),
      }))
    );
  } catch (error) {
    console.error("GET /api/external-work error:", error);
    return NextResponse.json(
      { error: "외근 목록을 불러올 수 없습니다." },
      { status: 500 }
    );
  }
}

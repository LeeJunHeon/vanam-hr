import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireHrPublicAuth } from "@/lib/internal-auth";

export const dynamic = "force-dynamic";

function ymd(d: Date): string {
  return d.toISOString().split("T")[0];
}

// GET /api/internal/external-work — 전사 외근(EXTERNAL_WORK) 신청 목록(최소 필드, 사유 제외).
// 앱에서도 전 로그인 사용자에게 공개되는 정보. 신원 불필요.
export async function GET(request: Request) {
  const auth = requireHrPublicAuth(request);
  if (!auth.ok) return auth.response;
  try {
    const rows = await prisma.attendanceRequest.findMany({
      where: { category: { code: "EXTERNAL_WORK" } },
      orderBy: [{ startDate: "desc" }, { requestedAt: "desc" }],
      select: {
        id: true,
        startDate: true,
        endDate: true,
        status: true,
        employee: {
          select: {
            employeeNo: true,
            name: true,
            department: { select: { name: true } },
          },
        },
        category: { select: { name: true } },
      },
    });
    return NextResponse.json(
      rows.map((r) => ({
        id: r.id,
        employeeNo: r.employee?.employeeNo ?? null,
        employeeName: r.employee?.name ?? null,
        departmentName: r.employee?.department?.name ?? null,
        categoryName: r.category?.name ?? null,
        startDate: ymd(r.startDate),
        endDate: ymd(r.endDate),
        status: r.status,
      }))
    );
  } catch (error) {
    console.error("GET /api/internal/external-work error:", error);
    return NextResponse.json({ error: "외근 목록 조회 실패" }, { status: 500 });
  }
}

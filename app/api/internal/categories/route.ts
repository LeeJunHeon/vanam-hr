import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireHrPublicAuth } from "@/lib/internal-auth";

export const dynamic = "force-dynamic";

// GET /api/internal/categories — 활성 근태 항목(휴가종류) 목록. 신원 불필요(참조 데이터).
export async function GET(request: Request) {
  const auth = requireHrPublicAuth(request);
  if (!auth.ok) return auth.response;
  try {
    const categories = await prisma.attendanceCategory.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: "asc" }, { code: "asc" }],
      select: {
        id: true,
        code: true,
        name: true,
        type: true,
        requireApproval: true,
        displayColor: true,
        sortOrder: true,
        description: true,
      },
    });
    return NextResponse.json(categories);
  } catch (error) {
    console.error("GET /api/internal/categories error:", error);
    return NextResponse.json({ error: "근태 항목 조회 실패" }, { status: 500 });
  }
}

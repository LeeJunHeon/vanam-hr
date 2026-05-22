import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth-helpers";

// GET /api/users?excludeMapped=true&search=...
// public.User를 HR 페이지의 SSO 매핑 select에서 read-only로 사용.
// User 마스터 자체는 portal/inventory에서 관리. HR은 절대 POST/PUT/DELETE 안 함.
export async function GET(request: NextRequest) {
  try {
    const _auth = await requireAdmin();
    if (!_auth.ok) return _auth.response;

    const { searchParams } = new URL(request.url);
    const search = searchParams.get("search") || "";
    const excludeMapped = searchParams.get("excludeMapped") === "true";

    const where: any = {
      isActive: "Y", // VARCHAR
    };
    if (search) {
      where.OR = [
        { name: { contains: search, mode: "insensitive" } },
        { email: { contains: search, mode: "insensitive" } },
      ];
    }

    if (excludeMapped) {
      const mapped = await prisma.employee.findMany({
        where: { userId: { not: null } },
        select: { userId: true },
      });
      const mappedIds = mapped
        .map((e) => e.userId)
        .filter((v): v is number => v !== null);
      if (mappedIds.length > 0) {
        where.id = { notIn: mappedIds };
      }
    }

    const users = await prisma.user.findMany({
      where,
      orderBy: { name: "asc" },
      select: { id: true, name: true, email: true, role: true },
    });

    return NextResponse.json(users);
  } catch (error) {
    console.error("GET /api/users error:", error);
    return NextResponse.json(
      { error: "사용자 조회 실패" },
      { status: 500 }
    );
  }
}

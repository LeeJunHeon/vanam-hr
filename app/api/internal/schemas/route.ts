import { NextResponse } from "next/server";
import { requireHrPublicAuth } from "@/lib/internal-auth";
import { OPERATION_SCHEMAS } from "@/lib/operation-schemas";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

// GET /api/internal/schemas — HR 챗봇 작업 스키마. category enumValues는 활성 근태 항목명으로 동적 주입.
export async function GET(request: Request) {
  const auth = requireHrPublicAuth(request);
  if (!auth.ok) return auth.response;

  let categoryNames: string[] = [];
  try {
    const cats = await prisma.attendanceCategory.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: "asc" },
      select: { name: true },
    });
    categoryNames = cats.map((c) => c.name);
  } catch {
    // 실패 시 enumValues 없이 진행
  }

  const schemas = OPERATION_SCHEMAS.map((op) => ({
    ...op,
    fields: op.fields.map((f) =>
      f.name === "category" && categoryNames.length > 0 ? { ...f, enumValues: categoryNames } : f
    ),
  }));

  return NextResponse.json(schemas);
}

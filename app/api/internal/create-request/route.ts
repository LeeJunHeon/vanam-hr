import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireHrWriteAuth } from "@/lib/internal-write-auth";
import { resolveHrIdentity } from "@/lib/internal-identity";
import { createAttendanceRequest } from "@/lib/create-attendance-request";

export const dynamic = "force-dynamic";

// POST /api/internal/create-request — 챗 근태 신청 생성.
// employeeId는 신원(x-acting-user-email→resolveHrIdentity)에서만 결정 → 본인 명의로만(위조 불가).
export async function POST(request: Request) {
  const auth = requireHrWriteAuth(request);
  if (!auth.ok) return auth.response;

  const identity = await resolveHrIdentity(auth.actingEmail);
  if (!Number.isInteger(identity.employeeId)) {
    return NextResponse.json(
      { error: "본인 직원 정보가 매핑되어 있지 않습니다. 관리자에게 직원 등록을 요청하세요." },
      { status: 403 }
    );
  }

  let body: { category?: unknown; startDate?: unknown; endDate?: unknown; reason?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const categoryName = typeof body.category === "string" ? body.category.trim() : "";
  const startDate = typeof body.startDate === "string" ? body.startDate : "";
  const endDate = typeof body.endDate === "string" ? body.endDate : "";
  const reason = typeof body.reason === "string" ? body.reason : null;

  if (!categoryName) {
    return NextResponse.json({ error: "근태 항목(category)이 필요합니다." }, { status: 400 });
  }

  const cat = await prisma.attendanceCategory.findFirst({
    where: { name: categoryName, isActive: true },
    select: { id: true },
  });
  if (!cat) {
    return NextResponse.json({ error: `'${categoryName}' 근태 항목을 찾을 수 없습니다.` }, { status: 400 });
  }

  const result = await createAttendanceRequest({
    employeeId: identity.employeeId as number,
    categoryId: cat.id,
    startDate,
    endDate,
    reason,
  });

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json({ ok: true, id: result.id, status: result.status }, { status: 201 });
}

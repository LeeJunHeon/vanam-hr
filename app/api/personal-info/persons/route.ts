import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requirePersonalInfoAccess } from "@/lib/auth-helpers";

// POST /api/personal-info/persons — 인사 전용 직원 추가 (employees.is_hr_only=true)
export async function POST(request: NextRequest) {
  const r = await requirePersonalInfoAccess();
  if (!r.ok) return r.response;

  const body = await request.json().catch(() => ({}));
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) {
    return NextResponse.json({ error: "성명을 입력하세요." }, { status: 400 });
  }

  // employees 행 + personal_info 행 동시 생성
  const created = await prisma.employee.create({
    data: {
      name, // employees.name은 NOT NULL — 입력한 한글 성명 사용
      isHrOnly: true,
      isActive: true,
      personalInfo: {
        create: { hrName: name },
      },
    },
    select: { id: true },
  });

  return NextResponse.json({ ok: true, employeeId: created.id });
}

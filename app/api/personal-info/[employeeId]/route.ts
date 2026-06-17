import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requirePersonalInfoAccess } from "@/lib/auth-helpers";

// GET — 기본정보 + 추가정보 합쳐서
export async function GET(
  request: NextRequest,
  ctx: { params: Promise<{ employeeId: string }> }
) {
  const r = await requirePersonalInfoAccess();
  if (!r.ok) return r.response;
  const { employeeId: idStr } = await ctx.params;
  const employeeId = Number(idStr);
  if (!Number.isInteger(employeeId)) {
    return NextResponse.json({ error: "employeeId가 올바르지 않습니다." }, { status: 400 });
  }

  const emp = await prisma.employee.findUnique({
    where: { id: employeeId },
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      hiredAt: true,
      department: { select: { name: true } },
      position: { select: { name: true } },
      personalInfo: true,
    },
  });
  if (!emp) {
    return NextResponse.json({ error: "직원을 찾을 수 없습니다." }, { status: 404 });
  }

  const pi = emp.personalInfo;
  return NextResponse.json({
    employeeId: emp.id,
    // 기본 정보 (employees)
    name: emp.name,
    positionName: emp.position?.name ?? null,
    departmentName: emp.department?.name ?? null,
    hiredAt: emp.hiredAt ? emp.hiredAt.toISOString().split("T")[0] : null,
    phone: emp.phone ?? null,
    email: emp.email ?? null,
    // 추가 정보 (personal_info)
    researcherNumber: pi?.researcherNumber ?? null,
    university: pi?.university ?? null,
    finalDegree: pi?.finalDegree ?? null,
    major: pi?.major ?? null,
    graduationYearmonth: pi?.graduationYearmonth ?? null,
    degreeNumber: pi?.degreeNumber ?? null,
    residentNumber: pi?.residentNumber ?? null,
    address: pi?.address ?? null,
    bankName: pi?.bankName ?? null,
    accountNumber: pi?.accountNumber ?? null,
    accountHolder: pi?.accountHolder ?? null,
    hasInfo: !!pi,
  });
}

// PUT — 추가정보 upsert
export async function PUT(
  request: NextRequest,
  ctx: { params: Promise<{ employeeId: string }> }
) {
  const r = await requirePersonalInfoAccess();
  if (!r.ok) return r.response;
  const { employeeId: idStr } = await ctx.params;
  const employeeId = Number(idStr);
  if (!Number.isInteger(employeeId)) {
    return NextResponse.json({ error: "employeeId가 올바르지 않습니다." }, { status: 400 });
  }
  // 직원 존재 확인
  const emp = await prisma.employee.findUnique({ where: { id: employeeId }, select: { id: true } });
  if (!emp) {
    return NextResponse.json({ error: "직원을 찾을 수 없습니다." }, { status: 404 });
  }

  const body = await request.json();
  // 빈 문자열은 null로 저장 (트림)
  const clean = (v: unknown): string | null => {
    if (typeof v !== "string") return null;
    const t = v.trim();
    return t.length === 0 ? null : t;
  };
  const data = {
    researcherNumber: clean(body.researcherNumber),
    university: clean(body.university),
    finalDegree: clean(body.finalDegree),
    major: clean(body.major),
    graduationYearmonth: clean(body.graduationYearmonth),
    degreeNumber: clean(body.degreeNumber),
    residentNumber: clean(body.residentNumber),
    address: clean(body.address),
    bankName: clean(body.bankName),
    accountNumber: clean(body.accountNumber),
    accountHolder: clean(body.accountHolder),
    updatedAt: new Date(),
  };

  const saved = await prisma.employeePersonalInfo.upsert({
    where: { employeeId },
    update: data,
    create: { employeeId, ...data },
  });
  return NextResponse.json({ ok: true, id: saved.id });
}

// DELETE — 추가정보만 삭제 (직원 기본 데이터는 보존)
export async function DELETE(
  request: NextRequest,
  ctx: { params: Promise<{ employeeId: string }> }
) {
  const r = await requirePersonalInfoAccess();
  if (!r.ok) return r.response;
  const { employeeId: idStr } = await ctx.params;
  const employeeId = Number(idStr);
  if (!Number.isInteger(employeeId)) {
    return NextResponse.json({ error: "employeeId가 올바르지 않습니다." }, { status: 400 });
  }
  // 행이 없으면 조용히 성공 처리 (멱등)
  await prisma.employeePersonalInfo.deleteMany({ where: { employeeId } });
  return NextResponse.json({ ok: true });
}

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
      employeeNo: true,
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
    // employees 공유 (양방향 수정 대상)
    employeeNo: emp.employeeNo,
    email: emp.email ?? null,
    hiredAt: emp.hiredAt ? emp.hiredAt.toISOString().split("T")[0] : null,
    // employees 참고용 (읽기 표시 — 근태 시스템 값)
    name: emp.name,
    positionName: emp.position?.name ?? null,
    departmentName: emp.department?.name ?? null,
    phone: emp.phone ?? null,
    // 인사정보 카드 전용 (employee_personal_info)
    hrName: pi?.hrName ?? null,
    hrPosition: pi?.hrPosition ?? null,
    hrDepartment: pi?.hrDepartment ?? null,
    hrPhone: pi?.hrPhone ?? null,
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

  // ── employees 공유 업데이트 (사번/이메일/입사일) ──
  const newNo = clean(body.employeeNo);
  if (newNo) {
    const dup = await prisma.employee.findUnique({ where: { employeeNo: newNo } });
    if (dup && dup.id !== employeeId) {
      return NextResponse.json({ error: `사번 "${newNo}"가 이미 다른 직원에게 있습니다.` }, { status: 409 });
    }
  }
  let hiredAtVal: Date | null = null;
  if (body.hiredAt) {
    const s = String(body.hiredAt).trim();
    if (s) {
      const d = new Date(s + "T00:00:00.000Z");
      if (isNaN(d.getTime())) {
        return NextResponse.json({ error: "입사일 형식이 잘못되었습니다 (YYYY-MM-DD)." }, { status: 400 });
      }
      hiredAtVal = d;
    }
  }
  await prisma.employee.update({
    where: { id: employeeId },
    data: { employeeNo: newNo, email: clean(body.email), hiredAt: hiredAtVal },
  });

  // ── personal_info upsert (인사 전용 hr 4개 + 기존 11개) ──
  const data = {
    hrName: clean(body.hrName),
    hrPosition: clean(body.hrPosition),
    hrDepartment: clean(body.hrDepartment),
    hrPhone: clean(body.hrPhone),
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
  const target = await prisma.employee.findUnique({
    where: { id: employeeId },
    select: { id: true, isHrOnly: true },
  });
  if (!target) {
    return NextResponse.json({ ok: true }); // 이미 없음(멱등)
  }

  if (target.isHrOnly) {
    // 인사 전용 직원 → employees 행까지 완전 삭제 (personal_info는 FK Cascade로 함께 삭제됨)
    await prisma.employee.delete({ where: { id: employeeId } });
    return NextResponse.json({ ok: true, deletedEmployee: true });
  }

  // 일반 근태 직원 → 추가정보(personal_info)만 삭제 (기존 동작, 행 없어도 멱등)
  await prisma.employeePersonalInfo.deleteMany({ where: { employeeId } });
  return NextResponse.json({ ok: true });
}

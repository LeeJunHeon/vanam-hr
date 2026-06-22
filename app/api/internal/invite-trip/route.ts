import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireHrWriteAuth } from "@/lib/internal-write-auth";
import { resolveHrIdentity } from "@/lib/internal-identity";
import { computeApprovalStatus } from "@/lib/trip-helpers";
import { createNotifications } from "@/lib/notify";

export const dynamic = "force-dynamic";

// 값이 정수면 그 id, 아니면 null
function asId(v: unknown): number | null {
  if (typeof v === "number" && Number.isInteger(v)) return v;
  if (typeof v === "string" && /^\d+$/.test(v.trim())) return Number(v.trim());
  return null;
}
function asName(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

// POST /api/internal/invite-trip — 챗 출장 참석자 초대.
// 초대 주체(권한·결재규칙)는 신원(x-acting-user-email→resolveHrIdentity)에서만 결정.
// trip/employee는 이름(또는 숫자 id)로 받아 HR이 직접 해석(포털 무수정).
// 웹 POST /api/trip-events/[id]/participants 와 동일 규칙(날짜 미지정 — 피초대자가 수락 시 선택).
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
  const inviterId = identity.employeeId as number;

  let body: { trip?: unknown; employee?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  // ── 출장(이벤트) 해석: 숫자 id 또는 출장명(정확→부분) ──
  const tripId = asId(body.trip);
  const tripName = asName(body.trip);
  let event: { id: number; name: string; status: string } | null = null;

  if (tripId !== null) {
    event = await prisma.tripEvent.findUnique({
      where: { id: tripId },
      select: { id: true, name: true, status: true },
    });
    if (!event) {
      return NextResponse.json({ error: "해당 출장을 찾을 수 없습니다." }, { status: 404 });
    }
  } else if (tripName) {
    const actives = await prisma.tripEvent.findMany({
      where: { status: "active" },
      select: { id: true, name: true, status: true },
      orderBy: [{ startDate: "desc" }],
    });
    const lower = tripName.toLowerCase();
    let cand = actives.filter((e) => e.name.toLowerCase() === lower);
    if (cand.length === 0) cand = actives.filter((e) => e.name.toLowerCase().includes(lower));
    if (cand.length === 1) {
      event = cand[0];
    } else {
      const names = actives.map((e) => e.name);
      const hint = names.length > 0 ? ` 현재 활성 출장: ${names.join(", ")}` : " 현재 활성 출장이 없습니다.";
      return NextResponse.json({ error: `출장을 특정할 수 없습니다.${hint}` }, { status: 400 });
    }
  } else {
    return NextResponse.json({ error: "어느 출장인지(trip) 알려주세요." }, { status: 400 });
  }

  if (event.status !== "active") {
    return NextResponse.json({ error: "활성(active) 출장만 초대할 수 있습니다." }, { status: 400 });
  }

  // ── 직원 해석 (활성·비HR전용; 사번 또는 영문 이름. 정확→부분) ──
  const empVal = asName(body.employee);
  if (!empVal) {
    return NextResponse.json({ error: "누구를 초대할지(employee) 알려주세요." }, { status: 400 });
  }
  const empBase = { isActive: true, isHrOnly: false };
  let empCand = await prisma.employee.findMany({
    where: {
      ...empBase,
      OR: [
        { employeeNo: { equals: empVal, mode: "insensitive" } },
        { name: { equals: empVal, mode: "insensitive" } },
      ],
    },
    select: { id: true, name: true, employeeNo: true },
  });
  if (empCand.length === 0) {
    empCand = await prisma.employee.findMany({
      where: {
        ...empBase,
        OR: [
          { employeeNo: { contains: empVal, mode: "insensitive" } },
          { name: { contains: empVal, mode: "insensitive" } },
        ],
      },
      select: { id: true, name: true, employeeNo: true },
    });
  }

  let target: { id: number; name: string };
  if (empCand.length === 1) {
    target = { id: empCand[0].id, name: empCand[0].name };
  } else if (empCand.length === 0) {
    return NextResponse.json(
      { error: `'${empVal}' 직원을 찾을 수 없습니다. 등록된 영문 이름 또는 사번으로 말씀해 주세요.` },
      { status: 404 }
    );
  } else {
    const names = empCand.map((c) => `${c.name}(${c.employeeNo ?? "-"})`).join(", ");
    return NextResponse.json(
      { error: `대상 직원이 여러 명입니다: ${names}. 더 정확히(사번 등) 말씀해 주세요.` },
      { status: 400 }
    );
  }

  // ── 중복 참석자 체크 ──
  const dup = await prisma.tripParticipant.findUnique({
    where: { tripEventId_employeeId: { tripEventId: event.id, employeeId: target.id } },
    select: { id: true },
  });
  if (dup) {
    return NextResponse.json(
      { error: `${target.name}님은 이미 '${event.name}' 참석자입니다.` },
      { status: 409 }
    );
  }

  // ── 결재 규칙: 초대자 role 기준 (admin/ceo→not_required, employee→pending) ──
  const approvalStatus = computeApprovalStatus(identity.role);

  const created = await prisma.tripParticipant.create({
    data: {
      tripEventId: event.id,
      employeeId: target.id,
      inviteStatus: "invited",
      approvalStatus,
    },
    select: { id: true },
  });

  // 초대 알림 → 피초대자 (본인 초대는 생략)
  if (target.id !== inviterId) {
    try {
      await createNotifications({
        employeeIds: [target.id],
        type: "trip_invite",
        title: "출장 초대",
        body: `'${event.name}' 출장에 초대되었습니다.`,
        linkPage: "field-trip",
        linkRefId: event.id,
        sourceType: "trip",
      });
    } catch (e) {
      console.error("[notify] 출장 초대 알림 생성 실패:", e);
    }
  }

  return NextResponse.json(
    { ok: true, id: created.id, tripName: event.name, employeeName: target.name },
    { status: 201 }
  );
}

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireHrWriteAuth } from "@/lib/internal-write-auth";
import { resolveHrIdentity } from "@/lib/internal-identity";
import { createNotifications } from "@/lib/notify";

export const dynamic = "force-dynamic";

// POST /api/internal/respond-trip-invite — 챗 출장 초대 응답.
// 본인(x-acting-user-email→resolveHrIdentity)이 초대된 활성 출장만 → 위조 불가.
// 거부(decline)만 즉시 처리(웹 decline과 동일: inviteStatus="declined"+주최자 알림).
// 수락은 참석 날짜 선택이 필요 → 포털 결재함으로 안내(실수 거부 방지 위해 action 명시).
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
  const myId = identity.employeeId as number;

  let body: { trip?: unknown; action?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const tripText = typeof body.trip === "string" ? body.trip.trim() : "";
  const action = typeof body.action === "string" ? body.action.trim() : "";

  // 수락은 참석 날짜 선택이 필요 → 결재함 안내(여기서 거부 처리하지 않음)
  if (action === "수락" || action === "accept") {
    return NextResponse.json(
      { error: "출장 수락은 참석 날짜 선택이 필요합니다. 포털 결재함(출장)에서 수락해 주세요." },
      { status: 400 }
    );
  }
  if (action !== "거부" && action !== "decline") {
    return NextResponse.json({ error: "응답은 수락/거부 중 하나여야 합니다." }, { status: 400 });
  }
  if (!tripText) {
    return NextResponse.json({ error: "어느 출장인지(trip) 알려주세요." }, { status: 400 });
  }

  // 본인이 참여자로 있는 활성 출장만 대상(위조 불가)
  const myParts = await prisma.tripParticipant.findMany({
    where: { employeeId: myId, tripEvent: { status: "active" } },
    select: {
      id: true,
      inviteStatus: true,
      tripEvent: { select: { id: true, name: true, createdById: true } },
    },
  });
  if (myParts.length === 0) {
    return NextResponse.json({ error: "초대받은 활성 출장이 없습니다." }, { status: 404 });
  }

  // 출장 특정: id 또는 이름(정확→부분 일치)
  const tripIdNum = Number(tripText);
  let matches = myParts.filter((p) =>
    Number.isInteger(tripIdNum) ? p.tripEvent.id === tripIdNum : p.tripEvent.name === tripText
  );
  if (matches.length === 0 && !Number.isInteger(tripIdNum)) {
    const low = tripText.toLowerCase();
    matches = myParts.filter((p) => p.tripEvent.name.toLowerCase().includes(low));
  }
  if (matches.length === 0) {
    return NextResponse.json({ error: `'${tripText}' — 초대받은 출장에서 찾을 수 없습니다.` }, { status: 404 });
  }
  if (matches.length > 1) {
    const names = matches.map((p) => p.tripEvent.name).join(", ");
    return NextResponse.json({ error: `출장을 특정할 수 없습니다: ${names}` }, { status: 400 });
  }

  const part = matches[0];

  // 거부 처리 (웹 decline과 동일)
  const updated = await prisma.tripParticipant.update({
    where: { id: part.id },
    data: { inviteStatus: "declined" },
  });

  // 주최자에게 거절 알림 (본인이 주최자면 생략) — 웹 decline과 동일
  try {
    const creatorId = part.tripEvent.createdById;
    if (Number.isInteger(creatorId) && creatorId !== myId) {
      const me = await prisma.employee.findUnique({ where: { id: myId }, select: { name: true } });
      await createNotifications({
        employeeIds: [creatorId],
        type: "trip_decline",
        title: "출장 초대 거절",
        body: `${me?.name ?? "직원"}님이 출장 초대를 거절했습니다.`,
        linkPage: "field-trip",
        linkRefId: part.tripEvent.id,
        sourceType: "trip",
      });
    }
  } catch (e) {
    console.error("[notify] 출장 거절 알림 생성 실패:", e);
  }

  return NextResponse.json(
    { ok: true, tripEventId: part.tripEvent.id, inviteStatus: updated.inviteStatus },
    { status: 200 }
  );
}

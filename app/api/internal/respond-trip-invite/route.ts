import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireHrWriteAuth } from "@/lib/internal-write-auth";
import { resolveHrIdentity } from "@/lib/internal-identity";
import {
  parseDatesArray,
  checkInviteResponse,
  notifyTripApprovalRequested,
  type ParsedDate,
} from "@/lib/trip-helpers";
import { resolveTripParticipantApprovers } from "@/lib/approval-resolver";
import {
  createTripParticipantAttendanceRequests,
  rebuildTripEventCalendar,
} from "@/lib/trip-calendar";
import { createNotifications } from "@/lib/notify";

export const dynamic = "force-dynamic";

// POST /api/internal/respond-trip-invite — 챗 출장 초대 응답(수락/거부).
// 본인(x-acting-user-email→resolveHrIdentity)의 초대 건만 → 위조 불가.
// 거부: inviteStatus="declined" + 주최자 알림 (웹 decline 동일).
// 수락: 참석 날짜 + 결재선 계산 + (확정 시)근태/캘린더 / (대기 시)결재 알림 (웹 trip-participants accept 동일).
//       참석 날짜 미지정 시 초대 때 정해둔 날짜(없으면 출장 전체 기간). 시간 미지정 = 종일.
// 응답 가능 상태(수락: 초대됨·거절 / 거절: 초대됨)는 웹과 같은 checkInviteResponse.
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

  let body: { trip?: unknown; action?: unknown; attendDates?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const tripText = typeof body.trip === "string" ? body.trip.trim() : "";
  const actionRaw = typeof body.action === "string" ? body.action.trim() : "";
  const attendDatesText = typeof body.attendDates === "string" ? body.attendDates.trim() : "";

  const action =
    actionRaw === "수락" || actionRaw === "accept" ? "accept"
    : actionRaw === "거부" || actionRaw === "decline" ? "decline" : "";
  if (!action) {
    return NextResponse.json({ error: "응답은 수락/거부 중 하나여야 합니다." }, { status: 400 });
  }
  if (!tripText) {
    return NextResponse.json({ error: "어느 출장인지(trip) 알려주세요." }, { status: 400 });
  }

  // 본인이 참여자인 활성 출장만 + 이벤트 기간
  const myParts = await prisma.tripParticipant.findMany({
    where: { employeeId: myId, tripEvent: { status: "active" } },
    select: {
      id: true,
      employeeId: true,
      inviteStatus: true,
      approvalStatus: true,
      approverIds: true,
      // 챗 수락 시 날짜 미지정이면 초대 때 정해둔 날짜를 쓴다
      dates: {
        orderBy: [{ attendDate: "asc" }],
        select: { attendDate: true, startTime: true, endTime: true },
      },
      tripEvent: {
        select: { id: true, name: true, startDate: true, endDate: true, createdById: true },
      },
    },
  });
  if (myParts.length === 0) {
    return NextResponse.json({ error: "초대받은 활성 출장이 없습니다." }, { status: 404 });
  }

  // 출장 특정: id 또는 이름(정확→부분)
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
    return NextResponse.json({ error: `출장을 특정할 수 없습니다: ${matches.map((p) => p.tripEvent.name).join(", ")}` }, { status: 400 });
  }
  const part = matches[0];
  const ev = part.tripEvent;

  // 초대 응답 가능 상태 검사 (웹과 같은 lib/trip-helpers checkInviteResponse)
  const denied = checkInviteResponse(part.inviteStatus, action);
  if (denied) {
    return NextResponse.json({ error: denied }, { status: 400 });
  }

  // ───── 거부 ───── (웹 decline 동일)
  if (action === "decline") {
    const updated = await prisma.tripParticipant.update({
      where: { id: part.id },
      data: { inviteStatus: "declined" },
    });
    try {
      const creatorId = ev.createdById;
      if (Number.isInteger(creatorId) && creatorId !== myId) {
        const me = await prisma.employee.findUnique({ where: { id: myId }, select: { name: true } });
        await createNotifications({
          employeeIds: [creatorId],
          type: "trip_decline",
          title: "출장 초대 거절",
          body: `${me?.name ?? "직원"}님이 출장 초대를 거절했습니다.`,
          linkPage: "field-trip",
          linkRefId: ev.id,
          sourceType: "trip",
        });
      }
    } catch (e) {
      console.error("[notify] 출장 거절 알림 생성 실패:", e);
    }
    return NextResponse.json({ ok: true, tripEventId: ev.id, inviteStatus: updated.inviteStatus }, { status: 200 });
  }

  // ───── 수락 ───── (웹 trip-participants accept 동일)
  // 참석 날짜: 지정(콤마구분 YYYY-MM-DD)하면 그 날짜(종일).
  // 미지정이면 초대 때 정해둔 날짜(시간 포함)를 그대로 쓰고, 그것도 없으면 출장 전체 기간.
  let parsedDates: ParsedDate[];
  const savedDates = attendDatesText ? [] : part.dates;
  if (savedDates.length > 0) {
    parsedDates = savedDates.map((d) => ({
      attendDate: d.attendDate,
      startTime: d.startTime,
      endTime: d.endTime,
    }));
  } else {
    let rawDates: { attendDate: string }[];
    if (attendDatesText) {
      rawDates = attendDatesText.split(",").map((s) => s.trim()).filter(Boolean).map((d) => ({ attendDate: d }));
    } else {
      rawDates = [];
      const start = new Date(ev.startDate);
      const end = new Date(ev.endDate);
      for (let t = start.getTime(); t <= end.getTime(); t += 86400000) {
        rawDates.push({ attendDate: new Date(t).toISOString().split("T")[0] });
      }
    }
    if (rawDates.length === 0) {
      return NextResponse.json({ error: "참석 날짜를 1개 이상 지정하거나 비워서 전체 기간으로 하세요." }, { status: 400 });
    }
    const parsed = parseDatesArray(rawDates, ev.startDate, ev.endDate);
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }
    parsedDates = parsed.dates;
  }

  // 결재선 계산: pending이고 approverIds 비어있으면 부서 결재선(웹 accept 방법 B)
  let acceptApproverIds: number[] | null = null;
  let acceptApprovalMode: "all" | "any" | null = null;
  let acceptDeputyId: number | null = null;
  // 본인 제외로 결재자가 0명이 되어 not_required로 승격됐는지 (후처리 분기용).
  let promotedNotRequired = false;
  if (part.approvalStatus === "pending" && (!Array.isArray(part.approverIds) || part.approverIds.length === 0)) {
    // 결재선 계산은 lib/approval-resolver 의 resolveTripParticipantApprovers 공용.
    // 결재자가 없으면(본인 제외 후 0명) not_required 로 승격 — 빈 배열 pending 은 유령 결재가 된다.
    const resolved = await resolveTripParticipantApprovers(part.employeeId);
    acceptApproverIds = resolved.approverIds;
    acceptApprovalMode = resolved.approvalMode;
    acceptDeputyId = resolved.deputyApproverId;
    if (resolved.notRequired) {
      promotedNotRequired = true;
    }
  }

  await prisma.$transaction(async (tx) => {
    await tx.tripParticipantDate.deleteMany({ where: { tripParticipantId: part.id } });
    await tx.tripParticipantDate.createMany({
      data: parsedDates.map((d) => ({
        tripParticipantId: part.id,
        attendDate: d.attendDate,
        startTime: d.startTime,
        endTime: d.endTime,
      })),
    });
    await tx.tripParticipant.update({
      where: { id: part.id },
      data: {
        inviteStatus: "accepted",
        ...(promotedNotRequired ? { approvalStatus: "not_required" } : {}),
        ...(acceptApproverIds !== null
          ? { approverIds: acceptApproverIds, approvalMode: acceptApprovalMode ?? "all", deputyApproverId: acceptDeputyId }
          : {}),
      },
    });
  });

  // 후처리: 확정(not_required)→근태+캘린더 / 대기(pending)→결재 알림 (웹 accept 동일)
  if (promotedNotRequired || part.approvalStatus === "not_required") {
    try {
      await createTripParticipantAttendanceRequests(part.id);
    } catch (e) {
      console.error(`[respond-trip-invite accept] createTripParticipantAttendanceRequests(${part.id}) 실패:`, e);
    }
    try {
      await rebuildTripEventCalendar(ev.id);
    } catch (e) {
      console.error(`[respond-trip-invite accept] rebuildTripEventCalendar(${ev.id}) 실패:`, e);
    }
  } else if (acceptApproverIds !== null) {
    await notifyTripApprovalRequested({
      approverIds: acceptApproverIds,
      requesterEmployeeId: myId,
      tripEventId: ev.id,
      logLabel: "accept",
    });
  }

  return NextResponse.json({ ok: true, tripEventId: ev.id, inviteStatus: "accepted" }, { status: 200 });
}

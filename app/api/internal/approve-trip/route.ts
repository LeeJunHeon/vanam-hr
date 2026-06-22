import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireHrWriteAuth } from "@/lib/internal-write-auth";
import { resolveHrIdentity } from "@/lib/internal-identity";
import {
  createTripParticipantAttendanceRequests,
  rebuildTripEventCalendar,
} from "@/lib/trip-calendar";
import { createNotifications } from "@/lib/notify";

export const dynamic = "force-dynamic";

// POST /api/internal/approve-trip — 챗 출장 참여 결재(승인/반려).
// 결재자(권한)는 신원(x-acting-user-email→resolveHrIdentity)에서만 → 위조 불가.
// 웹 handleTripApproval과 동일: approver_ids 권한 / CEO·관리자 폴백 / 승인 시 근태생성+캘린더 / 결과 알림.
// 웹 approvals 라우트는 수정하지 않음(approve-request와 동일하게 챗에서 재구현).
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
  const approverId = identity.employeeId as number;
  const isCeo = identity.role === "ceo";
  const isAdmin = identity.role === "admin";

  let body: { trip?: unknown; target?: unknown; action?: unknown; rejectReason?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const tripText = typeof body.trip === "string" ? body.trip.trim() : "";
  const targetText = typeof body.target === "string" ? body.target.trim() : "";
  const actionRaw = typeof body.action === "string" ? body.action.trim() : "";
  const rejectReason = typeof body.rejectReason === "string" ? body.rejectReason.trim() : "";

  const action =
    actionRaw === "승인" || actionRaw === "approve" ? "approve"
    : actionRaw === "반려" || actionRaw === "reject" ? "reject" : "";
  if (!action) {
    return NextResponse.json({ error: "결재는 승인/반려 중 하나여야 합니다." }, { status: 400 });
  }
  if (action === "reject" && !rejectReason) {
    return NextResponse.json({ error: "반려는 사유가 필수입니다." }, { status: 400 });
  }
  if (!tripText) {
    return NextResponse.json({ error: "어느 출장인지(trip) 알려주세요." }, { status: 400 });
  }
  if (!targetText) {
    return NextResponse.json({ error: "누구의 출장 참여를 결재할지(target) 또는 '전체'를 알려주세요." }, { status: 400 });
  }

  // 출장 특정: 활성 이벤트 중 id 또는 이름(정확→부분). 다수면 되물음.
  const tripIdNum = Number(tripText);
  const activeEvents = await prisma.tripEvent.findMany({
    where: { status: "active" },
    select: { id: true, name: true },
  });
  let evMatches = activeEvents.filter((e) =>
    Number.isInteger(tripIdNum) ? e.id === tripIdNum : e.name === tripText
  );
  if (evMatches.length === 0 && !Number.isInteger(tripIdNum)) {
    const low = tripText.toLowerCase();
    evMatches = activeEvents.filter((e) => e.name.toLowerCase().includes(low));
  }
  if (evMatches.length === 0) {
    return NextResponse.json({ error: `'${tripText}' — 활성 출장에서 찾을 수 없습니다.` }, { status: 404 });
  }
  if (evMatches.length > 1) {
    return NextResponse.json({ error: `출장을 특정할 수 없습니다: ${evMatches.map((e) => e.name).join(", ")}` }, { status: 400 });
  }
  const eventId = evMatches[0].id;

  // 결재 권한 필터 (웹 handleTripApproval과 동일): CEO=제한없음, 관리자=빈 approver_ids 폴백, 그 외=approver_ids/deputy
  const approverFilter = isCeo
    ? {}
    : {
        OR: [
          { approverIds: { has: approverId } },
          { deputyApproverId: approverId },
          ...(isAdmin ? [{ approverIds: { isEmpty: true } }] : []),
        ],
      };

  // 내가 결재할 수 있는 이 출장의 pending 참여자(이름 매칭용 employee.name 포함)
  const candidates = await prisma.tripParticipant.findMany({
    where: { tripEventId: eventId, approvalStatus: "pending", ...approverFilter },
    select: { id: true, employeeId: true, employee: { select: { name: true } } },
  });
  if (candidates.length === 0) {
    return NextResponse.json({ error: "결재할 대기 중인 출장 참여가 없습니다." }, { status: 404 });
  }

  // target: '전체' → 전부, 아니면 이름 매칭(정확→부분)
  let targets = candidates;
  if (targetText !== "전체" && targetText.toLowerCase() !== "all") {
    let m = candidates.filter((c) => (c.employee?.name ?? "") === targetText);
    if (m.length === 0) {
      const low = targetText.toLowerCase();
      m = candidates.filter((c) => (c.employee?.name ?? "").toLowerCase().includes(low));
    }
    if (m.length === 0) {
      return NextResponse.json({ error: `'${targetText}' — 이 출장의 결재 대상에서 찾을 수 없습니다.` }, { status: 404 });
    }
    if (m.length > 1) {
      return NextResponse.json({ error: `대상을 특정할 수 없습니다: ${m.map((c) => c.employee?.name ?? "?").join(", ")}` }, { status: 400 });
    }
    targets = m;
  }

  const targetIds = targets.map((t) => t.id);
  const now = new Date();

  const processed = await prisma.$transaction(async (tx) => {
    const res = await tx.tripParticipant.updateMany({
      where: { id: { in: targetIds } },
      data: {
        approvalStatus: action === "approve" ? "approved" : "rejected",
        approvedById: approverId,
        approvedAt: now,
        rejectReason: action === "reject" ? rejectReason : null,
      },
    });
    return res.count;
  });

  // 승인 시: 참석자별 근태 생성 + 이벤트 캘린더 재구성 (트랜잭션 밖)
  if (action === "approve" && targetIds.length > 0) {
    for (const pid of targetIds) {
      try {
        await createTripParticipantAttendanceRequests(pid);
      } catch (e) {
        console.error(`[approve-trip] createTripParticipantAttendanceRequests(${pid}) 실패:`, e);
      }
    }
    try {
      await rebuildTripEventCalendar(eventId);
    } catch (e) {
      console.error(`[approve-trip] rebuildTripEventCalendar(${eventId}) 실패:`, e);
    }
  }

  // 결과 알림 (각 참석자에게) — 웹과 동일
  try {
    const empIds = targets
      .map((t) => t.employeeId)
      .filter((id): id is number => Number.isInteger(id));
    if (empIds.length > 0) {
      const label = action === "approve" ? "승인" : "반려";
      let resultBody = `출장 신청이 ${label}되었습니다.`;
      if (action === "reject" && rejectReason) resultBody += ` (사유: ${rejectReason})`;
      await createNotifications({
        employeeIds: empIds,
        type: "trip_result",
        title: `출장 ${label}`,
        body: resultBody,
        linkPage: "field-trip",
        linkRefId: eventId,
        sourceType: "trip",
      });
    }
  } catch (e) {
    console.error("[notify] 출장 결재 결과 알림 생성 실패:", e);
  }

  return NextResponse.json(
    { ok: true, tripEventId: eventId, action, processedCount: processed },
    { status: 200 }
  );
}

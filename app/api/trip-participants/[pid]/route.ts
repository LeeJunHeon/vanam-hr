import { NextRequest, NextResponse } from "next/server";
import { requireSession, isAdminSession } from "@/lib/auth-helpers";
import { prisma } from "@/lib/prisma";
import {
  parseDatesArray,
  checkInviteResponse,
  notifyTripApprovalRequested,
} from "@/lib/trip-helpers";
import {
  syncTripParticipantAttendance,
  replaceParticipantDates,
  rebuildTripEventCalendar,
  kstTodayMidnightUtc,
} from "@/lib/trip-calendar";
import { resolveTripParticipantApprovers } from "@/lib/approval-resolver";
import { createNotifications } from "@/lib/notify";
import { LIVE_REQUEST_STATUSES } from "@/lib/attendance-live-requests";

// 그룹 출장(Field Trip) Phase 7 2단계: 참석자 수락/거절/날짜수정 + 제거.
// PATCH /api/trip-participants/[pid]
//   body.action:
//     - 'accept'        : invite_status='accepted'. dates 최소 1개 필요(없으면 400).
//                         body.dates가 오면 그 값으로 전체 교체.
//     - 'decline'       : invite_status='declined'. (이후 다시 accept 가능)
//     - 'update_dates'  : 오늘(KST) 이후 날짜만 body.dates 에 맞춤. 지난 날짜를 바꾸려 하면 400.
//                         approval_status 가 'approved' 면 날짜를 빼기만 한 경우 승인 유지,
//                         추가·시각 변경이면 'pending' 으로 되돌림(재승인 필요 + 결재자 알림).
// DELETE /api/trip-participants/[pid]: 본인/이벤트 생성자/admin/ceo 가능.
//   출장보고서가 있거나 지난 날짜가 근태에 기록된 참석자는 제거 불가(409).

async function loadParticipant(participantId: number) {
  return prisma.tripParticipant.findUnique({
    where: { id: participantId },
    include: {
      tripEvent: {
        select: {
          id: true,
          status: true,
          startDate: true,
          endDate: true,
          createdById: true,
        },
      },
      dates: { select: { id: true } },
    },
  });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ pid: string }> }
) {
  try {
    const sessionR = await requireSession();
    if (!sessionR.ok) return sessionR.response;
    const { session } = sessionR;
    const ownId = session.user.employeeId;

    const { pid: pidRaw } = await params;
    const pid = Number(pidRaw);
    if (!Number.isInteger(pid) || pid <= 0) {
      return NextResponse.json(
        { error: "잘못된 참석자 id" },
        { status: 400 }
      );
    }

    const participant = await loadParticipant(pid);
    if (!participant) {
      return NextResponse.json(
        { error: "참석자를 찾을 수 없습니다." },
        { status: 404 }
      );
    }
    // PATCH는 본인만 가능 (수락/거절/날짜 수정은 본인 권한)
    if (participant.employeeId !== ownId) {
      return NextResponse.json(
        { error: "본인의 참석 정보만 수정할 수 있습니다." },
        { status: 403 }
      );
    }
    if (participant.tripEvent.status !== "active") {
      return NextResponse.json(
        { error: "활성(active) 이벤트만 수정할 수 있습니다." },
        { status: 400 }
      );
    }

    const body = await request.json().catch(() => ({}));
    const { action, dates } = body as { action?: unknown; dates?: unknown };

    if (action !== "accept" && action !== "decline" && action !== "update_dates") {
      return NextResponse.json(
        { error: "action은 accept/decline/update_dates 중 하나여야 합니다." },
        { status: 400 }
      );
    }

    // 초대 응답 가능 상태 검사 (웹·챗 공용 lib/trip-helpers checkInviteResponse)
    //  - 수락: 초대됨·거절 상태에서만 / 거절: 초대됨 상태에서만. update_dates 는 대상 아님.
    if (action === "accept" || action === "decline") {
      const denied = checkInviteResponse(participant.inviteStatus, action);
      if (denied) {
        return NextResponse.json({ error: denied }, { status: 400 });
      }
    }

    // ── decline: 날짜 손대지 않고 상태만 변경 ─────────────
    if (action === "decline") {
      const updated = await prisma.tripParticipant.update({
        where: { id: pid },
        data: { inviteStatus: "declined" },
      });
      // 거절 알림 → 주최자(이벤트 생성자)에게. 단 본인이 주최자면 생략.
      try {
        const creatorId = participant.tripEvent.createdById;
        if (Number.isInteger(creatorId) && creatorId !== ownId) {
          const me = await prisma.employee.findUnique({
            where: { id: participant.employeeId },
            select: { name: true },
          });
          const declinerName = me?.name ?? "직원";
          await createNotifications({
            employeeIds: [creatorId],
            type: "trip_decline",
            title: "출장 초대 거절",
            body: `${declinerName}님이 출장 초대를 거절했습니다.`,
            linkPage: "field-trip",
            linkRefId: participant.tripEvent.id,
            sourceType: "trip",
          });
        }
      } catch (e) {
        console.error("[notify] 출장 거절 알림 생성 실패:", e);
      }
      return NextResponse.json({
        id: updated.id,
        inviteStatus: updated.inviteStatus,
        approvalStatus: updated.approvalStatus,
      });
    }

    // ── accept / update_dates: 둘 다 날짜 교체 흐름 공유 ──
    // body.dates가 오면 그것으로 교체. 없으면 기존 dates 유지(accept만 해당).
    let parsedDates: { attendDate: Date; startTime: Date | null; endTime: Date | null }[] | null = null;
    if (dates !== undefined && dates !== null) {
      const r = parseDatesArray(
        dates,
        participant.tripEvent.startDate,
        participant.tripEvent.endDate
      );
      if (!r.ok) {
        return NextResponse.json({ error: r.error }, { status: 400 });
      }
      parsedDates = r.dates;
    }

    if (action === "accept") {
      // 수락하려면 dates(신규 or 기존) 최소 1개 필요
      const willHaveDates =
        parsedDates !== null
          ? parsedDates.length > 0
          : participant.dates.length > 0;
      if (!willHaveDates) {
        return NextResponse.json(
          { error: "수락하려면 참석 날짜를 1개 이상 입력하세요." },
          { status: 400 }
        );
      }
    } else {
      // update_dates: 반드시 body.dates 필요
      if (parsedDates === null) {
        return NextResponse.json(
          { error: "update_dates에는 dates가 필요합니다." },
          { status: 400 }
        );
      }
    }

    // approval_status: update_dates 의 approved → pending 여부는 날짜 교체 결과(빼기만인지)로 아래에서 정한다.
    let nextApprovalStatus = participant.approvalStatus;

    // accept이고 이 참여자가 결재 대상(pending)이면, 수락 시점에 부서 결재선을 계산해 저장(방법 B).
    // (이미 approver_ids가 채워져 있으면 중복 저장 방지를 위해 비어있을 때만 계산.)
    let acceptApproverIds: number[] | null = null;
    let acceptApprovalMode: "all" | "any" | null = null;
    let acceptDeputyId: number | null = null;
    if (
      action === "accept" &&
      nextApprovalStatus === "pending" &&
      (!Array.isArray(participant.approverIds) || participant.approverIds.length === 0)
    ) {
      // 결재선 계산은 lib/approval-resolver 의 resolveTripParticipantApprovers 공용('출장 및 외근' 결재선).
      // 결재자가 없으면(본인 제외 후 0명) not_required 로 승격 — 빈 배열 pending 은 유령 결재가 된다.
      const resolved = await resolveTripParticipantApprovers(participant.employeeId);
      acceptApproverIds = resolved.approverIds;
      acceptApprovalMode = resolved.approvalMode;
      acceptDeputyId = resolved.deputyApproverId;
      if (resolved.notRequired) {
        nextApprovalStatus = "not_required";
      }
    }

    // 날짜 교체 + 참여 상태 저장 — 한 트랜잭션.
    //  - update_dates: 지난 날짜는 그대로여야 하고(다르면 400) 오늘 이후만 반영(replaceParticipantDates "update").
    //    승인된 참석은 날짜를 빼기만 하면 승인 유지, 추가·시각 변경이면 결재 대기로 되돌림.
    //  - accept: dates 가 오면 전체 교체("initial"), 안 오면 기존 날짜 유지.
    const txResult = await prisma.$transaction(async (tx) => {
      let removedCalendarEventIds: string[] = [];
      let approvalStatus = nextApprovalStatus;
      if (action === "update_dates") {
        const replaced = await replaceParticipantDates(tx, pid, parsedDates ?? [], "update");
        if (!replaced.ok) return { ok: false as const, error: replaced.error };
        removedCalendarEventIds = replaced.removedCalendarEventIds;
        if (participant.approvalStatus === "approved" && !replaced.removeOnly) {
          approvalStatus = "pending";
        }
      } else if (parsedDates !== null) {
        const replaced = await replaceParticipantDates(tx, pid, parsedDates, "initial");
        if (replaced.ok) removedCalendarEventIds = replaced.removedCalendarEventIds;
      }
      const revertedToPending =
        participant.approvalStatus === "approved" && approvalStatus === "pending";

      const p = await tx.tripParticipant.update({
        where: { id: pid },
        data: {
          inviteStatus: action === "accept" ? "accepted" : participant.inviteStatus,
          approvalStatus,
          // accept 시점에 계산됐으면 부서 결재선 저장(방법 B)
          ...(acceptApproverIds !== null
            ? {
                approverIds: acceptApproverIds,
                approvalMode: acceptApprovalMode ?? "all",
                deputyApproverId: acceptDeputyId,
              }
            : {}),
          // approved → pending 되돌림 시 승인자 정보도 초기화
          ...(revertedToPending
            ? { approvedById: null, approvedAt: null, rejectReason: null }
            : {}),
        },
      });
      return { ok: true as const, updated: p, removedCalendarEventIds };
    });
    if (!txResult.ok) {
      return NextResponse.json({ error: txResult.error }, { status: 400 });
    }
    const { updated, removedCalendarEventIds } = txResult;

    // ── 트랜잭션 후처리 (외부 호출은 트랜잭션 밖, 실패는 로그) ──
    // (1) accept + not_required: 근태 동기화 + 이벤트 캘린더 재구성
    // (2) update_dates: 근태 동기화(확정이면 오늘 이후를 새 날짜에 맞춤, 결재 대기로 돌아갔으면
    //     오늘 이후 근태만 정리 — 지난 날 근태는 보존) + 캘린더 재구성(지운 행의 일정 포함)
    if (
      (action === "accept" && updated.approvalStatus === "not_required") ||
      action === "update_dates"
    ) {
      try {
        await syncTripParticipantAttendance(pid);
      } catch (e) {
        console.error(
          `[trip-participants PATCH ${action}] syncTripParticipantAttendance(${pid}) 실패:`,
          e
        );
      }
      try {
        await rebuildTripEventCalendar(participant.tripEvent.id, removedCalendarEventIds);
      } catch (e) {
        console.error(
          `[trip-participants PATCH ${action}] rebuildTripEventCalendar(${participant.tripEvent.id}) 실패:`,
          e
        );
      }
    }

    // accept으로 결재가 필요해진(pending) 참여자면, 부서 결재자에게 "새 출장 결재 요청" 알림.
    // acceptApproverIds는 위에서 이번 accept 시 계산된 결재자(없으면 null).
    if (
      action === "accept" &&
      updated.approvalStatus === "pending" &&
      acceptApproverIds !== null
    ) {
      await notifyTripApprovalRequested({
        approverIds: acceptApproverIds,
        requesterEmployeeId: participant.employeeId,
        tripEventId: participant.tripEvent.id,
        logLabel: "accept",
      });
    }
    // update_dates 로 승인 → 결재 대기로 되돌아갔으면, 저장된 결재자에게 다시 결재 요청 알림.
    if (
      action === "update_dates" &&
      participant.approvalStatus === "approved" &&
      updated.approvalStatus === "pending"
    ) {
      await notifyTripApprovalRequested({
        approverIds: updated.approverIds ?? [],
        requesterEmployeeId: participant.employeeId,
        tripEventId: participant.tripEvent.id,
        logLabel: "update_dates",
      });
    }

    return NextResponse.json({
      id: updated.id,
      inviteStatus: updated.inviteStatus,
      approvalStatus: updated.approvalStatus,
    });
  } catch (error) {
    console.error("PATCH /api/trip-participants/[pid] error:", error);
    return NextResponse.json(
      { error: "참석자 수정 실패" },
      { status: 500 }
    );
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ pid: string }> }
) {
  try {
    const sessionR = await requireSession();
    if (!sessionR.ok) return sessionR.response;
    const { session } = sessionR;
    const ownId = session.user.employeeId;
    const isAdmin = isAdminSession(session);

    const { pid: pidRaw } = await params;
    const pid = Number(pidRaw);
    if (!Number.isInteger(pid) || pid <= 0) {
      return NextResponse.json(
        { error: "잘못된 참석자 id" },
        { status: 400 }
      );
    }

    const participant = await loadParticipant(pid);
    if (!participant) {
      return NextResponse.json(
        { error: "참석자를 찾을 수 없습니다." },
        { status: 404 }
      );
    }

    // 권한: 본인 / 이벤트 생성자 / admin/ceo
    const isSelf = participant.employeeId === ownId;
    const isCreator = participant.tripEvent.createdById === ownId;
    if (!isSelf && !isCreator && !isAdmin) {
      return NextResponse.json(
        { error: "참석자를 제거할 권한이 없습니다." },
        { status: 403 }
      );
    }

    // 출장보고서(작성 중 포함)가 있는 참석자는 제거 불가 — 삭제되면 보고서·경비가 함께 사라진다.
    // 아무것도 지우지 않고(캘린더·근태 정리 포함) 바로 돌려준다.
    const report = await prisma.tripReport.findUnique({
      where: { tripParticipantId: pid },
      select: { id: true },
    });
    if (report) {
      return NextResponse.json(
        { error: "출장보고서가 있어 참석자를 제거할 수 없습니다." },
        { status: 409 }
      );
    }

    // 지난 날짜가 근태에 기록된 참석자는 제거 불가 — 지난 근태는 바꾸지 않는다.
    const today = kstTodayMidnightUtc();
    const pastRecorded = await prisma.attendanceRequest.findFirst({
      where: {
        employeeId: participant.employeeId,
        externalSource: "trip",
        externalEventId: { startsWith: `trip-${participant.tripEvent.id}-${pid}-` },
        status: { in: LIVE_REQUEST_STATUSES },
        startDate: { lt: today },
      },
      select: { id: true },
    });
    if (pastRecorded) {
      return NextResponse.json(
        {
          error:
            "이미 지난 출장 날짜가 근태에 기록돼 있어 참석자를 제거할 수 없습니다. 남은 날짜만 빼려면 날짜 변경을 이용하세요.",
        },
        { status: 409 }
      );
    }

    // 제거 알림용: 타인(주최자/관리자)이 제거하는 경우에만 대상에게 알림.
    const removedEmployeeId = participant.employeeId;
    const removedByOther = removedEmployeeId !== ownId;
    const tripEventId = participant.tripEvent.id;

    // ★ 참석자/dates 가 CASCADE 로 사라지기 전에 이 참석자의 모든 calendar_event_id 를 모아 둔다
    // (rebuild 는 남아있는 행의 event_id 만 찾으므로, 넘겨주지 않으면 일정이 고아로 남는다).
    const removedEventIds = (
      await prisma.tripParticipantDate.findMany({
        where: { tripParticipantId: pid, calendarEventId: { not: null } },
        select: { calendarEventId: true },
      })
    )
      .map((r) => r.calendarEventId)
      .filter((v): v is string => typeof v === "string" && v.length > 0);

    // 오늘 이후 근태 정리(연결 먼저 끊고 삭제)
    try {
      await syncTripParticipantAttendance(pid, { removing: true });
    } catch (e) {
      console.error(
        `[trip-participants DELETE] syncTripParticipantAttendance(${pid}) 실패:`,
        e
      );
    }

    // CASCADE로 dates도 함께 삭제됨
    await prisma.tripParticipant.delete({ where: { id: pid } });

    // 이벤트 캘린더 재구성(이 참석자는 이미 제거되어 새 일정에 포함되지 않음)
    try {
      await rebuildTripEventCalendar(tripEventId, removedEventIds);
    } catch (e) {
      console.error(
        `[trip-participants DELETE] rebuildTripEventCalendar(${tripEventId}) 실패:`,
        e
      );
    }

    // 타인이 제거한 경우, 제거된 참석자에게 알림.
    if (removedByOther) {
      try {
        await createNotifications({
          employeeIds: [removedEmployeeId],
          type: "trip_remove",
          title: "출장 참석자에서 제외",
          body: "출장 참석자에서 제외되었습니다.",
          linkPage: "field-trip",
          linkRefId: tripEventId,
          sourceType: "trip",
        });
      } catch (e) {
        console.error("[notify] 출장 제거 알림 생성 실패:", e);
      }
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("DELETE /api/trip-participants/[pid] error:", error);
    return NextResponse.json(
      { error: "참석자 제거 실패" },
      { status: 500 }
    );
  }
}

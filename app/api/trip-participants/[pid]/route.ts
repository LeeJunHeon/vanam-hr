import { NextRequest, NextResponse } from "next/server";
import { requireSession, isAdminSession } from "@/lib/auth-helpers";
import { prisma } from "@/lib/prisma";
import { parseDatesArray } from "@/lib/trip-helpers";
import {
  cleanupTripParticipantAttendanceFuture,
  collectParticipantFutureEventIds,
  createTripParticipantAttendanceRequests,
  rebuildTripEventCalendar,
} from "@/lib/trip-calendar";
import { resolveApprovers } from "@/lib/approval-resolver";
import { createNotifications } from "@/lib/notify";

// 그룹 출장(Field Trip) Phase 7 2단계: 참석자 수락/거절/날짜수정 + 제거.
// PATCH /api/trip-participants/[pid]
//   body.action:
//     - 'accept'        : invite_status='accepted'. dates 최소 1개 필요(없으면 400).
//                         body.dates가 오면 그 값으로 전체 교체.
//     - 'decline'       : invite_status='declined'. (이후 다시 accept 가능)
//     - 'update_dates'  : body.dates로 전체 교체. approval_status가 'approved'면
//                         'pending'으로 되돌림(재승인 필요).
// DELETE /api/trip-participants/[pid]: 본인/이벤트 생성자/admin/ceo 가능.

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

    // ── decline: 날짜 손대지 않고 상태만 변경 ─────────────
    if (action === "decline") {
      const updated = await prisma.tripParticipant.update({
        where: { id: pid },
        data: { inviteStatus: "declined" },
      });
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

    // approval_status 재승인 되돌림: update_dates에서 approved → pending
    let nextApprovalStatus = participant.approvalStatus;
    if (
      action === "update_dates" &&
      participant.approvalStatus === "approved"
    ) {
      nextApprovalStatus = "pending";
    }

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
      const me = await prisma.employee.findUnique({
        where: { id: participant.employeeId },
        select: { departmentId: true },
      });
      const resolved = await resolveApprovers(prisma, me?.departmentId ?? null);
      acceptApproverIds = resolved.approverIds;
      acceptApprovalMode = resolved.approvalMode;
      acceptDeputyId = resolved.deputyApproverId;
    }

    // update_dates 시 옛 근태(attendance_request) 정리(과거 보존).
    // - approved였다가 pending으로 되돌리는 경우 (재승인 필요)
    // - not_required 유지 케이스(admin self-join 등): cleanup 후 새 dates 기준으로 재생성
    // 두 경우 모두 트랜잭션에서 dates를 갈아엎기 전에 정리해야 함.
    // pending이었으면 근태/캘린더가 없어서 cleanup은 no-op.
    if (
      action === "update_dates" &&
      (participant.approvalStatus === "approved" ||
        participant.approvalStatus === "not_required")
    ) {
      try {
        await cleanupTripParticipantAttendanceFuture(pid);
      } catch (e) {
        console.error(
          `[trip-participants PATCH] attendance cleanup 실패 (pid=${pid}):`,
          e
        );
      }
    }

    // update_dates는 트랜잭션에서 dates를 전부 지우고 다시 만든다(calendar_event_id NULL).
    // 트랜잭션 후 rebuild가 호출되는데, 그 시점엔 옛 dates의 calendar_event_id가
    // 사라져 단독 참석자의 캘린더 일정이 고아로 남는다. → 트랜잭션 시작 전에
    // 미래 event_id를 미리 수집해 rebuild의 extra로 넘긴다.
    let removedEventIds: string[] = [];
    if (action === "update_dates") {
      try {
        removedEventIds = await collectParticipantFutureEventIds(pid);
      } catch (e) {
        console.error(
          `[trip-participants PATCH(update_dates)] collectParticipantFutureEventIds(${pid}) 실패:`,
          e
        );
      }
    }

    const updated = await prisma.$transaction(async (tx) => {
      // 날짜 교체가 필요한 경우만 삭제 후 재생성
      if (parsedDates !== null) {
        await tx.tripParticipantDate.deleteMany({
          where: { tripParticipantId: pid },
        });
        if (parsedDates.length > 0) {
          await tx.tripParticipantDate.createMany({
            data: parsedDates.map((d) => ({
              tripParticipantId: pid,
              attendDate: d.attendDate,
              startTime: d.startTime,
              endTime: d.endTime,
            })),
          });
        }
      }

      const p = await tx.tripParticipant.update({
        where: { id: pid },
        data: {
          inviteStatus: action === "accept" ? "accepted" : participant.inviteStatus,
          approvalStatus: nextApprovalStatus,
          // accept 시점에 계산됐으면 부서 결재선 저장(방법 B)
          ...(acceptApproverIds !== null
            ? {
                approverIds: acceptApproverIds,
                approvalMode: acceptApprovalMode ?? "all",
                deputyApproverId: acceptDeputyId,
              }
            : {}),
          // approved → pending 되돌림 시 승인자 정보도 초기화
          ...(action === "update_dates" &&
          participant.approvalStatus === "approved"
            ? { approvedById: null, approvedAt: null, rejectReason: null }
            : {}),
        },
      });
      return p;
    });

    // ── 트랜잭션 후처리 ──
    // (1) accept + not_required: 근태 생성 + 이벤트 캘린더 재구성
    // (2) update_dates(전체): 옛 캘린더 일정 정리 + (확정 유지 시) 근태 재생성 + rebuild
    //     - approved→pending: 이 참석자는 확정 집합에서 빠짐(rebuild가 자동 제외)
    //     - not_required 유지: 근태 재생성 후 새 날짜로 rebuild 포함
    //     - pending 유지(현재 코드상 발생 X, 안전 분기): rebuild만(no-op 가까움)
    // 외부 호출은 모두 트랜잭션 밖, 실패는 로그.
    if (action === "accept" && updated.approvalStatus === "not_required") {
      try {
        await createTripParticipantAttendanceRequests(pid);
      } catch (e) {
        console.error(
          `[trip-participants PATCH] createTripParticipantAttendanceRequests(${pid}) 실패:`,
          e
        );
      }
      try {
        // accept 경로의 removedEventIds는 빈 배열 — 기존 동작과 동일.
        await rebuildTripEventCalendar(participant.tripEvent.id, removedEventIds);
      } catch (e) {
        console.error(
          `[trip-participants PATCH] rebuildTripEventCalendar(${participant.tripEvent.id}) 실패:`,
          e
        );
      }
    } else if (action === "update_dates") {
      // not_required 유지: 새 dates 기준으로 근태 재생성(approved→pending이면 skip).
      // createTripParticipantAttendanceRequests는 멱등(이미 링크된 그룹 skip)이라
      // 위에서 cleanup된 직후 호출해도 안전.
      if (updated.approvalStatus === "not_required") {
        try {
          await createTripParticipantAttendanceRequests(pid);
        } catch (e) {
          console.error(
            `[trip-participants PATCH] update_dates createTripParticipantAttendanceRequests(${pid}) 실패:`,
            e
          );
        }
      }
      // 트랜잭션 시작 전에 수집한 removedEventIds를 함께 넘겨 고아 일정 제거 + rebuild.
      try {
        await rebuildTripEventCalendar(participant.tripEvent.id, removedEventIds);
      } catch (e) {
        console.error(
          `[trip-participants PATCH] update_dates rebuildTripEventCalendar(${participant.tripEvent.id}) 실패:`,
          e
        );
      }
    }

    // accept으로 결재가 필요해진(pending) 참여자면, 부서 결재자에게 "새 출장 결재 요청" 알림.
    // acceptApproverIds는 위에서 이번 accept 시 계산된 결재자(없으면 null).
    if (
      action === "accept" &&
      updated.approvalStatus === "pending" &&
      acceptApproverIds !== null &&
      acceptApproverIds.length > 0
    ) {
      try {
        const me = await prisma.employee.findUnique({
          where: { id: participant.employeeId },
          select: { name: true },
        });
        const requesterName = me?.name ?? "직원";
        await createNotifications({
          employeeIds: acceptApproverIds,
          type: "approval_request",
          title: "새 출장 결재 요청",
          body: `${requesterName}님의 출장 참여 결재 요청`,
          linkPage: "approval",
          linkRefId: participant.tripEvent.id,
          sourceType: "trip",
        });
      } catch (e) {
        console.error("[notify] 출장 결재 요청 알림 생성 실패(accept):", e);
      }
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

    // 삭제 전에 미래 근태(attendance_request)부터 정리(과거 보존).
    // 캘린더는 삭제 후 이벤트 단위로 rebuild하면 자동으로 정리·재구성된다.
    const tripEventId = participant.tripEvent.id;

    // ★ 참석자/dates가 CASCADE로 사라지기 전에 미래 calendar_event_id를 수집해 둔다.
    // 그러지 않으면 단독 참석자의 캘린더 일정이 고아로 남는다(rebuild는 살아있는
    // dates의 event_id만 찾음).
    let removedEventIds: string[] = [];
    try {
      removedEventIds = await collectParticipantFutureEventIds(pid);
    } catch (e) {
      console.error(
        `[trip-participants DELETE] collectParticipantFutureEventIds(${pid}) 실패:`,
        e
      );
    }

    try {
      await cleanupTripParticipantAttendanceFuture(pid);
    } catch (e) {
      console.error(
        `[trip-participants DELETE] attendance cleanup 실패 (pid=${pid}):`,
        e
      );
    }

    // CASCADE로 dates도 함께 삭제됨
    await prisma.tripParticipant.delete({ where: { id: pid } });

    // 이벤트 캘린더 재구성(이 참석자는 이미 제거되어 새 일정에 포함되지 않음)
    // 미리 수집한 event_id를 함께 넘겨 단독 참석자 일정도 확실히 삭제.
    try {
      await rebuildTripEventCalendar(tripEventId, removedEventIds);
    } catch (e) {
      console.error(
        `[trip-participants DELETE] rebuildTripEventCalendar(${tripEventId}) 실패:`,
        e
      );
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

import { NextRequest, NextResponse } from "next/server";
import { requireSession, isAdminSession } from "@/lib/auth-helpers";
import { prisma } from "@/lib/prisma";
import { parseDatesArray } from "@/lib/trip-helpers";
import { cleanupTripParticipantFutureDates } from "@/lib/trip-calendar";

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

    // Phase 7 4단계: approved였던 참석자가 update_dates로 pending이 되면,
    // 트랜잭션에서 dates를 전부 교체하기 전에 미래 날짜의 캘린더·근태를 정리한다.
    // (과거 날짜는 보존). 정리 실패는 로그만 — 데이터 변경은 진행.
    if (
      action === "update_dates" &&
      participant.approvalStatus === "approved"
    ) {
      try {
        await cleanupTripParticipantFutureDates(pid);
      } catch (e) {
        console.error(
          `[trip-participants PATCH] cleanup 실패 (pid=${pid}):`,
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
          // approved → pending 되돌림 시 승인자 정보도 초기화
          ...(action === "update_dates" &&
          participant.approvalStatus === "approved"
            ? { approvedById: null, approvedAt: null, rejectReason: null }
            : {}),
        },
      });
      return p;
    });

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

    // Phase 7 4단계: 삭제 전에 미래 날짜의 캘린더·근태 정리.
    // (CASCADE로 dates는 곧 삭제되지만, 그 전에 외부 캘린더 + attendance_request를
    //  미리 치우지 않으면 고아 데이터가 남는다. 과거 날짜는 보존.)
    try {
      await cleanupTripParticipantFutureDates(pid);
    } catch (e) {
      console.error(
        `[trip-participants DELETE] cleanup 실패 (pid=${pid}):`,
        e
      );
    }

    // CASCADE로 dates도 함께 삭제됨
    await prisma.tripParticipant.delete({ where: { id: pid } });
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("DELETE /api/trip-participants/[pid] error:", error);
    return NextResponse.json(
      { error: "참석자 제거 실패" },
      { status: 500 }
    );
  }
}

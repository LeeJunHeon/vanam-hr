import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-helpers";
import { prisma } from "@/lib/prisma";
import {
  parseDatesArray,
  computeApprovalStatus,
} from "@/lib/trip-helpers";
import {
  createTripParticipantAttendanceRequests,
  rebuildTripEventCalendar,
} from "@/lib/trip-calendar";
import { resolveApprovers } from "@/lib/approval-resolver";
import { createNotifications } from "@/lib/notify";

// 그룹 출장(Field Trip) Phase 7 2단계: self-join.
// POST /api/trip-events/[id]/join
// body: { dates: [{ attendDate, startTime?, endTime? }] }  // 1개 이상 필수
//
// 권한: 로그인 본인. 이벤트 status='active'일 때만.
// 결재 규칙: invite_status='accepted'(즉시 수락), approval_status는 본인 role 기준
//            (admin/ceo → 'not_required', employee → 'pending').
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const sessionR = await requireSession();
    if (!sessionR.ok) return sessionR.response;
    const { session } = sessionR;

    const ownId = session.user.employeeId;
    if (!Number.isInteger(ownId)) {
      return NextResponse.json(
        {
          error:
            "본인 직원 정보가 매핑되어 있지 않습니다. 관리자에게 직원 등록을 요청하세요.",
        },
        { status: 403 }
      );
    }

    const { id: idRaw } = await params;
    const eventId = Number(idRaw);
    if (!Number.isInteger(eventId) || eventId <= 0) {
      return NextResponse.json({ error: "잘못된 이벤트 id" }, { status: 400 });
    }

    const body = await request.json().catch(() => ({}));
    const { dates } = body as { dates?: unknown };

    const [ev, dup] = await Promise.all([
      prisma.tripEvent.findUnique({
        where: { id: eventId },
        select: { id: true, status: true, startDate: true, endDate: true },
      }),
      prisma.tripParticipant.findUnique({
        where: {
          tripEventId_employeeId: {
            tripEventId: eventId,
            employeeId: ownId as number,
          },
        },
        select: { id: true },
      }),
    ]);

    if (!ev) {
      return NextResponse.json(
        { error: "이벤트를 찾을 수 없습니다." },
        { status: 404 }
      );
    }
    if (ev.status !== "active") {
      return NextResponse.json(
        { error: "활성(active) 이벤트만 참여할 수 있습니다." },
        { status: 400 }
      );
    }
    if (dup) {
      return NextResponse.json(
        { error: "이미 참석자로 등록되어 있습니다." },
        { status: 409 }
      );
    }

    // self-join은 날짜 1개 이상 필수
    if (!Array.isArray(dates) || dates.length === 0) {
      return NextResponse.json(
        { error: "참여 날짜를 1개 이상 입력하세요." },
        { status: 400 }
      );
    }
    const r = parseDatesArray(dates, ev.startDate, ev.endDate);
    if (!r.ok) {
      return NextResponse.json({ error: r.error }, { status: 400 });
    }

    const approvalStatus = computeApprovalStatus(session.user.role);

    // 본인이 employee라 결재가 필요(pending)하면 부서 결재선을 계산해 저장(방법 B: 본인 참여 시점).
    // admin/ceo(not_required)는 결재 불필요 → 빈 배열 유지.
    let resolvedApproverIds: number[] = [];
    let resolvedApprovalMode: "all" | "any" = "all";
    let resolvedDeputyId: number | null = null;
    if (approvalStatus === "pending") {
      const me = await prisma.employee.findUnique({
        where: { id: ownId as number },
        select: { departmentId: true },
      });
      const resolved = await resolveApprovers(prisma, me?.departmentId ?? null);
      resolvedApproverIds = resolved.approverIds;
      resolvedApprovalMode = resolved.approvalMode;
      resolvedDeputyId = resolved.deputyApproverId;
    }

    const created = await prisma.$transaction(async (tx) => {
      const p = await tx.tripParticipant.create({
        data: {
          tripEventId: eventId,
          employeeId: ownId as number,
          inviteStatus: "accepted",
          approvalStatus,
          approverIds: resolvedApproverIds,
          approvalMode: resolvedApprovalMode,
          deputyApproverId: resolvedDeputyId,
        },
      });
      await tx.tripParticipantDate.createMany({
        data: r.dates.map((d) => ({
          tripParticipantId: p.id,
          attendDate: d.attendDate,
          startTime: d.startTime,
          endTime: d.endTime,
        })),
      });
      return p;
    });

    // self-join은 invite_status='accepted'로 생성된다.
    // approval_status가 'not_required'(=본인이 admin/ceo)이면 결재를 거치지 않으므로
    // 여기서 근태 생성 + 이벤트 캘린더 재구성. 'pending'(=employee)이면 결재 승인 시 트리거.
    if (created.approvalStatus === "not_required") {
      try {
        await createTripParticipantAttendanceRequests(created.id);
      } catch (e) {
        console.error(
          `[trip-events/join] createTripParticipantAttendanceRequests(${created.id}) 실패:`,
          e
        );
      }
      try {
        await rebuildTripEventCalendar(eventId);
      } catch (e) {
        console.error(
          `[trip-events/join] rebuildTripEventCalendar(${eventId}) 실패:`,
          e
        );
      }
    }

    // 결재가 필요한 self-join(employee)이면, 부서 결재자에게 "새 출장 결재 요청" 알림.
    // resolvedApproverIds는 위에서 계산된 이 참여자의 결재자(부서 결재선 or fallback).
    if (created.approvalStatus === "pending" && resolvedApproverIds.length > 0) {
      try {
        const me = await prisma.employee.findUnique({
          where: { id: ownId as number },
          select: { name: true },
        });
        const requesterName = me?.name ?? "직원";
        await createNotifications({
          employeeIds: resolvedApproverIds,
          type: "trip_request",
          title: "새 출장 결재 요청",
          body: `${requesterName}님의 출장 참여 결재 요청`,
          linkPage: "approval",
          linkRefId: eventId,
          sourceType: "trip",
        });
      } catch (e) {
        console.error("[notify] 출장 결재 요청 알림 생성 실패(self-join):", e);
      }
    }

    return NextResponse.json(
      {
        id: created.id,
        tripEventId: created.tripEventId,
        employeeId: created.employeeId,
        inviteStatus: created.inviteStatus,
        approvalStatus: created.approvalStatus,
      },
      { status: 201 }
    );
  } catch (error) {
    console.error("POST /api/trip-events/[id]/join error:", error);
    return NextResponse.json(
      { error: "self-join 실패" },
      { status: 500 }
    );
  }
}

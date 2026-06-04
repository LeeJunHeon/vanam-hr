import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-helpers";
import { prisma } from "@/lib/prisma";
import {
  parseDatesArray,
  computeApprovalStatus,
} from "@/lib/trip-helpers";

// 그룹 출장(Field Trip) Phase 7 2단계: 타인 초대.
// POST /api/trip-events/[id]/participants
// body: { employeeId: number, dates?: [{ attendDate, startTime?, endTime? }] }
//
// 권한: 로그인한 모든 사용자(이벤트 생성자/admin/직원 누구나). 이벤트 status='active'일 때만.
// 결재 규칙: 요청자 role이 admin/ceo → approval_status='not_required',
//            employee → 'pending'. invite_status='invited'.
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
    const { employeeId, dates } = body as {
      employeeId?: unknown;
      dates?: unknown;
    };

    const targetEmployeeId = Number(employeeId);
    if (!Number.isInteger(targetEmployeeId) || targetEmployeeId <= 0) {
      return NextResponse.json(
        { error: "employeeId는 양의 정수여야 합니다." },
        { status: 400 }
      );
    }

    // 이벤트 + 대상 직원 + 중복 참석자 확인
    const [ev, targetEmp, dup] = await Promise.all([
      prisma.tripEvent.findUnique({
        where: { id: eventId },
        select: { id: true, status: true, startDate: true, endDate: true },
      }),
      prisma.employee.findUnique({
        where: { id: targetEmployeeId },
        select: { id: true, isActive: true },
      }),
      prisma.tripParticipant.findUnique({
        where: {
          tripEventId_employeeId: {
            tripEventId: eventId,
            employeeId: targetEmployeeId,
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
        { error: "활성(active) 이벤트만 참석자를 추가할 수 있습니다." },
        { status: 400 }
      );
    }
    if (!targetEmp) {
      return NextResponse.json(
        { error: "대상 직원을 찾을 수 없습니다." },
        { status: 404 }
      );
    }
    if (!targetEmp.isActive) {
      return NextResponse.json(
        { error: "비활성 직원은 초대할 수 없습니다." },
        { status: 400 }
      );
    }
    if (dup) {
      return NextResponse.json(
        { error: "이미 참석자로 등록되어 있습니다." },
        { status: 409 }
      );
    }

    // 날짜 검증 (있는 경우만 — 초대는 날짜 미지정 허용)
    let parsedDates: { attendDate: Date; startTime: Date | null; endTime: Date | null }[] = [];
    if (dates !== undefined && dates !== null) {
      const r = parseDatesArray(dates, ev.startDate, ev.endDate);
      if (!r.ok) {
        return NextResponse.json({ error: r.error }, { status: 400 });
      }
      parsedDates = r.dates;
    }

    const approvalStatus = computeApprovalStatus(session.user.role);

    // 트랜잭션: 참석자 + 날짜 함께 생성
    const created = await prisma.$transaction(async (tx) => {
      const p = await tx.tripParticipant.create({
        data: {
          tripEventId: eventId,
          employeeId: targetEmployeeId,
          inviteStatus: "invited",
          approvalStatus,
        },
      });
      if (parsedDates.length > 0) {
        await tx.tripParticipantDate.createMany({
          data: parsedDates.map((d) => ({
            tripParticipantId: p.id,
            attendDate: d.attendDate,
            startTime: d.startTime,
            endTime: d.endTime,
          })),
        });
      }
      return p;
    });

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
    console.error("POST /api/trip-events/[id]/participants error:", error);
    return NextResponse.json(
      { error: "참석자 초대 실패" },
      { status: 500 }
    );
  }
}

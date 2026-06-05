import { NextRequest, NextResponse } from "next/server";
import { requireSession, isAdminSession } from "@/lib/auth-helpers";
import { prisma } from "@/lib/prisma";
import { cleanupTripEventFutureDates } from "@/lib/trip-calendar";

// 그룹 출장(Field Trip) Phase 7 2단계: 이벤트 단건 조회 + 참석자 상세.

function ymdFromDate(d: Date): string {
  return d.toISOString().split("T")[0];
}

// @db.Time(6)으로 저장된 Date에서 HH:MM만 추출 (UTC).
function hhmmFromTime(d: Date | null): string | null {
  if (!d) return null;
  // toISOString은 "1970-01-01T09:30:00.000Z" 형태 → 11..16 슬라이스
  return d.toISOString().slice(11, 16);
}

// GET /api/trip-events/[id]
// 로그인한 모든 사용자.
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const sessionR = await requireSession();
    if (!sessionR.ok) return sessionR.response;

    const { id: idRaw } = await params;
    const id = Number(idRaw);
    if (!Number.isInteger(id) || id <= 0) {
      return NextResponse.json(
        { error: "잘못된 이벤트 id" },
        { status: 400 }
      );
    }

    const ev = await prisma.tripEvent.findUnique({
      where: { id },
      include: {
        createdBy: { select: { id: true, name: true, employeeNo: true } },
        participants: {
          orderBy: [{ createdAt: "asc" }],
          include: {
            employee: {
              select: {
                id: true,
                name: true,
                employeeNo: true,
                department: { select: { id: true, name: true } },
              },
            },
            approvedBy: { select: { id: true, name: true } },
            dates: {
              orderBy: [{ attendDate: "asc" }],
              select: {
                id: true,
                attendDate: true,
                startTime: true,
                endTime: true,
                calendarEventId: true,
                attendanceRequestId: true,
              },
            },
          },
        },
      },
    });

    if (!ev) {
      return NextResponse.json(
        { error: "이벤트를 찾을 수 없습니다." },
        { status: 404 }
      );
    }

    return NextResponse.json({
      id: ev.id,
      name: ev.name,
      location: ev.location,
      startDate: ymdFromDate(ev.startDate),
      endDate: ymdFromDate(ev.endDate),
      status: ev.status,
      createdById: ev.createdById,
      createdByName: ev.createdBy?.name ?? null,
      creatorIsAdmin: ev.creatorIsAdmin,
      createdAt: ev.createdAt.toISOString(),
      participants: ev.participants.map((p) => ({
        id: p.id,
        employeeId: p.employeeId,
        employeeName: p.employee?.name ?? null,
        employeeNo: p.employee?.employeeNo ?? null,
        departmentId: p.employee?.department?.id ?? null,
        departmentName: p.employee?.department?.name ?? null,
        inviteStatus: p.inviteStatus,
        approvalStatus: p.approvalStatus,
        approvedById: p.approvedById,
        approvedByName: p.approvedBy?.name ?? null,
        approvedAt: p.approvedAt ? p.approvedAt.toISOString() : null,
        rejectReason: p.rejectReason,
        dates: p.dates.map((d) => ({
          id: d.id,
          attendDate: ymdFromDate(d.attendDate),
          startTime: hhmmFromTime(d.startTime),
          endTime: hhmmFromTime(d.endTime),
          calendarEventId: d.calendarEventId,
          attendanceRequestId: d.attendanceRequestId,
        })),
      })),
    });
  } catch (error) {
    console.error("GET /api/trip-events/[id] error:", error);
    return NextResponse.json(
      { error: "이벤트 조회 실패" },
      { status: 500 }
    );
  }
}

// Phase 7 4단계: 이벤트 취소.
// PATCH /api/trip-events/[id]  body: { action: 'cancel' }
// - 권한: 이벤트 생성자 또는 admin/ceo
// - 동작: status='closed' + 모든 참석자의 미래 날짜 캘린더·근태 정리(과거 보호)
// - 이미 closed면 정리만 재실행하지 않고 OK 반환
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const sessionR = await requireSession();
    if (!sessionR.ok) return sessionR.response;
    const { session } = sessionR;
    const ownId = session.user.employeeId;
    const isAdmin = isAdminSession(session);

    const { id: idRaw } = await params;
    const eventId = Number(idRaw);
    if (!Number.isInteger(eventId) || eventId <= 0) {
      return NextResponse.json({ error: "잘못된 이벤트 id" }, { status: 400 });
    }

    const body = await request.json().catch(() => ({}));
    const action = (body as { action?: unknown }).action;
    if (action !== "cancel") {
      return NextResponse.json(
        { error: "action은 'cancel'만 지원합니다." },
        { status: 400 }
      );
    }

    const ev = await prisma.tripEvent.findUnique({
      where: { id: eventId },
      select: { id: true, status: true, createdById: true },
    });
    if (!ev) {
      return NextResponse.json(
        { error: "이벤트를 찾을 수 없습니다." },
        { status: 404 }
      );
    }

    // 권한: 생성자 또는 admin/ceo
    if (ev.createdById !== ownId && !isAdmin) {
      return NextResponse.json(
        { error: "이벤트를 취소할 권한이 없습니다." },
        { status: 403 }
      );
    }

    if (ev.status === "closed") {
      return NextResponse.json({ ok: true, alreadyClosed: true });
    }

    // 캘린더·근태 정리(미래 날짜만) → 트랜잭션 밖. 실패해도 status 변경은 진행.
    try {
      await cleanupTripEventFutureDates(eventId);
    } catch (e) {
      console.error(
        `[trip-events PATCH] cleanup 실패 (eventId=${eventId}):`,
        e
      );
    }

    await prisma.tripEvent.update({
      where: { id: eventId },
      data: { status: "closed" },
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("PATCH /api/trip-events/[id] error:", error);
    return NextResponse.json(
      { error: "이벤트 취소 실패" },
      { status: 500 }
    );
  }
}

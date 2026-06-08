import { NextRequest, NextResponse } from "next/server";
import { requireSession, isAdminSession } from "@/lib/auth-helpers";
import { prisma } from "@/lib/prisma";
import {
  cleanupTripParticipantAttendanceFuture,
  rebuildTripEventCalendar,
} from "@/lib/trip-calendar";

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
      description: ev.description,
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
    if (action !== "cancel" && action !== "update") {
      return NextResponse.json(
        { error: "action은 'cancel' 또는 'update'만 지원합니다." },
        { status: 400 }
      );
    }

    const ev = await prisma.tripEvent.findUnique({
      where: { id: eventId },
      select: {
        id: true,
        status: true,
        createdById: true,
        startDate: true,
        endDate: true,
        name: true,
        location: true,
        description: true,
      },
    });
    if (!ev) {
      return NextResponse.json(
        { error: "이벤트를 찾을 수 없습니다." },
        { status: 404 }
      );
    }

    // 권한: 생성자 또는 admin/ceo (cancel·update 공통)
    if (ev.createdById !== ownId && !isAdmin) {
      return NextResponse.json(
        { error: "이벤트를 변경할 권한이 없습니다." },
        { status: 403 }
      );
    }

    // ── action: update (이름·장소·메모·기간 수정) ──
    if (action === "update") {
      const b = body as {
        name?: unknown;
        location?: unknown;
        description?: unknown;
        startDate?: unknown;
        endDate?: unknown;
      };

      const name = typeof b.name === "string" ? b.name.trim() : "";
      if (name.length === 0) {
        return NextResponse.json(
          { error: "출장명은 필수입니다." },
          { status: 400 }
        );
      }
      if (name.length > 200) {
        return NextResponse.json(
          { error: "출장명이 너무 깁니다 (최대 200자)." },
          { status: 400 }
        );
      }

      const location =
        typeof b.location === "string" && b.location.trim().length > 0
          ? b.location.trim()
          : null;
      const description =
        typeof b.description === "string" && b.description.trim().length > 0
          ? b.description.trim()
          : null;

      const sd = typeof b.startDate === "string" ? b.startDate : "";
      const ed = typeof b.endDate === "string" ? b.endDate : "";
      if (!/^\d{4}-\d{2}-\d{2}$/.test(sd) || !/^\d{4}-\d{2}-\d{2}$/.test(ed)) {
        return NextResponse.json(
          { error: "날짜 형식이 잘못되었습니다 (YYYY-MM-DD)." },
          { status: 400 }
        );
      }
      if (sd > ed) {
        return NextResponse.json(
          { error: "종료일은 시작일 이후여야 합니다." },
          { status: 400 }
        );
      }
      const newStart = new Date(sd + "T00:00:00.000Z");
      const newEnd = new Date(ed + "T00:00:00.000Z");

      // 기간이 바뀌는 경우에만 충돌 검사 (이름/장소/메모만 바뀌면 skip)
      const periodChanged =
        sd !== ymdFromDate(ev.startDate) || ed !== ymdFromDate(ev.endDate);

      if (periodChanged) {
        // 참석자 날짜 중 새 기간을 벗어나는 것이 하나라도 있으면 차단
        const outOfRange = await prisma.tripParticipantDate.findMany({
          where: {
            tripParticipant: { tripEventId: eventId },
            OR: [
              { attendDate: { lt: newStart } },
              { attendDate: { gt: newEnd } },
            ],
          },
          select: {
            attendDate: true,
            tripParticipant: {
              select: { employee: { select: { name: true } } },
            },
          },
          orderBy: { attendDate: "asc" },
        });

        if (outOfRange.length > 0) {
          const detail = outOfRange
            .map(
              (d) =>
                `${d.tripParticipant.employee?.name ?? "?"}(${ymdFromDate(
                  d.attendDate
                )})`
            )
            .join(", ");
          return NextResponse.json(
            {
              error:
                "다음 참석자 날짜가 새 기간을 벗어나 수정할 수 없습니다: " +
                detail +
                ". 해당 참석자의 날짜를 먼저 수정하거나 참석자를 제거한 뒤 기간을 변경하세요.",
            },
            { status: 409 }
          );
        }
      }

      await prisma.tripEvent.update({
        where: { id: eventId },
        data: {
          name,
          location,
          description,
          startDate: newStart,
          endDate: newEnd,
        },
      });

      // 캘린더 재구성 (이름/장소/메모/기간 반영). 실패는 로그만.
      try {
        await rebuildTripEventCalendar(eventId);
      } catch (e) {
        console.error(
          `[trip-events PATCH update] rebuildTripEventCalendar(${eventId}) 실패:`,
          e
        );
      }

      return NextResponse.json({ ok: true });
    }

    if (ev.status === "closed") {
      return NextResponse.json({ ok: true, alreadyClosed: true });
    }

    // 1) 모든 참석자의 미래 근태(attendance_request) 정리(과거 보존)
    const allParticipants = await prisma.tripParticipant.findMany({
      where: { tripEventId: eventId },
      select: { id: true },
    });
    for (const p of allParticipants) {
      try {
        await cleanupTripParticipantAttendanceFuture(p.id);
      } catch (e) {
        console.error(
          `[trip-events PATCH] attendance cleanup 실패 (pid=${p.id}):`,
          e
        );
      }
    }

    // 2) status='closed'로 변경 (rebuild가 active 아니면 cleanup-only 모드로 동작)
    await prisma.tripEvent.update({
      where: { id: eventId },
      data: { status: "closed" },
    });

    // 3) 이벤트 캘린더 재구성 → status가 closed이므로 미래 캘린더 일정 삭제만 수행
    try {
      await rebuildTripEventCalendar(eventId);
    } catch (e) {
      console.error(
        `[trip-events PATCH] rebuildTripEventCalendar(${eventId}) 실패:`,
        e
      );
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("PATCH /api/trip-events/[id] error:", error);
    return NextResponse.json(
      { error: "이벤트 취소 실패" },
      { status: 500 }
    );
  }
}

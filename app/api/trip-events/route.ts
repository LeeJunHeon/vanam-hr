import { NextRequest, NextResponse } from "next/server";
import { requireSession, isAdminSession } from "@/lib/auth-helpers";
import { prisma } from "@/lib/prisma";

// 그룹 출장(Field Trip) Phase 7 1단계: 이벤트 생성/목록 API.
// 참석자/초대/결재/캘린더 연동은 이번 단계에 없음.

// YYYY-MM-DD → Date (UTC midnight). 잘못된 형식이면 null.
function parseYmd(s: unknown): Date | null {
  if (typeof s !== "string") return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(s + "T00:00:00.000Z");
  return isNaN(d.getTime()) ? null : d;
}

function ymdFromDate(d: Date): string {
  return d.toISOString().split("T")[0];
}

// GET /api/trip-events
// 전체 출장 이벤트 목록(활성+취소). 프론트에서 활성/예정·취소/지난 탭으로 분류.
// 모든 로그인 사용자가 호출 가능. 응답에 참석자 수(participantCount) 포함.
export async function GET() {
  try {
    const sessionR = await requireSession();
    if (!sessionR.ok) return sessionR.response;

    const events = await prisma.tripEvent.findMany({
      orderBy: [{ startDate: "desc" }, { createdAt: "desc" }],
      include: {
        createdBy: {
          select: { id: true, name: true, employeeNo: true },
        },
        _count: {
          select: { participants: true },
        },
        participants: { select: { employeeId: true } },
      },
    });

    return NextResponse.json(
      events.map((e) => ({
        id: e.id,
        name: e.name,
        location: e.location,
        description: e.description,
        startDate: ymdFromDate(e.startDate),
        endDate: ymdFromDate(e.endDate),
        status: e.status,
        createdById: e.createdById,
        createdByName: e.createdBy?.name ?? null,
        creatorIsAdmin: e.creatorIsAdmin,
        createdAt: e.createdAt.toISOString(),
        participantCount: e._count.participants,
        participantIds: e.participants.map((p) => p.employeeId),
      }))
    );
  } catch (error) {
    console.error("GET /api/trip-events error:", error);
    return NextResponse.json(
      { error: "출장 이벤트를 불러올 수 없습니다." },
      { status: 500 }
    );
  }
}

// POST /api/trip-events
// body: { name, location?, startDate, endDate }
// 로그인한 직원이라면 누구든 출장 이벤트를 만들 수 있다(주최자 본인 = 생성자).
// 참석자 레코드는 이번 단계에서 생성하지 않는다(다음 단계).
export async function POST(request: NextRequest) {
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

    const body = await request.json().catch(() => ({}));
    const { name, location, description, startDate, endDate, calendarSourceId } = body as {
      name?: unknown;
      location?: unknown;
      description?: unknown;
      startDate?: unknown;
      endDate?: unknown;
      calendarSourceId?: unknown;
    };

    // 검증
    if (typeof name !== "string" || name.trim().length === 0) {
      return NextResponse.json(
        { error: "name(출장명)은 필수입니다." },
        { status: 400 }
      );
    }
    if (name.length > 200) {
      return NextResponse.json(
        { error: "name은 200자 이하여야 합니다." },
        { status: 400 }
      );
    }
    if (location !== undefined && location !== null && typeof location !== "string") {
      return NextResponse.json(
        { error: "location은 문자열이어야 합니다." },
        { status: 400 }
      );
    }
    if (typeof location === "string" && location.length > 200) {
      return NextResponse.json(
        { error: "location은 200자 이하여야 합니다." },
        { status: 400 }
      );
    }
    if (description !== undefined && description !== null && typeof description !== "string") {
      return NextResponse.json(
        { error: "description은 문자열이어야 합니다." },
        { status: 400 }
      );
    }
    const start = parseYmd(startDate);
    const end = parseYmd(endDate);
    if (!start || !end) {
      return NextResponse.json(
        { error: "startDate, endDate 형식이 잘못되었습니다 (YYYY-MM-DD)." },
        { status: 400 }
      );
    }
    if (start.getTime() > end.getTime()) {
      return NextResponse.json(
        { error: "startDate는 endDate보다 빠르거나 같아야 합니다." },
        { status: 400 }
      );
    }

    // calendarSourceId 검증: 정수이고 calendar_sources에 존재해야 함. 없으면 null(폴백).
    let validCalendarSourceId: number | null = null;
    if (calendarSourceId !== undefined && calendarSourceId !== null) {
      const csId = Number(calendarSourceId);
      if (!Number.isInteger(csId)) {
        return NextResponse.json(
          { error: "calendarSourceId는 정수여야 합니다." },
          { status: 400 }
        );
      }
      const cs = await prisma.calendarSource.findUnique({
        where: { id: csId },
        select: { id: true },
      });
      if (!cs) {
        return NextResponse.json(
          { error: "존재하지 않는 calendarSourceId입니다." },
          { status: 400 }
        );
      }
      validCalendarSourceId = csId;
    }

    // creator_is_admin = 생성 시점 스냅샷
    const creatorIsAdmin = isAdminSession(session);

    const created = await prisma.tripEvent.create({
      data: {
        name: name.trim(),
        location:
          typeof location === "string" && location.trim().length > 0
            ? location.trim()
            : null,
        description:
          typeof description === "string" && description.trim().length > 0
            ? description.trim()
            : null,
        startDate: start,
        endDate: end,
        createdById: ownId as number,
        creatorIsAdmin,
        status: "active",
        calendarSourceId: validCalendarSourceId,
      },
      include: {
        createdBy: { select: { id: true, name: true, employeeNo: true } },
      },
    });

    return NextResponse.json(
      {
        id: created.id,
        name: created.name,
        location: created.location,
        description: created.description,
        startDate: ymdFromDate(created.startDate),
        endDate: ymdFromDate(created.endDate),
        status: created.status,
        createdById: created.createdById,
        createdByName: created.createdBy?.name ?? null,
        creatorIsAdmin: created.creatorIsAdmin,
        calendarSourceId: created.calendarSourceId,
        createdAt: created.createdAt.toISOString(),
        participantCount: 0,
      },
      { status: 201 }
    );
  } catch (error) {
    console.error("POST /api/trip-events error:", error);
    return NextResponse.json(
      { error: "출장 이벤트 생성 실패" },
      { status: 500 }
    );
  }
}

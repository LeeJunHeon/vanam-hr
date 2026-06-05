// 그룹 출장(Field Trip) 캘린더 + 근태 헬퍼.
//
// 설계(이벤트 단위 재구성):
//  • 캘린더(Google) — 이벤트 단위 전체 재구성. rebuildTripEventCalendar(eventId).
//    - 확정 참석자(approved OR not_required+accepted)의 미래 날짜만 대상.
//    - "날짜 → 참석자 집합" 시그니처가 같고 연속이면 1건의 일정으로 묶음.
//    - 일정 제목 = 이벤트명, location = 이벤트.location, attendees = 참석자 이메일,
//      description = (사용자 메모) + 시스템 안내문, sendUpdates='none'(메일 미발송).
//    - 과거 날짜(KST 오늘 미만)의 기존 캘린더 일정은 건드리지 않음(보존).
//  • 근태(attendance_request) — 참석자·날짜별 개별 유지.
//    - createTripParticipantAttendanceRequests(participantId)
//    - cleanupTripParticipantAttendanceFuture(participantId)
//    - external_event_id는 캘린더 event_id에 의존하지 않는 결정적 fallback 사용.
//      캘린더가 재구성되어도 근태는 영향 없음.
//
// 외부 호출(syncer)은 트랜잭션 밖. 실패는 로그(전체 흐름 보존).

import { prisma } from "@/lib/prisma";

// ── Field Trip 캘린더 / 카테고리 룩업(짧은 캐시) ──
let _cachedBusinessTripCategoryId: number | null | undefined = undefined;
let _cachedFieldTripCalendarId: string | null | undefined = undefined;

export async function getBusinessTripCategoryId(): Promise<number | null> {
  if (_cachedBusinessTripCategoryId !== undefined) {
    return _cachedBusinessTripCategoryId;
  }
  const row = await prisma.attendanceCategory.findUnique({
    where: { code: "BUSINESS_TRIP" },
    select: { id: true },
  });
  _cachedBusinessTripCategoryId = row?.id ?? null;
  return _cachedBusinessTripCategoryId;
}

export async function getFieldTripCalendarId(): Promise<string | null> {
  if (_cachedFieldTripCalendarId !== undefined) {
    return _cachedFieldTripCalendarId;
  }
  const row = await prisma.policySetting.findUnique({
    where: { key: "field_trip_calendar_id" },
    select: { value: true },
  });
  const v = (row?.value ?? "").trim();
  _cachedFieldTripCalendarId = v.length > 0 ? v : null;
  return _cachedFieldTripCalendarId;
}

// ── 캘린더 syncer HTTP 클라이언트 ────────────────
interface CreateEventArgs {
  calendarId: string;
  summary: string;
  description: string;
  location?: string | null;
  attendees?: string[]; // emails
  start: Record<string, string>;
  end: Record<string, string>;
}

async function callCreateCalendarEvent(args: CreateEventArgs): Promise<string | null> {
  const base = process.env.CALENDAR_SYNCER_URL;
  if (!base) throw new Error("CALENDAR_SYNCER_URL env not set");
  const body: Record<string, unknown> = {
    calendar_id: args.calendarId,
    vanam_source: "hr",
    summary: args.summary,
    description: args.description,
    start: args.start,
    end: args.end,
  };
  if (args.location && args.location.trim().length > 0) {
    body.location = args.location.trim();
  }
  if (args.attendees && args.attendees.length > 0) {
    body.attendees = args.attendees;
  }
  const res = await fetch(`${base}/internal/calendar-event`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Internal-Token": process.env.INTERNAL_API_TOKEN ?? "",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`calendar-syncer POST failed: ${res.status}`);
  }
  const data = await res.json();
  return data.eventId ?? data.event_id ?? data.id ?? null;
}

async function callDeleteCalendarEvent(
  calendarId: string,
  eventId: string
): Promise<void> {
  const base = process.env.CALENDAR_SYNCER_URL;
  if (!base) throw new Error("CALENDAR_SYNCER_URL env not set");
  const res = await fetch(
    `${base}/internal/calendar-event/${encodeURIComponent(eventId)}`,
    {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Token": process.env.INTERNAL_API_TOKEN ?? "",
      },
      body: JSON.stringify({ calendar_id: calendarId }),
    }
  );
  if (!res.ok) {
    throw new Error(`calendar-syncer DELETE failed: ${res.status}`);
  }
}

// ── 유틸 ─────────────────────────────────────────
function ymdKey(d: Date): string {
  return d.toISOString().split("T")[0];
}
function timeKey(t: Date | null): string {
  return t ? t.toISOString().slice(11, 16) : "";
}
function isNextDayUTC(a: Date, b: Date): boolean {
  const next = new Date(a);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() === b.getTime();
}
function ymdAdd1(ymd: string): string {
  const d = new Date(ymd + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().split("T")[0];
}
function combineDateAndTime(attendDate: Date, time: Date): Date {
  // attendDate(UTC midnight = KST 09:00) + 시간(@db.Time이 보존하는 hh:mm, KST 의도)
  // → KST hh:mm → UTC로 변환
  const hh = time.getUTCHours();
  const mm = time.getUTCMinutes();
  const y = attendDate.getUTCFullYear();
  const m = attendDate.getUTCMonth();
  const d = attendDate.getUTCDate();
  return new Date(Date.UTC(y, m, d, hh - 9, mm, 0));
}
function kstTodayMidnightUtc(): Date {
  const nowMs = Date.now();
  const kstNow = new Date(nowMs + 9 * 60 * 60 * 1000);
  return new Date(
    Date.UTC(
      kstNow.getUTCFullYear(),
      kstNow.getUTCMonth(),
      kstNow.getUTCDate(),
      0, 0, 0, 0
    )
  );
}

// 종일 vs 시간지정 start/end 빌더
function buildStartEnd(
  startDate: Date,
  endDate: Date,
  startTime: Date | null,
  endTime: Date | null
): { start: Record<string, string>; end: Record<string, string> } {
  if (startTime && endTime) {
    const startDt = combineDateAndTime(startDate, startTime);
    const endDt = combineDateAndTime(endDate, endTime);
    return {
      start: { dateTime: startDt.toISOString(), timeZone: "Asia/Seoul" },
      end: { dateTime: endDt.toISOString(), timeZone: "Asia/Seoul" },
    };
  }
  const startYmd = ymdKey(startDate);
  const next = new Date(endDate);
  next.setUTCDate(next.getUTCDate() + 1);
  return {
    start: { date: startYmd },
    end: { date: ymdKey(next) },
  };
}

// ─────────────────────────────────────────────────
// 근태(attendance_request) 헬퍼 — 참석자·날짜별 개별
// ─────────────────────────────────────────────────

// 정렬된 dates를 연속(+ 동일 시간) 그룹으로 묶음(근태 1건 = 1그룹).
interface AttendanceGroup {
  startDate: Date;
  endDate: Date;
  startTime: Date | null;
  endTime: Date | null;
  dateIds: number[];
  ymdList: string[];
}
function groupConsecutiveForAttendance(
  rows: Array<{ id: number; attendDate: Date; startTime: Date | null; endTime: Date | null }>
): AttendanceGroup[] {
  const sorted = [...rows].sort(
    (a, b) => a.attendDate.getTime() - b.attendDate.getTime()
  );
  const groups: AttendanceGroup[] = [];
  let cur: AttendanceGroup | null = null;
  for (const r of sorted) {
    const sameTime =
      cur !== null &&
      timeKey(cur.startTime) === timeKey(r.startTime) &&
      timeKey(cur.endTime) === timeKey(r.endTime);
    const consecutive = cur !== null && isNextDayUTC(cur.endDate, r.attendDate);
    if (cur && sameTime && consecutive) {
      cur.endDate = r.attendDate;
      cur.dateIds.push(r.id);
      cur.ymdList.push(ymdKey(r.attendDate));
    } else {
      cur = {
        startDate: r.attendDate,
        endDate: r.attendDate,
        startTime: r.startTime,
        endTime: r.endTime,
        dateIds: [r.id],
        ymdList: [ymdKey(r.attendDate)],
      };
      groups.push(cur);
    }
  }
  return groups;
}

// 확정(approved or not_required+accepted) 참석자에 한해 attendance_request 생성.
// 멱등(이미 attendance_request_id가 채워진 그룹은 skip).
// 캘린더와 무관 — external_event_id는 결정적 fallback(`trip-{ev}-{p}-{startYmd}`) 사용.
export async function createTripParticipantAttendanceRequests(
  participantId: number
): Promise<void> {
  const participant = await prisma.tripParticipant.findUnique({
    where: { id: participantId },
    include: {
      tripEvent: {
        select: { id: true, name: true, status: true },
      },
      dates: {
        orderBy: [{ attendDate: "asc" }],
        select: {
          id: true,
          attendDate: true,
          startTime: true,
          endTime: true,
          attendanceRequestId: true,
        },
      },
    },
  });
  if (!participant) return;
  const okApproved = participant.approvalStatus === "approved";
  const okNotRequired =
    participant.approvalStatus === "not_required" &&
    participant.inviteStatus === "accepted";
  if (!okApproved && !okNotRequired) return;
  if (participant.tripEvent.status !== "active") return;
  if (participant.dates.length === 0) return;

  const categoryId = await getBusinessTripCategoryId();
  if (categoryId == null) {
    console.warn("[trip-calendar] BUSINESS_TRIP 카테고리 미존재 — 근태 생성 skip");
    return;
  }

  const ev = participant.tripEvent;
  const groups = groupConsecutiveForAttendance(participant.dates);

  for (const group of groups) {
    // 멱등: 그룹 내 어느 날짜라도 이미 attendance_request_id가 있으면 skip
    const alreadyHas = participant.dates
      .filter((d) => group.dateIds.includes(d.id))
      .some((d) => d.attendanceRequestId !== null);
    if (alreadyHas) continue;

    const externalEventId = `trip-${ev.id}-${participant.id}-${ymdKey(group.startDate)}`;
    const correctedCheckIn =
      group.startTime ? combineDateAndTime(group.startDate, group.startTime) : null;
    const correctedCheckOut =
      group.endTime ? combineDateAndTime(group.endDate, group.endTime) : null;

    let attendanceRequestId: number | null = null;
    try {
      const existing = await prisma.attendanceRequest.findFirst({
        where: {
          externalSource: "trip",
          externalEventId,
          employeeId: participant.employeeId,
        },
        select: { id: true },
      });
      if (existing) {
        attendanceRequestId = existing.id;
      } else {
        const created = await prisma.attendanceRequest.create({
          data: {
            employeeId: participant.employeeId,
            categoryId,
            requestType: "calendar_auto",
            startDate: group.startDate,
            endDate: group.endDate,
            reason: `[출장] ${ev.name}`,
            correctedCheckIn,
            correctedCheckOut,
            externalSource: "trip",
            externalEventId,
            status: "auto_approved",
            approvedAt: new Date(),
          },
        });
        attendanceRequestId = created.id;
      }
    } catch (e) {
      console.error(
        `[trip-calendar] attendance_request 생성 실패 (participant=${participantId}, ` +
          `group=${group.ymdList.join(",")}):`,
        e
      );
    }

    if (attendanceRequestId !== null) {
      try {
        await prisma.tripParticipantDate.updateMany({
          where: { id: { in: group.dateIds } },
          data: { attendanceRequestId },
        });
      } catch (e) {
        console.error(
          `[trip-calendar] attendance_request_id 저장 실패 (ids=${group.dateIds.join(",")}):`,
          e
        );
      }
    }
  }
}

// 참석자의 미래 attendance_request만 정리(과거 보존). dates의 attendance_request_id NULL.
export async function cleanupTripParticipantAttendanceFuture(
  participantId: number
): Promise<void> {
  const dates = await prisma.tripParticipantDate.findMany({
    where: { tripParticipantId: participantId },
    select: { id: true, attendDate: true, attendanceRequestId: true },
  });
  if (dates.length === 0) return;
  const todayKst = kstTodayMidnightUtc();
  const future = dates.filter(
    (d) => d.attendDate.getTime() >= todayKst.getTime()
  );
  if (future.length === 0) return;

  const requestIds = [
    ...new Set(
      future.map((d) => d.attendanceRequestId).filter((v): v is number => v != null)
    ),
  ];
  if (requestIds.length > 0) {
    try {
      await prisma.attendanceRequest.deleteMany({
        where: { id: { in: requestIds }, externalSource: "trip" },
      });
    } catch (e) {
      console.error(
        `[trip-calendar] attendance_request 삭제 실패 (ids=${requestIds.join(",")}):`,
        e
      );
    }
  }

  try {
    await prisma.tripParticipantDate.updateMany({
      where: { id: { in: future.map((d) => d.id) } },
      data: { attendanceRequestId: null },
    });
  } catch (e) {
    console.error(`[trip-calendar] dates attendance_request_id 초기화 실패:`, e);
  }
}

// ─────────────────────────────────────────────────
// 캘린더(Google) 이벤트 단위 재구성
// ─────────────────────────────────────────────────

const CALENDAR_NOTICE =
  "본 일정은 VanaM HR 근태 시스템에서 자동 생성·관리됩니다. 직접 수정하지 마세요.";

function buildEventDescription(eventMemo: string | null): string {
  const memo = (eventMemo ?? "").trim();
  if (memo.length === 0) return CALENDAR_NOTICE;
  return `${memo}\n\n${CALENDAR_NOTICE}`;
}

/**
 * 이벤트의 캘린더 일정을 처음부터 다시 만든다.
 *  1) 미래(KST 오늘 이상) 날짜에 연결된 기존 calendar_event_id를 모두 삭제(syncer DELETE).
 *     계산 후 trip_participant_dates의 calendar_event_id를 NULL로.
 *  2) event.status가 'active'가 아니면 여기서 종료(취소된 이벤트는 정리만).
 *  3) 확정 참석자(approved | not_required+accepted)의 미래 날짜를 모아
 *     "날짜 → 참석자 집합" 시그니처가 같고 연속이면 1건으로 묶어 캘린더 일정 생성.
 *  4) 새로 생성된 event_id를 그 그룹의 모든 참석자 × 모든 날짜 행에 저장.
 *
 * 과거 날짜의 캘린더 일정은 어떤 단계에서도 건드리지 않음(보존).
 * 외부 호출 실패는 로그만, 전체 작업은 계속 진행.
 */
export async function rebuildTripEventCalendar(tripEventId: number): Promise<void> {
  const event = await prisma.tripEvent.findUnique({
    where: { id: tripEventId },
    select: {
      id: true,
      name: true,
      location: true,
      description: true,
      status: true,
    },
  });
  if (!event) return;

  const fieldTripCalendarId = await getFieldTripCalendarId();
  if (!fieldTripCalendarId) {
    // 캘린더 미설정: 근태는 별도 흐름에서 처리되므로 여기선 그냥 종료
    console.warn(
      "[trip-calendar] field_trip_calendar_id 미설정 — 캘린더 재구성 skip"
    );
    return;
  }

  const todayKst = kstTodayMidnightUtc();

  // 1) 이 이벤트의 모든 미래 dates 중 calendar_event_id가 있는 것 수집 → 삭제
  const futureLinked = await prisma.tripParticipantDate.findMany({
    where: {
      tripParticipant: { tripEventId },
      attendDate: { gte: todayKst },
      calendarEventId: { not: null },
    },
    select: { id: true, calendarEventId: true },
  });
  const existingEventIds = [
    ...new Set(
      futureLinked.map((d) => d.calendarEventId).filter((v): v is string => !!v)
    ),
  ];
  for (const eid of existingEventIds) {
    try {
      await callDeleteCalendarEvent(fieldTripCalendarId, eid);
    } catch (e) {
      console.error(`[trip-calendar] rebuild delete 실패 (eventId=${eid}):`, e);
    }
  }
  if (futureLinked.length > 0) {
    try {
      await prisma.tripParticipantDate.updateMany({
        where: { id: { in: futureLinked.map((d) => d.id) } },
        data: { calendarEventId: null },
      });
    } catch (e) {
      console.error(`[trip-calendar] rebuild dates calendar_event_id 초기화 실패:`, e);
    }
  }

  // 2) 비활성 이벤트면 cleanup only
  if (event.status !== "active") return;

  // 3) 확정 참석자 + 미래 dates + 직원 이메일 로드
  const participants = await prisma.tripParticipant.findMany({
    where: {
      tripEventId,
      OR: [
        { approvalStatus: "approved" },
        {
          AND: [
            { approvalStatus: "not_required" },
            { inviteStatus: "accepted" },
          ],
        },
      ],
    },
    include: {
      employee: {
        select: { id: true, name: true, email: true },
      },
      dates: {
        where: { attendDate: { gte: todayKst } },
        select: {
          id: true,
          attendDate: true,
          startTime: true,
          endTime: true,
        },
      },
    },
  });
  if (participants.length === 0) return;

  // 날짜 → 그 날짜 참석자 슬롯 목록
  interface Slot {
    participantId: number;
    employeeId: number;
    employeeName: string;
    employeeEmail: string | null;
    dateId: number;
    startTime: Date | null;
    endTime: Date | null;
  }
  const byDate = new Map<string, Slot[]>();
  for (const p of participants) {
    for (const d of p.dates) {
      const ymd = ymdKey(d.attendDate);
      const list = byDate.get(ymd) ?? [];
      list.push({
        participantId: p.id,
        employeeId: p.employee.id,
        employeeName: p.employee.name,
        employeeEmail: p.employee.email ?? null,
        dateId: d.id,
        startTime: d.startTime,
        endTime: d.endTime,
      });
      byDate.set(ymd, list);
    }
  }
  if (byDate.size === 0) return;

  // 4) 시그니처(참석자 집합 + 공통 시간) 계산 + 연속 동일 시그니처 그룹화
  interface Group {
    signatureKey: string;
    startYmd: string;
    endYmd: string;
    participantIds: number[]; // 정렬됨
    startTime: Date | null;
    endTime: Date | null;
    // 그 그룹에 속한 (참석자별) trip_participant_date.id 들
    dateIds: number[];
    attendees: string[]; // unique emails
  }

  function signatureOf(slots: Slot[]): {
    key: string;
    participantIds: number[];
    startTime: Date | null;
    endTime: Date | null;
    attendees: string[];
  } {
    const pids = slots.map((s) => s.participantId).sort((a, b) => a - b);
    // 같은 날 모든 참석자의 시간이 동일하면 그 시간 사용, 다르면 종일로 폴백
    const firstS = timeKey(slots[0].startTime);
    const firstE = timeKey(slots[0].endTime);
    let mixed = false;
    for (const s of slots) {
      if (timeKey(s.startTime) !== firstS || timeKey(s.endTime) !== firstE) {
        mixed = true;
        break;
      }
    }
    const startTime = mixed ? null : slots[0].startTime;
    const endTime = mixed ? null : slots[0].endTime;
    const timeSig = mixed ? "all-day-mixed" : `${firstS}-${firstE}`;
    // 이메일 unique(소문자 비교)
    const emailSet = new Map<string, string>();
    for (const s of slots) {
      const e = (s.employeeEmail ?? "").trim();
      if (e.length === 0) continue;
      const k = e.toLowerCase();
      if (!emailSet.has(k)) emailSet.set(k, e);
    }
    return {
      key: pids.join(",") + "|" + timeSig,
      participantIds: pids,
      startTime,
      endTime,
      attendees: [...emailSet.values()],
    };
  }

  const sortedYmds = [...byDate.keys()].sort();
  const groups: Group[] = [];
  let current: Group | null = null;
  for (const ymd of sortedYmds) {
    const slots = byDate.get(ymd)!;
    const sig = signatureOf(slots);
    if (
      current &&
      current.signatureKey === sig.key &&
      ymdAdd1(current.endYmd) === ymd
    ) {
      current.endYmd = ymd;
      for (const s of slots) current.dateIds.push(s.dateId);
    } else {
      current = {
        signatureKey: sig.key,
        startYmd: ymd,
        endYmd: ymd,
        participantIds: sig.participantIds,
        startTime: sig.startTime,
        endTime: sig.endTime,
        dateIds: slots.map((s) => s.dateId),
        attendees: sig.attendees,
      };
      groups.push(current);
    }
  }

  // 5) 그룹별 캘린더 일정 생성 + dates에 event_id 저장
  const description = buildEventDescription(event.description);
  for (const g of groups) {
    const startDate = new Date(g.startYmd + "T00:00:00.000Z");
    const endDate = new Date(g.endYmd + "T00:00:00.000Z");
    const { start, end } = buildStartEnd(startDate, endDate, g.startTime, g.endTime);

    let eventId: string | null = null;
    try {
      eventId = await callCreateCalendarEvent({
        calendarId: fieldTripCalendarId,
        summary: event.name,
        description,
        location: event.location,
        attendees: g.attendees,
        start,
        end,
      });
    } catch (e) {
      console.error(
        `[trip-calendar] rebuild create 실패 (event=${tripEventId}, ` +
          `range=${g.startYmd}~${g.endYmd}, parts=${g.participantIds.join(",")}):`,
        e
      );
    }

    if (eventId) {
      try {
        await prisma.tripParticipantDate.updateMany({
          where: { id: { in: g.dateIds } },
          data: { calendarEventId: eventId },
        });
      } catch (e) {
        console.error(`[trip-calendar] rebuild save event_id 실패:`, e);
      }
    }
  }
}

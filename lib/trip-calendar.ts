// 그룹 출장(Field Trip) Phase 7 4단계: 캘린더 + 근태 반영 / 정리 헬퍼.
//
// 호출 패턴:
//   - 승인 직후       → registerTripParticipantApproval(participantId)
//   - 날짜 변경(재승인) → cleanupTripParticipantFutureDates(participantId)
//   - 참석 취소        → cleanupTripParticipantFutureDates(participantId)  (이후 delete)
//   - 이벤트 취소      → cleanupTripEventFutureDates(eventId)
//
// 외부 호출(syncer)은 트랜잭션 밖에서. 실패해도 결재 자체는 유지(로그만).
// 멱등성: 이미 calendar_event_id/attendance_request_id가 채워진 날짜는 중복 생성 X.
// 과거 날짜 보호: cleanup에서는 KST 오늘 이전 날짜는 건드리지 않음.

import { prisma } from "@/lib/prisma";

// ── Field Trip 캘린더 / 카테고리 룩업 ────────────
// 1회 lookup하면 짧은 시간 캐시. 자주 호출되는 path에서 매번 DB hit 피함.
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

// policy_settings에서 field_trip_calendar_id 조회. 없으면 null(캘린더 등록 skip).
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
  start: Record<string, string>;
  end: Record<string, string>;
}

async function callCreateCalendarEvent(args: CreateEventArgs): Promise<string | null> {
  const base = process.env.CALENDAR_SYNCER_URL;
  if (!base) throw new Error("CALENDAR_SYNCER_URL env not set");
  const res = await fetch(`${base}/internal/calendar-event`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Internal-Token": process.env.INTERNAL_API_TOKEN ?? "",
    },
    body: JSON.stringify({
      calendar_id: args.calendarId,
      vanam_source: "hr",
      summary: args.summary,
      description: args.description,
      start: args.start,
      end: args.end,
    }),
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
  // syncer는 404도 200 + {note:'already_deleted'}로 멱등 처리. 비2xx는 throw.
  if (!res.ok) {
    throw new Error(`calendar-syncer DELETE failed: ${res.status}`);
  }
}

// ── 날짜 연속구간 그룹핑 ─────────────────────────
// 정렬된 dates를 받아 (attendDate가 연속) AND (startTime/endTime 동일) 인
// 최대 구간으로 묶는다. 시간이 모두 NULL이면 종일 그룹, 같은 HH:MM 쌍이면 시간 그룹.
//
// 출력 그룹의 각 항목은 그 그룹에 속한 trip_participant_date.id 배열을 함께 갖는다
// (DB 업데이트 대상 식별용).
export interface DateGroup {
  startDate: Date;            // 그룹 시작 일자
  endDate: Date;              // 그룹 종료 일자 (inclusive)
  startTime: Date | null;     // null이면 종일
  endTime: Date | null;
  dateIds: number[];          // 그룹에 속한 trip_participant_dates.id 들
  ymdList: string[];          // 디버그/멱등 비교용 YYYY-MM-DD 리스트
}

interface SortableDate {
  id: number;
  attendDate: Date;
  startTime: Date | null;
  endTime: Date | null;
}

function ymdKey(d: Date): string {
  return d.toISOString().split("T")[0];
}

function timeKey(t: Date | null): string {
  return t ? t.toISOString().slice(11, 16) : "";
}

function isNextDayUTC(a: Date, b: Date): boolean {
  // a + 1day === b (date-only 비교)
  const next = new Date(a);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() === b.getTime();
}

export function groupConsecutiveDates(rows: SortableDate[]): DateGroup[] {
  const sorted = [...rows].sort(
    (a, b) => a.attendDate.getTime() - b.attendDate.getTime()
  );
  const groups: DateGroup[] = [];
  let current: DateGroup | null = null;
  for (const r of sorted) {
    const sameTime =
      current !== null &&
      timeKey(current.startTime) === timeKey(r.startTime) &&
      timeKey(current.endTime) === timeKey(r.endTime);
    const consecutive =
      current !== null && isNextDayUTC(current.endDate, r.attendDate);
    if (current && sameTime && consecutive) {
      current.endDate = r.attendDate;
      current.dateIds.push(r.id);
      current.ymdList.push(ymdKey(r.attendDate));
    } else {
      current = {
        startDate: r.attendDate,
        endDate: r.attendDate,
        startTime: r.startTime,
        endTime: r.endTime,
        dateIds: [r.id],
        ymdList: [ymdKey(r.attendDate)],
      };
      groups.push(current);
    }
  }
  return groups;
}

// ── 시간 합성 ───────────────────────────────────
// attend_date(0:00 UTC)와 HH:MM Time(@db.Time, 1970-01-01 UTC + hh:mm)을
// KST timestamptz로 합성. 한국 = UTC+9 고정(DST 없음). attendance_request의
// corrected_check_in/corrected_check_out 컬럼 형식과 맞춤.
function combineDateAndTime(attendDate: Date, time: Date): Date {
  const hh = time.getUTCHours();
  const mm = time.getUTCMinutes();
  // attendDate의 YMD + KST(hh:mm) → UTC로 변환 = KST(hh:mm) - 9h
  const y = attendDate.getUTCFullYear();
  const m = attendDate.getUTCMonth();
  const d = attendDate.getUTCDate();
  // KST hh:mm → UTC (hh-9):mm. JavaScript Date.UTC 계산.
  return new Date(Date.UTC(y, m, d, hh - 9, mm, 0));
}

// ── KST 오늘(0시) ────────────────────────────────
function kstTodayMidnightUtc(): Date {
  // 현재 시각을 KST 자정으로 truncate → UTC 표현.
  // KST 자정 = UTC 전날 15:00. 단순화를 위해 KST 오늘의 0시(UTC 기준 동치)를
  // attend_date(@db.Date)와 비교 가능한 UTC midnight 형태로 만든다.
  const nowMs = Date.now();
  const kstNow = new Date(nowMs + 9 * 60 * 60 * 1000);
  return new Date(
    Date.UTC(
      kstNow.getUTCFullYear(),
      kstNow.getUTCMonth(),
      kstNow.getUTCDate(),
      0,
      0,
      0,
      0
    )
  );
}

// ── 그룹 → 캘린더 start/end 객체 ────────────────
function buildStartEnd(group: DateGroup): {
  start: Record<string, string>;
  end: Record<string, string>;
} {
  if (group.startTime && group.endTime) {
    // 시간 지정: 그룹 첫날 startTime ~ 그룹 마지막날 endTime
    const startDt = combineDateAndTime(group.startDate, group.startTime);
    const endDt = combineDateAndTime(group.endDate, group.endTime);
    return {
      start: { dateTime: startDt.toISOString(), timeZone: "Asia/Seoul" },
      end: { dateTime: endDt.toISOString(), timeZone: "Asia/Seoul" },
    };
  }
  // 종일: end.date는 exclusive(다음날)
  const startYmd = ymdKey(group.startDate);
  const next = new Date(group.endDate);
  next.setUTCDate(next.getUTCDate() + 1);
  const endYmd = ymdKey(next);
  return {
    start: { date: startYmd },
    end: { date: endYmd },
  };
}

// ── 메인: 승인된 참석자 1명에 대해 캘린더+근태 생성 ──
// 멱등: 그룹 내 어느 날짜라도 calendar_event_id/attendance_request_id가 채워져
//       있으면 그 그룹은 건너뜀(부분 일치도 안전한 쪽으로 skip).
// 실패: 외부 호출/DB 일부 실패해도 다른 그룹은 계속 처리. 호출자(결재 라우트)는
//       전체 실패를 try/catch로 흡수해 결재 자체는 유지.
export async function registerTripParticipantApproval(
  participantId: number
): Promise<void> {
  const participant = await prisma.tripParticipant.findUnique({
    where: { id: participantId },
    include: {
      employee: { select: { id: true, name: true, employeeNo: true } },
      tripEvent: {
        select: { id: true, name: true, location: true, status: true },
      },
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
  });
  if (!participant) return;
  // 캘린더·근태를 만들어야 하는 두 경우:
  //   (a) 결재 승인됨 (approved) — handleTripApproval 흐름
  //   (b) 결재 불요 + 수락 완료 (not_required + accepted)
  //       admin/ceo가 개입한 참석은 결재를 거치지 않으므로 수락 시점에 트리거.
  // invited 상태(미수락)에서는 갈지 안 갈지 미확정이라 생성하지 않는다.
  const okApproved = participant.approvalStatus === "approved";
  const okNotRequired =
    participant.approvalStatus === "not_required" &&
    participant.inviteStatus === "accepted";
  if (!okApproved && !okNotRequired) return;
  if (participant.tripEvent.status !== "active") return;
  if (participant.dates.length === 0) return;

  const categoryId = await getBusinessTripCategoryId();
  if (categoryId == null) {
    console.warn(
      "[trip-calendar] BUSINESS_TRIP 카테고리 미존재 — 근태 반영 skip"
    );
    return;
  }

  const fieldTripCalendarId = await getFieldTripCalendarId();
  const groups = groupConsecutiveDates(participant.dates);

  for (const group of groups) {
    // 멱등: 그룹 내 어느 날짜라도 이미 등록 정보가 있으면 skip
    const alreadyHas = participant.dates
      .filter((d) => group.dateIds.includes(d.id))
      .some((d) => d.calendarEventId !== null || d.attendanceRequestId !== null);
    if (alreadyHas) continue;

    const ev = participant.tripEvent;
    const empName = participant.employee.name;
    const summary = `[출장] ${ev.name} - ${empName}`;
    const descParts: string[] = [];
    if (ev.location) descParts.push(`장소: ${ev.location}`);
    descParts.push(`이벤트: ${ev.name}`);
    descParts.push(`참가자: ${empName}`);
    const description = descParts.join("\n");

    // ── (a) 캘린더 등록 (calendar_id 설정된 경우만) ──
    let calendarEventId: string | null = null;
    if (fieldTripCalendarId) {
      try {
        const { start, end } = buildStartEnd(group);
        calendarEventId = await callCreateCalendarEvent({
          calendarId: fieldTripCalendarId,
          summary,
          description,
          start,
          end,
        });
      } catch (e) {
        console.error(
          `[trip-calendar] 캘린더 등록 실패 (participant=${participantId}, ` +
            `group=${group.ymdList.join(",")}):`,
          e
        );
        // 캘린더 실패 시에도 attendance_request는 시도 (근태 반영은 별개).
      }
    }

    // ── (b) attendance_request 생성 ──
    // UNIQUE(external_source, external_event_id, employee_id) 사용:
    // external_event_id는 캘린더 등록 성공 시 그 값, 아니면 결정적 fallback.
    const externalEventId =
      calendarEventId ??
      `trip-${ev.id}-${participant.id}-${ymdKey(group.startDate)}`;

    const startDateUtc = group.startDate;
    const endDateUtc = group.endDate;
    const correctedCheckIn =
      group.startTime ? combineDateAndTime(group.startDate, group.startTime) : null;
    const correctedCheckOut =
      group.endTime ? combineDateAndTime(group.endDate, group.endTime) : null;

    // 멱등성은 위의 trip_participant_dates.alreadyHas 체크로 보장됨.
    // 단순 create + 충돌 시 로그(스키마 측 unique가 prisma와 다를 수 있어 upsert 회피).
    let attendanceRequestId: number | null = null;
    try {
      // 사전 안전망: 같은 (source, event_id, employee_id) 조합이 이미 있으면 재사용.
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
            startDate: startDateUtc,
            endDate: endDateUtc,
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

    // ── (c) trip_participant_dates에 ID 저장 ──
    if (calendarEventId || attendanceRequestId) {
      try {
        await prisma.tripParticipantDate.updateMany({
          where: { id: { in: group.dateIds } },
          data: {
            ...(calendarEventId ? { calendarEventId } : {}),
            ...(attendanceRequestId ? { attendanceRequestId } : {}),
          },
        });
      } catch (e) {
        console.error(
          `[trip-calendar] dates 링크 저장 실패 (ids=${group.dateIds.join(",")}):`,
          e
        );
      }
    }
  }
}

// ── 정리: 참석자의 "미래" 날짜(KST 오늘 이상) 캘린더+근태 제거 ──
// update_dates에서 approved→pending 되돌림, DELETE 참석자, 이벤트 취소 공통.
// 과거 날짜는 보존(이미 지난 일정은 캘린더/근태에서 지우지 않음).
export async function cleanupTripParticipantFutureDates(
  participantId: number
): Promise<void> {
  const dates = await prisma.tripParticipantDate.findMany({
    where: { tripParticipantId: participantId },
    select: {
      id: true,
      attendDate: true,
      calendarEventId: true,
      attendanceRequestId: true,
    },
  });
  if (dates.length === 0) return;

  const todayKst = kstTodayMidnightUtc();
  const future = dates.filter(
    (d) => d.attendDate.getTime() >= todayKst.getTime()
  );
  if (future.length === 0) return;

  // 캘린더 event_id 중복 제거(같은 event_id가 여러 날짜에 매핑된 경우 1번만 DELETE).
  const fieldTripCalendarId = await getFieldTripCalendarId();
  const eventIds = [
    ...new Set(future.map((d) => d.calendarEventId).filter((v): v is string => !!v)),
  ];
  if (fieldTripCalendarId) {
    for (const eid of eventIds) {
      try {
        await callDeleteCalendarEvent(fieldTripCalendarId, eid);
      } catch (e) {
        console.error(
          `[trip-calendar] 캘린더 삭제 실패 (eventId=${eid}):`,
          e
        );
        // 실패해도 계속 — 멱등은 syncer가 처리.
      }
    }
  }

  // attendance_request 삭제 (중복 제거)
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

  // trip_participant_dates의 링크 필드 비우기 (미래 날짜만)
  try {
    await prisma.tripParticipantDate.updateMany({
      where: { id: { in: future.map((d) => d.id) } },
      data: { calendarEventId: null, attendanceRequestId: null },
    });
  } catch (e) {
    console.error(`[trip-calendar] dates 링크 초기화 실패:`, e);
  }
}

// ── 정리: 이벤트 전체(모든 참석자)의 미래 날짜 정리 ──
export async function cleanupTripEventFutureDates(
  tripEventId: number
): Promise<void> {
  const participants = await prisma.tripParticipant.findMany({
    where: { tripEventId },
    select: { id: true },
  });
  for (const p of participants) {
    await cleanupTripParticipantFutureDates(p.id);
  }
}

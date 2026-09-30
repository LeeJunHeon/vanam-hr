// 그룹 출장(Field Trip) 캘린더 + 근태 헬퍼.
//
// 설계(이벤트 단위 재구성):
//  원칙: 지난 날짜(KST 오늘 미만)에 이미 기록된 근태는 바꾸지 않는다. 오늘 이후만 참석 날짜와 똑같이.
//        근태와 캘린더는 같은 기준 — 지난 날 = 근태에 기록된 날짜, 오늘 이후 = 확정 참석자의 날짜.
//
//  • 캘린더(Google) — 이벤트 단위 전체 재구성. rebuildTripEventCalendar(eventId).
//    - 다시 그릴 때 그 출장의 일정을 모두 지우고(지난 날 포함),
//      지난 날(근태에 기록된 날짜) + 오늘 이후(확정 참석자 날짜)로 다시 묶어 그린다.
//    - "날짜 → 참석자 집합" 시그니처가 같고 연속이면 1건의 일정으로 묶음.
//    - 일정 제목 = 이벤트명, location = 이벤트.location, attendees = 참석자 이메일,
//      description = (사용자 메모) + 시스템 안내문, sendUpdates='none'(메일 미발송).
//  • 근태(attendance_request) — syncTripParticipantAttendance(participantId).
//    - 참석자·연속 날짜 묶음별 1건. external_event_id = trip-{출장}-{참석자}-{묶음 시작일}
//      (캘린더 event_id 에 의존하지 않음 — 캘린더가 재구성되어도 근태는 영향 없음).
//  • 날짜 행 교체 — replaceParticipantDates(tx, participantId, dates, mode).
//
// 외부 호출(syncer)은 트랜잭션 밖. 실패는 로그(전체 흐름 보존).

import type { Prisma } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { isConfirmedParticipant } from "@/lib/trip-helpers";
import { markAttendanceRecalc } from "@/lib/attendance-recalc";
import { kstTodayMidnightUtc } from "@/lib/kst-date";

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

// 이벤트의 calendar_source_id로 캘린더 정보 조회.
// 반환: { calendarId, categoryId } — calendar_sources에서.
// source_id가 null이거나 조회 실패면 null 반환(호출자가 폴백 처리).
async function getCalendarSourceInfo(
  calendarSourceId: number | null
): Promise<{ calendarId: string; categoryId: number } | null> {
  if (calendarSourceId == null) return null;
  const row = await prisma.calendarSource.findUnique({
    where: { id: calendarSourceId },
    select: { calendarId: true, defaultCategoryId: true },
  });
  if (!row) return null;
  const calId = (row.calendarId ?? "").trim();
  if (calId.length === 0) return null;
  return { calendarId: calId, categoryId: row.defaultCategoryId };
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
// KST 오늘 00:00 (UTC 자정 Date). 정의는 lib/kst-date.ts — 기존 import 경로 유지용 re-export.
export { kstTodayMidnightUtc };

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

// 출장 근태로 "살아있는" 상태 — 이 기간이 덮는 날짜가 "기록된 날짜"다.
const LIVE_TRIP_REQUEST_STATUSES = ["approved", "auto_approved", "auto_delegated"];

// 참석자의 출장 근태 키 접두어: trip-{출장id}-{참석자id}-{묶음 시작일}
function tripRequestKeyPrefix(tripEventId: number, participantId: number): string {
  return `trip-${tripEventId}-${participantId}-`;
}

const DAY_MS = 24 * 60 * 60 * 1000;
function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * DAY_MS);
}
// timestamptz → KST "HH:MM" (없으면 "")
function kstHm(t: Date | null): string {
  return t ? new Date(t.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(11, 16) : "";
}

type Db = Prisma.TransactionClient | typeof prisma;

export interface TripAttendanceSyncResult {
  relinked: number; // 기록된 지난 날짜 행의 연결 복구
  extended: number; // ① 앞 신청의 끝을 늘림
  trimmed: number; // 오늘에 걸친 신청의 끝을 어제로 줄임
  fitted: number; // ② 같은 키 신청을 묶음에 맞춤
  created: number; // ③ 새로 만듦
  deleted: number; // 쓰이지 않은 오늘 이후 신청 삭제
  recalcDates: string[]; // 재계산 표시한 지난 날짜
}

/**
 * 참석자의 출장 근태(attendance_request)를 참석 날짜에 맞춘다 — 멱등, 한 트랜잭션, 외부 호출 없음.
 *
 * 원칙: 지난 날짜(KST 오늘 미만)에 이미 기록된 근태는 바꾸지 않는다. 오늘 이후만 참석 날짜와 똑같이.
 *  1) 오늘 이후 날짜 행의 연결(attendance_request_id)은 먼저 모두 끊는다(FK NoAction → 삭제 전에).
 *  2) 살아있는 출장 근태: 시작 ≥ 오늘 → 재사용 후보 / 시작 < 오늘 ≤ 끝 → 끝을 어제로 / 끝 < 오늘 → 그대로.
 *  3) 확정 참석자(수락 + 승인·결재 불필요 + 출장 active)이고 removing 이 아니면:
 *     a) 기록된 지난 날짜 행 → 그 날을 덮는 신청(id 가장 작은 것)으로 연결만 맞춤.
 *     b) 기록 안 된 지난 날짜 행(늦은 확정 등) → 묶음마다 배정 + 재계산 표시(needs_recalc).
 *     c) 오늘 이후 날짜 행 → 묶음마다 배정.
 *     [묶음 배정] ① 끝 = 묶음 시작 전날이고 같은 시각인 신청(지난 신청 또는 이번에 배정된 신청)을 늘림
 *                 ② 아니면 키 trip-{출장}-{참석자}-{묶음 시작일} 신청(재사용 후보·취소된 것 포함)을 묶음에 맞춤
 *                 ③ 아니면 새로 만듦
 *  4) 쓰이지 않은 재사용 후보는 삭제.
 *  확정이 아니거나 removing 이면 3) 을 건너뛰므로 오늘 이후 근태만 사라지고 지난 날 근태는 남는다.
 *
 * "기록된 날짜"는 연결 컬럼이 아니라 살아있는 출장 근태의 기간(start~end)으로 판정한다
 * (예전 버그로 연결만 끊긴 행이 있다). 최종 상태를 먼저 계산하고 달라진 것만 쓰므로
 * 연달아 불러도 두 번째는 쓰기가 없다.
 */
export async function syncTripParticipantAttendance(
  participantId: number,
  opts: { removing?: boolean } = {}
): Promise<TripAttendanceSyncResult> {
  const result: TripAttendanceSyncResult = {
    relinked: 0, extended: 0, trimmed: 0, fitted: 0, created: 0, deleted: 0, recalcDates: [],
  };

  const head = await prisma.tripParticipant.findUnique({
    where: { id: participantId },
    select: { tripEvent: { select: { calendarSourceId: true } } },
  });
  if (!head) return result;
  // 카테고리: 출장 calendar source 의 기본 카테고리, 없으면 BUSINESS_TRIP (트랜잭션 밖 조회)
  const srcInfo = await getCalendarSourceInfo(head.tripEvent.calendarSourceId);
  const categoryId = srcInfo?.categoryId ?? (await getBusinessTripCategoryId());

  return prisma.$transaction(async (tx) => {
    const participant = await tx.tripParticipant.findUnique({
      where: { id: participantId },
      include: {
        tripEvent: { select: { id: true, name: true, status: true } },
        dates: {
          orderBy: [{ attendDate: "asc" }],
          select: { id: true, attendDate: true, startTime: true, endTime: true, attendanceRequestId: true },
        },
      },
    });
    if (!participant) return result;
    const ev = participant.tripEvent;
    const today = kstTodayMidnightUtc();
    const yesterday = addDays(today, -1);
    const confirmed = isConfirmedParticipant(participant) && ev.status === "active";

    // ── 이 참석자의 출장 근태(모든 상태) ──
    type Req = {
      id: number | null; // null = 새로 만들 것
      key: string;
      live: boolean;
      candidate: boolean; // 재사용 후보(시작 ≥ 오늘)
      used: boolean; // 이번 실행에서 묶음에 배정됨
      fittedBy2: boolean;
      startDate: Date;
      endDate: Date;
      correctedCheckIn: Date | null;
      correctedCheckOut: Date | null;
      categoryId: number;
      reason: string | null;
      status: string;
      orig: string; // 변경 비교용
    };
    const snap = (r: Req) =>
      JSON.stringify([
        r.startDate.getTime(), r.endDate.getTime(),
        r.correctedCheckIn?.getTime() ?? null, r.correctedCheckOut?.getTime() ?? null,
        r.categoryId, r.reason, r.status,
      ]);
    const rows = await tx.attendanceRequest.findMany({
      where: {
        employeeId: participant.employeeId,
        externalSource: "trip",
        externalEventId: { startsWith: tripRequestKeyPrefix(ev.id, participant.id) },
      },
      select: {
        id: true, externalEventId: true, status: true, startDate: true, endDate: true,
        correctedCheckIn: true, correctedCheckOut: true, categoryId: true, reason: true,
      },
    });
    const reqs: Req[] = rows.map((r) => {
      const live = LIVE_TRIP_REQUEST_STATUSES.includes(r.status);
      const req: Req = {
        id: r.id,
        key: r.externalEventId ?? "",
        live,
        candidate: live && r.startDate.getTime() >= today.getTime(),
        used: false,
        fittedBy2: false,
        startDate: r.startDate,
        endDate: r.endDate,
        correctedCheckIn: r.correctedCheckIn,
        correctedCheckOut: r.correctedCheckOut,
        categoryId: r.categoryId,
        reason: r.reason,
        status: r.status,
        orig: "",
      };
      req.orig = snap(req);
      return req;
    });
    const byKey = new Map(reqs.map((r) => [r.key, r]));

    // 2) 오늘에 걸친 살아있는 신청은 끝을 어제로 (퇴근 정정 시각도 같은 시각의 어제로)
    for (const r of reqs) {
      if (!r.live || r.candidate) continue;
      if (r.startDate.getTime() < today.getTime() && r.endDate.getTime() >= today.getTime()) {
        const shift = r.endDate.getTime() - yesterday.getTime();
        r.endDate = yesterday;
        if (r.correctedCheckOut) r.correctedCheckOut = new Date(r.correctedCheckOut.getTime() - shift);
      }
    }

    // 날짜 행 → 최종 연결 대상 (1) 오늘 이후는 일단 모두 끊음, 지난 날은 지금 연결 유지)
    const link = new Map<number, Req | "keep" | null>();
    for (const d of participant.dates) {
      link.set(d.id, d.attendDate.getTime() >= today.getTime() ? null : "keep");
    }
    const recalcDays: Date[] = [];

    if (confirmed && !opts.removing) {
      const covering = (day: Date) =>
        reqs
          .filter((r) => r.live && !(r.candidate && !r.used) &&
            r.startDate.getTime() <= day.getTime() && r.endDate.getTime() >= day.getTime())
          .sort((x, y) => (x.id ?? Infinity) - (y.id ?? Infinity))[0];

      const sameTime = (r: Req, g: AttendanceGroup) =>
        kstHm(r.correctedCheckIn) === timeKey(g.startTime) &&
        kstHm(r.correctedCheckOut) === timeKey(g.endTime);

      // [묶음 배정] ① → ② → ③. 배정된 신청을 돌려준다(배정 불가면 null).
      const assign = (g: AttendanceGroup): Req | null => {
        const ci = g.startTime ? combineDateAndTime(g.startDate, g.startTime) : null;
        const co = g.endTime ? combineDateAndTime(g.endDate, g.endTime) : null;
        // ① 바로 앞날까지인 같은 시각 신청 늘리기 (지난 신청 또는 이번에 배정된 신청만)
        const prev = addDays(g.startDate, -1).getTime();
        const ext = reqs
          .filter((r) => r.live && !(r.candidate && !r.used) &&
            r.endDate.getTime() === prev && sameTime(r, g))
          .sort((x, y) => (x.id ?? Infinity) - (y.id ?? Infinity))[0];
        if (ext) {
          ext.endDate = g.endDate;
          ext.correctedCheckOut = co;
          ext.used = true;
          return ext;
        }
        const key = `${tripRequestKeyPrefix(ev.id, participant.id)}${ymdKey(g.startDate)}`;
        const found = byKey.get(key);
        // ② 같은 키 신청(재사용 후보·취소된 것)을 묶음에 맞춤. 지난 기록을 덮는 살아있는 신청은 건드리지 않음.
        if (found) {
          if (found.live && !found.candidate && !found.used) {
            console.warn(`[trip-calendar] 키 ${key} 신청이 지난 기록을 덮고 있어 배정 skip`);
            return null;
          }
          const fit: Partial<Req> = {
            startDate: g.startDate, endDate: g.endDate,
            correctedCheckIn: ci, correctedCheckOut: co,
            categoryId: categoryId ?? found.categoryId,
            reason: `[출장 및 외근] ${ev.name}`,
            status: "auto_approved",
          };
          Object.assign(found, fit);
          found.live = true;
          found.used = true;
          found.fittedBy2 = true;
          return found;
        }
        // ③ 새로 만듦
        if (categoryId == null) {
          console.warn("[trip-calendar] 카테고리 미확정 — 근태 생성 skip");
          return null;
        }
        const created: Req = {
          id: null, key, live: true, candidate: false, used: true, fittedBy2: false,
          startDate: g.startDate, endDate: g.endDate,
          correctedCheckIn: ci, correctedCheckOut: co,
          categoryId, reason: `[출장 및 외근] ${ev.name}`, status: "auto_approved", orig: "",
        };
        reqs.push(created);
        byKey.set(key, created);
        return created;
      };

      const past = participant.dates.filter((d) => d.attendDate.getTime() < today.getTime());
      const future = participant.dates.filter((d) => d.attendDate.getTime() >= today.getTime());

      // a) 기록된 지난 날짜 → 덮는 신청으로 연결만 맞춤 / b) 기록 안 된 지난 날짜 모음
      const unrecorded: typeof past = [];
      for (const d of past) {
        const r = covering(d.attendDate);
        if (r) link.set(d.id, r);
        else unrecorded.push(d);
      }
      // b) 늦은 확정 등 — 묶음 배정 + 재계산 표시
      for (const g of groupConsecutiveForAttendance(unrecorded)) {
        const r = assign(g);
        if (!r) continue;
        for (const id of g.dateIds) link.set(id, r);
        for (const ymd of g.ymdList) recalcDays.push(new Date(ymd + "T00:00:00.000Z"));
      }
      // c) 오늘 이후 — 묶음 배정
      for (const g of groupConsecutiveForAttendance(future)) {
        const r = assign(g);
        if (!r) continue;
        for (const id of g.dateIds) link.set(id, r);
      }
    }

    // ── 쓰기: 연결 끊기 → 신청 수정·생성 → 안 쓰인 후보 삭제 → 연결 → 재계산 표시 ──
    const finalId = (d: { id: number; attendanceRequestId: number | null }) => {
      const t = link.get(d.id);
      return t === "keep" ? d.attendanceRequestId : t ? t.id : null;
    };
    // 새로 만들 신청은 아직 id 가 없으므로, 그쪽으로 갈 행도 먼저 끊는다.
    const unlinkIds = participant.dates
      .filter((d) => {
        const t = link.get(d.id);
        if (d.attendanceRequestId === null) return false;
        if (t === "keep") return false;
        return !t || t.id === null || t.id !== d.attendanceRequestId;
      })
      .map((d) => d.id);
    if (unlinkIds.length > 0) {
      await tx.tripParticipantDate.updateMany({
        where: { id: { in: unlinkIds } },
        data: { attendanceRequestId: null },
      });
    }

    const now = new Date();
    for (const r of reqs) {
      if (r.id === null) {
        const c = await tx.attendanceRequest.create({
          data: {
            employeeId: participant.employeeId,
            categoryId: r.categoryId,
            requestType: "calendar_auto",
            startDate: r.startDate,
            endDate: r.endDate,
            reason: r.reason,
            correctedCheckIn: r.correctedCheckIn,
            correctedCheckOut: r.correctedCheckOut,
            externalSource: "trip",
            externalEventId: r.key,
            status: "auto_approved",
            approvedAt: now,
          },
        });
        r.id = c.id;
        result.created++;
        continue;
      }
      if (r.candidate && !r.used) continue; // 아래에서 삭제
      if (snap(r) === r.orig) continue;
      const before = JSON.parse(r.orig) as number[];
      await tx.attendanceRequest.update({
        where: { id: r.id },
        data: {
          startDate: r.startDate,
          endDate: r.endDate,
          correctedCheckIn: r.correctedCheckIn,
          correctedCheckOut: r.correctedCheckOut,
          ...(r.fittedBy2
            ? { categoryId: r.categoryId, reason: r.reason, status: r.status, approvedAt: now }
            : {}),
        },
      });
      if (r.fittedBy2) result.fitted++;
      else if (r.endDate.getTime() > before[1]) result.extended++;
      else result.trimmed++;
    }

    const unusedIds = reqs
      .filter((r) => r.candidate && !r.used && r.id !== null)
      .map((r) => r.id as number);
    if (unusedIds.length > 0) {
      // 남은 참조(다른 행)가 있으면 먼저 끊는다 — FK NoAction
      await tx.tripParticipantDate.updateMany({
        where: { attendanceRequestId: { in: unusedIds } },
        data: { attendanceRequestId: null },
      });
      const del = await tx.attendanceRequest.deleteMany({
        where: { id: { in: unusedIds }, externalSource: "trip" },
      });
      result.deleted = del.count;
    }

    // 연결: 최종 대상이 지금과 다른 행만
    const toLink = new Map<number, number[]>();
    for (const d of participant.dates) {
      const target = finalId(d);
      if (target === null) continue;
      const wasLinked = unlinkIds.includes(d.id) ? null : d.attendanceRequestId;
      if (wasLinked === target) continue;
      const list = toLink.get(target) ?? [];
      list.push(d.id);
      toLink.set(target, list);
      if (link.get(d.id) !== "keep" && d.attendDate.getTime() < today.getTime() &&
          !recalcDays.some((x) => x.getTime() === d.attendDate.getTime())) {
        result.relinked++;
      }
    }
    for (const [reqId, dateIds] of toLink) {
      await tx.tripParticipantDate.updateMany({
        where: { id: { in: dateIds } },
        data: { attendanceRequestId: reqId },
      });
    }

    if (recalcDays.length > 0) {
      result.recalcDates = await markAttendanceRecalc(tx, participant.employeeId, recalcDays);
    }
    return result;
  });
}

// 날짜 행 교체 — 초대 수락(웹 accept·챗 수락)과 날짜 변경(update_dates) 공용. 트랜잭션 안에서 부른다.
//  - "initial": 전체 교체. 지워지는 행의 calendar_event_id 를 모아 반환.
//  - "update": 지난 날짜(KST 오늘 미만)는 지금과 날짜·시각이 정확히 같아야 한다(다르면 400, 아무것도 안 바꿈).
//              오늘 이후만 비교해 빠진 날 삭제·시각 바뀐 날 수정·새 날 추가. 결과 0개면 400.
//              removeOnly = 추가 0 · 시각 변경 0 (승인 유지 판단용).
export async function replaceParticipantDates(
  tx: Db,
  participantId: number,
  dates: Array<{ attendDate: Date; startTime: Date | null; endTime: Date | null }>,
  mode: "initial" | "update"
): Promise<
  | { ok: true; removedCalendarEventIds: string[]; removeOnly: boolean }
  | { ok: false; error: string }
> {
  const existing = await tx.tripParticipantDate.findMany({
    where: { tripParticipantId: participantId },
    select: { id: true, attendDate: true, startTime: true, endTime: true, calendarEventId: true },
  });
  const calIds = (rows: typeof existing) =>
    rows
      .map((r) => r.calendarEventId)
      .filter((v): v is string => typeof v === "string" && v.length > 0);

  if (mode === "initial") {
    await tx.tripParticipantDate.deleteMany({ where: { tripParticipantId: participantId } });
    if (dates.length > 0) {
      await tx.tripParticipantDate.createMany({
        data: dates.map((d) => ({
          tripParticipantId: participantId,
          attendDate: d.attendDate,
          startTime: d.startTime,
          endTime: d.endTime,
        })),
      });
    }
    return { ok: true, removedCalendarEventIds: calIds(existing), removeOnly: false };
  }

  const today = kstTodayMidnightUtc().getTime();
  const sig = (d: { startTime: Date | null; endTime: Date | null }) =>
    `${timeKey(d.startTime)}-${timeKey(d.endTime)}`;
  const mmdd = (ymd: string) => ymd.slice(5);

  // 지난 날짜는 그대로여야 한다
  const pastOld = new Map(
    existing.filter((d) => d.attendDate.getTime() < today).map((d) => [ymdKey(d.attendDate), sig(d)])
  );
  const pastNew = new Map(
    dates.filter((d) => d.attendDate.getTime() < today).map((d) => [ymdKey(d.attendDate), sig(d)])
  );
  const badPast = [...new Set([...pastOld.keys(), ...pastNew.keys()])]
    .filter((ymd) => pastOld.get(ymd) !== pastNew.get(ymd))
    .sort();
  if (badPast.length > 0) {
    return {
      ok: false,
      error: `지난 날짜(${badPast.map(mmdd).join(", ")})는 바꿀 수 없습니다. 이미 지난 근태는 근태 정정 신청을 이용하세요.`,
    };
  }

  const futureOld = existing.filter((d) => d.attendDate.getTime() >= today);
  const futureNew = dates.filter((d) => d.attendDate.getTime() >= today);
  if (pastOld.size + futureNew.length === 0) {
    return { ok: false, error: "참석 날짜가 하나도 남지 않습니다. 빠지려면 참석자 제거를 이용하세요." };
  }
  const oldByYmd = new Map(futureOld.map((d) => [ymdKey(d.attendDate), d]));
  const newByYmd = new Map(futureNew.map((d) => [ymdKey(d.attendDate), d]));

  const removed = futureOld.filter((d) => !newByYmd.has(ymdKey(d.attendDate)));
  const changed = futureNew.filter((d) => {
    const o = oldByYmd.get(ymdKey(d.attendDate));
    return o && sig(o) !== sig(d);
  });
  const added = futureNew.filter((d) => !oldByYmd.has(ymdKey(d.attendDate)));

  if (removed.length > 0) {
    await tx.tripParticipantDate.deleteMany({ where: { id: { in: removed.map((d) => d.id) } } });
  }
  for (const d of changed) {
    const o = oldByYmd.get(ymdKey(d.attendDate))!;
    await tx.tripParticipantDate.update({
      where: { id: o.id },
      data: { startTime: d.startTime, endTime: d.endTime },
    });
  }
  if (added.length > 0) {
    await tx.tripParticipantDate.createMany({
      data: added.map((d) => ({
        tripParticipantId: participantId,
        attendDate: d.attendDate,
        startTime: d.startTime,
        endTime: d.endTime,
      })),
    });
  }
  return {
    ok: true,
    removedCalendarEventIds: calIds(removed),
    removeOnly: added.length === 0 && changed.length === 0,
  };
}

// ─────────────────────────────────────────────────
// 캘린더(Google) 이벤트 단위 재구성
// ─────────────────────────────────────────────────

// 캘린더 description은 사용자가 입력한 메모를 그대로 사용한다.
// 메모는 생성 폼에서 RequestPage 휴가/외근 autoDesc 형식("[VanaM HR 자동 등록]" 헤더 포함)
// 으로 기본 채워지므로 별도의 시스템 안내문을 추가하지 않는다.
// 메모가 비어 있는 경우만 최소 헤더 문구로 폴백.
function buildEventDescription(eventMemo: string | null): string {
  const memo = (eventMemo ?? "").trim();
  if (memo.length > 0) return memo;
  return "[VanaM HR 자동 등록]\n카테고리: 출장";
}

/**
 * 이벤트의 캘린더 일정을 처음부터 다시 만든다.
 *  1) 이 출장의 모든 날짜 행(지난 날 포함)에 연결된 calendar_event_id 와 넘겨받은 extra ids 를
 *     모두 지우고(syncer DELETE), 모든 행의 calendar_event_id 를 NULL 로.
 *  2) 그릴 날짜:
 *     - 오늘 이후: 확정 참석자(수락 + 승인·결재 불필요)의 날짜 — 출장이 active 일 때만.
 *     - 지난 날: 근태에 기록된 날짜(살아있는 출장 근태 기간이 덮는 날) — 참석자 상태·출장 status 무관.
 *       취소된 출장·늦게 승인된 끝난 출장도 지난 기록은 그린다.
 *  3) "날짜 → 참석자 집합(+시간)" 시그니처가 같고 연속이면 1건으로 묶어 캘린더 일정 생성.
 *  4) 새로 생성된 event_id 를 그 그룹의 모든 참석자 × 모든 날짜 행에 저장.
 *
 * 외부 호출 실패는 로그만, 전체 작업은 계속 진행.
 *
 * extraEventIdsToDelete: 호출자가 날짜 행·참석자를 지우기 전에 모아 둔 event_id 목록.
 *   행이 사라져 1) 에서 잡히지 않는 일정을 함께 지우기 위한 것(replaceParticipantDates 반환값,
 *   참석자 DELETE 전 수집값). 빈 배열이면 이 출장 행에 남은 것만 지운다.
 */
export async function rebuildTripEventCalendar(
  tripEventId: number,
  extraEventIdsToDelete: string[] = []
): Promise<void> {
  const event = await prisma.tripEvent.findUnique({
    where: { id: tripEventId },
    select: {
      id: true,
      name: true,
      location: true,
      description: true,
      status: true,
      calendarSourceId: true,
    },
  });
  if (!event) return;

  const srcInfo = await getCalendarSourceInfo(event.calendarSourceId);
  const targetCalendarId =
    srcInfo?.calendarId ?? (await getFieldTripCalendarId());
  if (!targetCalendarId) {
    console.warn(
      "[trip-calendar] 대상 캘린더 미확정 — 캘린더 재구성 skip"
    );
    return;
  }

  const todayKst = kstTodayMidnightUtc();

  // 1) 이 출장의 모든 날짜 행에 연결된 calendar_event_id 수집 → 삭제
  const linked = await prisma.tripParticipantDate.findMany({
    where: {
      tripParticipant: { tripEventId },
      calendarEventId: { not: null },
    },
    select: { id: true, calendarEventId: true },
  });
  // 삭제 대상 = (현재 행에 남아있는 calendar_event_id) ∪ (호출자가 미리 수집해 넘긴 extra).
  // syncer DELETE 실패(404 포함)는 로그만 — 멱등.
  const existingEventIds = new Set<string>(
    linked
      .map((d) => d.calendarEventId)
      .filter((v): v is string => typeof v === "string" && v.length > 0)
  );
  for (const eid of extraEventIdsToDelete) {
    if (typeof eid === "string" && eid.length > 0) existingEventIds.add(eid);
  }
  for (const eid of existingEventIds) {
    try {
      await callDeleteCalendarEvent(targetCalendarId, eid);
    } catch (e) {
      console.error(`[trip-calendar] rebuild delete 실패 (eventId=${eid}):`, e);
    }
  }
  if (linked.length > 0) {
    try {
      await prisma.tripParticipantDate.updateMany({
        where: { id: { in: linked.map((d) => d.id) } },
        data: { calendarEventId: null },
      });
    } catch (e) {
      console.error(`[trip-calendar] rebuild dates calendar_event_id 초기화 실패:`, e);
    }
  }

  // 2) 그릴 날짜 — 이 출장의 모든 참석자 + 날짜 행 + 살아있는 출장 근태(기록된 날짜 판정용)
  const participants = await prisma.tripParticipant.findMany({
    where: { tripEventId },
    include: {
      employee: {
        select: { id: true, name: true, email: true },
      },
      dates: {
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
  const liveRequests = await prisma.attendanceRequest.findMany({
    where: {
      externalSource: "trip",
      externalEventId: { startsWith: `trip-${tripEventId}-` },
      status: { in: LIVE_TRIP_REQUEST_STATUSES },
    },
    select: { employeeId: true, externalEventId: true, startDate: true, endDate: true },
  });
  const isRecorded = (p: { id: number; employeeId: number }, day: Date) => {
    const prefix = tripRequestKeyPrefix(tripEventId, p.id);
    return liveRequests.some(
      (r) =>
        r.employeeId === p.employeeId &&
        (r.externalEventId ?? "").startsWith(prefix) &&
        r.startDate.getTime() <= day.getTime() &&
        r.endDate.getTime() >= day.getTime()
    );
  };
  const eventActive = event.status === "active";

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
    const confirmed = eventActive && isConfirmedParticipant(p);
    for (const d of p.dates) {
      const isPast = d.attendDate.getTime() < todayKst.getTime();
      // 지난 날 = 근태에 기록된 날짜 / 오늘 이후 = 확정 참석자의 날짜
      if (isPast ? !isRecorded(p, d.attendDate) : !confirmed) continue;
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
        calendarId: targetCalendarId,
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

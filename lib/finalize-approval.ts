import type { Prisma } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { applyCorrectionToDaily } from "@/lib/attendance-correction";
import { createCalendarEvent } from "@/lib/calendar-event";

// ─────────────────────────────────────────────────────────────
// 근태 신청 "승인 확정" 후처리 — 모든 승인 경로가 이 두 함수를 쓴다.
//
//   applyApprovedRequestToDaily(tx, ...)  ← 트랜잭션 **안**에서 호출 (attendance_daily 반영)
//   syncApprovedRequestToCalendar(id)     ← 트랜잭션 **밖**에서 호출 (Google Calendar 등록)
//
// 왜 둘로 나누나: 외부 API(calendar-syncer)를 트랜잭션 안에 두지 않는다는 원칙.
// 왜 공용화하나: approvals/route.ts, sweep-delegations.ts, internal/approve-request 세 곳에
//   같은 코드가 복사돼 있었고, 두 곳에서 캘린더 생성이 빠지고 한 곳은 overrideSource가
//   달랐다(2026-09 조사: 승인 31건 중 11건 캘린더 미생성). 한 곳에 두면 새 승인 경로가
//   생겨도 누락이 구조적으로 불가능해진다.
//
// 로직 원본: app/api/approvals/route.ts 의 최종 승인 트랜잭션 + Phase 6-2E 캘린더 블록.
// 그 경로는 전수 조사에서 20/20 정상이었으므로 그대로 옮겼다. 바꾸지 말 것.
// ─────────────────────────────────────────────────────────────

// YYYY-MM-DD 배열 생성 (startDate ~ endDate inclusive) — approvals route 원본과 동일.
function daysBetween(start: Date, end: Date): string[] {
  const days: string[] = [];
  const cur = new Date(start);
  while (cur <= end) {
    days.push(cur.toISOString().split("T")[0]);
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return days;
}

export interface ApprovedRequestForDaily {
  id: number;
  employeeId: number;
  categoryId: number;
  startDate: Date;
  endDate: Date;
  correctedCheckIn: Date | null;
  correctedCheckOut: Date | null;
  category: { type: string; name: string };
}

/**
 * 승인 확정된 신청을 attendance_daily 에 반영한다. **트랜잭션 안에서** 호출할 것.
 * 반환: 반영한 날짜 수 (correction=1, leave/work=일수, 그 외=0)
 *
 * approvals/route.ts 원본 로직 그대로:
 *  - correction → applyCorrectionToDaily
 *  - leave/work → startDate~endDate 각 날 upsert (checkIn/Out 기존값 유지, autoStatus normal,
 *                 isLate/isEarlyLeave false, isOverridden true, overrideSource "calendar")
 *  - 그 외 type → 아무것도 안 함
 */
export async function applyApprovedRequestToDaily(
  tx: Prisma.TransactionClient,
  req: ApprovedRequestForDaily
): Promise<number> {
  const { category } = req;
  let applied = 0;

  if (category.type === "correction") {
    await applyCorrectionToDaily(tx, {
      employeeId: req.employeeId,
      workDate: req.startDate,
      correctedCheckIn: req.correctedCheckIn,
      correctedCheckOut: req.correctedCheckOut,
      requestId: req.id,
    });
    applied = 1;
  } else if (category.type === "leave" || category.type === "work") {
    // 휴가 / 외근·출장·재택: startDate~endDate 각 날 categoryId 세팅
    // 출퇴근 시각은 기존값 유지 (있으면 그대로, 없으면 NULL)
    // auto_status='normal' 강제 (휴가/외근은 정상 처리)
    const days = daysBetween(req.startDate, req.endDate);
    for (const ymd of days) {
      const wd = new Date(ymd + "T00:00:00.000Z");
      const existing = await tx.attendanceDaily.findUnique({
        where: {
          employeeId_workDate: { employeeId: req.employeeId, workDate: wd },
        },
      });
      await tx.attendanceDaily.upsert({
        where: {
          employeeId_workDate: { employeeId: req.employeeId, workDate: wd },
        },
        create: {
          employeeId: req.employeeId,
          workDate: wd,
          checkIn: null,
          checkOut: null,
          categoryId: req.categoryId,
          autoStatus: "normal",
          // 휴가/외근은 지각·조퇴 판정 면제 → 명시적 false
          isLate: false,
          isEarlyLeave: false,
          isOverridden: true,
          overrideSource: "calendar", // leave/work는 시각을 주장하지 않으므로 잠그지 않는다.
          // 'calendar' = 요청 기반 자동 보정 — aggregator 재갱신 허용
          note: `결재 #${req.id} (${category.name})`,
        },
        update: {
          categoryId: req.categoryId,
          autoStatus: "normal",
          // 휴가/외근은 지각·조퇴 판정 면제 → 명시적 false
          isLate: false,
          isEarlyLeave: false,
          isOverridden: true,
          overrideSource: "calendar", // leave/work는 시각을 주장하지 않으므로 잠그지 않는다.
          // 'calendar' = 요청 기반 자동 보정 — aggregator 재갱신 허용
          note: existing?.note ?? `결재 #${req.id} (${category.name})`,
        },
      });
      applied++;
    }
  }
  // 그 외 카테고리 type (없음 — correction/leave/work 3종만)

  return applied;
}

/**
 * 승인 확정된 신청을 Google Calendar 에 등록한다. **트랜잭션 밖에서** 호출할 것.
 * 반환: 생성된 event_id, 또는 조건 미충족/실패 시 null.
 *
 * 조건 (approvals/route.ts Phase 6-2E 원본과 동일):
 *   calendarSource 지정 + calendarEventTitle 존재 + externalEventId 없음(중복 방지)
 * 실패해도 throw 하지 않는다 — 결재/신청 자체는 유지 (관리자가 수동 등록하면 됨).
 */
export async function syncApprovedRequestToCalendar(
  requestId: number,
  logTag: string = "finalize"
): Promise<string | null> {
  const finalRequest = await prisma.attendanceRequest.findUnique({
    where: { id: requestId },
    include: {
      calendarSource: { select: { calendarId: true, calendarName: true } },
    },
  });

  if (
    !(
      finalRequest?.calendarSource &&
      finalRequest.calendarEventTitle &&
      !finalRequest.externalEventId // 이미 등록된 경우 중복 방지
    )
  ) {
    return null;
  }

  try {
    const calendarEventId = await createCalendarEvent({
      calendarId: finalRequest.calendarSource.calendarId,
      summary: finalRequest.calendarEventTitle,
      description: finalRequest.calendarEventDescription ?? "",
      startDate: finalRequest.startDate,
      endDate: finalRequest.endDate,
      correctedCheckIn: finalRequest.correctedCheckIn,
      correctedCheckOut: finalRequest.correctedCheckOut,
    });
    if (calendarEventId) {
      await prisma.attendanceRequest.update({
        where: { id: requestId },
        data: { externalSource: "hr", externalEventId: calendarEventId },
      });
      console.log(`[${logTag}] 캘린더 등록 완료: id=${requestId} eventId=${calendarEventId}`);
      return calendarEventId;
    }
    // event_id 없이 200이 온 경우 — 조용히 넘어가지 말고 반드시 남긴다
    console.warn(`[${logTag}] 캘린더 등록 응답에 event_id 없음: id=${requestId}`);
    return null;
  } catch (e) {
    console.error(`[${logTag}] 캘린더 등록 실패 (결재는 유지): id=${requestId}`, e);
    return null;
  }
}

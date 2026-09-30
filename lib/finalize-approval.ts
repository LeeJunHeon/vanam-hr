import type { Prisma } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import {
  applyCorrectionToDaily,
  computeCorrectedDaily,
} from "@/lib/attendance-correction";
import { createCalendarEvent } from "@/lib/calendar-event";
import { markAttendanceRecalc } from "@/lib/attendance-recalc";
import { kstTodayMidnightUtc } from "@/lib/kst-date";
import {
  LIVE_REQUEST_STATUSES,
  findLiveLeaveWorkRequests,
  isLeaveWorkCategoryType,
  isProtectedManualRow,
} from "@/lib/attendance-live-requests";

// ─────────────────────────────────────────────────────────────
// 근태 신청 "승인 확정" 후처리 — 모든 승인 경로가 이 함수들을 쓴다.
// (웹 결재, 챗 결재, 대리 자동확정, 신청 즉시 자동승인)
//
//   applyApprovedRequestToDaily(tx, ...)      ← 트랜잭션 **안**에서 호출 (attendance_daily 반영)
//   revertCancelledRequestFromDaily(tx, ...)  ← 트랜잭션 **안**에서 호출 (취소 시 원복)
//   syncApprovedRequestToCalendar(id)         ← 트랜잭션 **밖**에서 호출 (Google Calendar 등록)
//
// 왜 나누나: 외부 API(calendar-syncer)를 트랜잭션 안에 두지 않는다는 원칙.
// 왜 공용화하나: 승인 경로마다 코드가 복사돼 있다가 캘린더 누락·overrideSource 불일치가 났다
//   (2026-09 조사). 한 곳에 두면 새 승인 경로가 생겨도 누락이 구조적으로 불가능해진다.
//
// 반영 규칙:
//  - 지난 날(KST 오늘 이전)의 근태 판정은 aggregator 한 곳에서만 한다. 여기서는 지난 날에
//    상태를 직접 쓰지 않고 needs_recalc 표시(markAttendanceRecalc)만 한다 — aggregator 재계산
//    루프가 당일과 같은 규칙으로 다시 계산한다(늦게 승인된 시간 지정 외근도 동일).
//  - 오늘·앞날의 휴가·외근은 바로 기록한다(category, normal, 플래그 false, override 'calendar').
//  - 수동 보호 행(is_overridden=true, override_source <> 'calendar' — 근태 정정 등)의 시각·상태는
//    다른 신청의 승인·취소로 절대 바꾸지 않는다. 구분(category_id)만 맞춘다.
//  - 취소는 그 신청이 바꾼 것만 되돌리고 나머지는 재계산(aggregator)에 맡긴다.
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
 * 반환: 반영한 날짜 수 (correction=1, leave/long_leave/work=일수(재계산 표시한 날 포함), 그 외=0)
 *
 *  - correction → applyCorrectionToDaily
 *  - leave/long_leave/work → startDate~endDate 날짜별로
 *      · 지난 날: markAttendanceRecalc 로 재계산 표시만 (직접 쓰지 않음)
 *      · 오늘·앞날 + 수동 보호 행: category_id 만 이 신청의 카테고리로
 *      · 오늘·앞날 그 외: upsert (checkIn/Out 기존값 유지, autoStatus normal,
 *        isLate/isEarlyLeave false, isOverridden true, overrideSource "calendar")
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
  } else if (isLeaveWorkCategoryType(category.type)) {
    const today = kstTodayMidnightUtc();
    const pastDays: Date[] = [];
    const days = daysBetween(req.startDate, req.endDate);
    for (const ymd of days) {
      const wd = new Date(ymd + "T00:00:00.000Z");
      if (wd.getTime() < today.getTime()) {
        pastDays.push(wd);
        continue;
      }
      const existing = await tx.attendanceDaily.findUnique({
        where: {
          employeeId_workDate: { employeeId: req.employeeId, workDate: wd },
        },
      });
      if (isProtectedManualRow(existing)) {
        // 정정된 시각·상태·플래그·override·note 는 그대로, 구분만 맞춘다.
        if (existing!.categoryId !== req.categoryId) {
          await tx.attendanceDaily.update({
            where: { id: existing!.id },
            data: { categoryId: req.categoryId, updatedAt: new Date() },
          });
        }
        applied++;
        continue;
      }
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
    if (pastDays.length > 0) {
      await markAttendanceRecalc(tx, req.employeeId, pastDays);
      applied += pastDays.length;
    }
  }
  // 그 외 카테고리 type 은 근태에 반영하지 않는다.

  return applied;
}

function sameMinute(a: Date | null, b: Date | null): boolean {
  if (!a || !b) return false;
  return Math.floor(a.getTime() / 60000) === Math.floor(b.getTime() / 60000);
}

export interface CancelledRequestForDaily {
  id: number;
  employeeId: number;
  startDate: Date;
  endDate: Date;
  correctedCheckIn: Date | null;
  correctedCheckOut: Date | null;
  categoryType: string | null;
}

/**
 * 승인된(approved / auto_approved) 신청의 취소를 attendance_daily 에 반영한다.
 * **트랜잭션 안에서, 신청 상태를 cancelled 로 바꾼 뒤** 호출할 것. 결재 대기(pending) 취소에는
 * 부르지 않는다(반영된 적이 없음). 반환: 원복 처리한 날짜 수.
 *
 * 휴가·외근 — 날짜별로:
 *  - 수동 보호 행: 시각·상태·플래그·override·note 그대로. 그 날을 덮는 다른 살아 있는
 *    휴가·외근이 없으면 category_id 를 NULL 로(있으면 그대로). 지난 날이면 재계산 표시도 한다.
 *  - 지난 날: 재계산 표시만(aggregator 가 다시 계산).
 *  - 오늘: 손대지 않는다(aggregator 가 1분 안에 다시 계산하고 흔적 행을 정리).
 *  - 앞날 + 출퇴근 기록 없음: 다른 휴가·외근이 없으면 행 삭제(사유 첨부가 있으면 제외),
 *    있으면 category_id 를 그 신청(id 최소)의 카테고리로.
 * 근태 정정 — revertCancelledCorrection 참고.
 */
export async function revertCancelledRequestFromDaily(
  tx: Prisma.TransactionClient,
  req: CancelledRequestForDaily
): Promise<number> {
  if (req.categoryType === "correction") {
    return revertCancelledCorrection(tx, req);
  }
  if (!isLeaveWorkCategoryType(req.categoryType)) return 0;

  const today = kstTodayMidnightUtc().getTime();
  const pastDays: Date[] = [];
  const days = daysBetween(req.startDate, req.endDate);
  for (const ymd of days) {
    const wd = new Date(ymd + "T00:00:00.000Z");
    const isPast = wd.getTime() < today;
    const existing = await tx.attendanceDaily.findUnique({
      where: { employeeId_workDate: { employeeId: req.employeeId, workDate: wd } },
    });

    if (isProtectedManualRow(existing)) {
      const others = await findLiveLeaveWorkRequests(tx, req.employeeId, wd, req.id);
      if (others.length === 0 && existing!.categoryId !== null) {
        await tx.attendanceDaily.update({
          where: { id: existing!.id },
          data: { categoryId: null, updatedAt: new Date() },
        });
      }
      if (isPast) pastDays.push(wd);
      continue;
    }

    if (isPast) {
      pastDays.push(wd);
      continue;
    }
    if (wd.getTime() === today) continue; // 오늘은 aggregator 에 맡긴다
    if (!existing || existing.checkIn !== null || existing.checkOut !== null) continue;

    const others = await findLiveLeaveWorkRequests(tx, req.employeeId, wd, req.id);
    if (others.length > 0) {
      if (existing.categoryId !== others[0].categoryId) {
        await tx.attendanceDaily.update({
          where: { id: existing.id },
          data: { categoryId: others[0].categoryId, updatedAt: new Date() },
        });
      }
      continue;
    }
    const files = await tx.attendanceReasonFile.count({ where: { dailyId: existing.id } });
    if (files > 0) continue;
    await tx.attendanceDaily.delete({ where: { id: existing.id } });
  }

  if (pastDays.length > 0) {
    await markAttendanceRecalc(tx, req.employeeId, pastDays);
  }
  return days.length;
}

/**
 * 승인된 근태 정정의 취소.
 *  - 그 날 행이 없으면 아무것도 안 한다.
 *  - 이 정정이 바꾼 쪽만, 지금 값이 이 정정 값(분 절삭)과 같을 때만 백업으로 되돌린다.
 *    값이 다르면 그 뒤에 다른 정정·수정이 있었던 것이므로 그 쪽은 그대로 둔다.
 *  - 같은 날 다른 살아 있는 정정이 있으면 approved_at(없으면 requested_at), id 순으로 다시 적용한다.
 *    재적용에 필요하므로 백업은 그 동안 지우지 않는다. 재적용이 끝난 뒤, 되돌린 쪽 중
 *    남은 정정 누구도 건드리지 않는 쪽의 백업만 지운다(값이 원본과 같아졌으므로).
 *  - 남은 정정이 없으면 되돌린 쪽의 백업만 지우고, 두 백업이 모두 비면 보호를 해제한다.
 *    보호가 남으면 근무시간·상태·플래그만 다시 계산한다. 지난 날이면 재계산 표시.
 *  - 이 정정이 바꾸지 않은 쪽의 값·백업은 어떤 경우에도 그대로 둔다.
 */
async function revertCancelledCorrection(
  tx: Prisma.TransactionClient,
  req: CancelledRequestForDaily
): Promise<number> {
  const wd = req.startDate;
  const existing = await tx.attendanceDaily.findUnique({
    where: { employeeId_workDate: { employeeId: req.employeeId, workDate: wd } },
  });
  if (!existing) return 0;

  const revertIn =
    req.correctedCheckIn !== null && sameMinute(existing.checkIn, req.correctedCheckIn);
  const revertOut =
    req.correctedCheckOut !== null && sameMinute(existing.checkOut, req.correctedCheckOut);
  const checkIn = revertIn ? existing.originalCheckIn : existing.checkIn;
  const checkOut = revertOut ? existing.originalCheckOut : existing.checkOut;

  const remaining = (
    await tx.attendanceRequest.findMany({
      where: {
        employeeId: req.employeeId,
        id: { not: req.id },
        status: { in: LIVE_REQUEST_STATUSES },
        startDate: { lte: wd },
        endDate: { gte: wd },
        category: { type: "correction" },
      },
      select: {
        id: true,
        correctedCheckIn: true,
        correctedCheckOut: true,
        approvedAt: true,
        requestedAt: true,
      },
    })
  ).sort((a, b) => {
    const ta = (a.approvedAt ?? a.requestedAt).getTime();
    const tb = (b.approvedAt ?? b.requestedAt).getTime();
    return ta !== tb ? ta - tb : a.id - b.id;
  });

  if (remaining.length > 0) {
    if (revertIn || revertOut) {
      await tx.attendanceDaily.update({
        where: { id: existing.id },
        data: { checkIn, checkOut, updatedAt: new Date() },
      });
    }
    for (const r of remaining) {
      await applyCorrectionToDaily(tx, {
        employeeId: req.employeeId,
        workDate: wd,
        correctedCheckIn: r.correctedCheckIn,
        correctedCheckOut: r.correctedCheckOut,
        requestId: r.id,
      });
    }
    const clearIn = revertIn && !remaining.some((r) => r.correctedCheckIn !== null);
    const clearOut = revertOut && !remaining.some((r) => r.correctedCheckOut !== null);
    if (clearIn || clearOut) {
      await tx.attendanceDaily.update({
        where: { id: existing.id },
        data: {
          ...(clearIn ? { originalCheckIn: null } : {}),
          ...(clearOut ? { originalCheckOut: null } : {}),
        },
      });
    }
    return 1;
  }

  // 남은 정정 없음
  const originalCheckIn = revertIn ? null : existing.originalCheckIn;
  const originalCheckOut = revertOut ? null : existing.originalCheckOut;
  // 보호 해제는 이 취소가 실제로 되돌린 경우에만 — 되돌린 게 없으면 다른 수정이 있었던 행이다.
  const release =
    (revertIn || revertOut) && originalCheckIn === null && originalCheckOut === null;

  if (release) {
    await tx.attendanceDaily.update({
      where: { id: existing.id },
      data: {
        checkIn,
        checkOut,
        originalCheckIn: null,
        originalCheckOut: null,
        isOverridden: false,
        overrideSource: null,
        note: existing.note?.startsWith("결재정정 #") ? null : existing.note,
        updatedAt: new Date(),
      },
    });
  } else if (revertIn || revertOut) {
    // 보호가 남는 행(다른 쪽 백업이 있음) — 시각이 바뀌었으니 파생값만 다시 계산.
    const derived = await computeCorrectedDaily(
      tx,
      req.employeeId,
      wd,
      checkIn,
      checkOut,
      `cancel requestId=${req.id}`
    );
    await tx.attendanceDaily.update({
      where: { id: existing.id },
      data: {
        checkIn,
        checkOut,
        originalCheckIn,
        originalCheckOut,
        ...derived,
        updatedAt: new Date(),
      },
    });
  }

  if (wd.getTime() < kstTodayMidnightUtc().getTime()) {
    await markAttendanceRecalc(tx, req.employeeId, [wd]);
  }
  return 1;
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

// 팀 일정 알림 — 호출부가 finalize-approval 하나만 import 하면 되도록 re-export.
export { notifyTeamOfApprovedRequest } from "@/lib/team-schedule-notify";

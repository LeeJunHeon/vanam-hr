// 관리자 — 승인된 반차 등 시간형 휴가 신청의 시각 수정 (PUT /api/attendance-requests?id=N, action "retime").
// 날짜·카테고리는 그대로, 시작·종료 시각만 바꾼다. 근태 판정은 "시프트 − 신청 시각"(aggregator·lib/attendance-judge)이라
// 신청 시각만 맞추면 되고, 지난 날짜는 재계산 표시(markAttendanceRecalc), 오늘은 aggregator 다음 사이클, 미래는 할 일 없음.
// 구글 캘린더(hr 출처 일정)는 커밋 뒤 calendar-syncer PATCH 로 시각만 맞춘다 — 실패해도 DB 는 되돌리지 않고 응답에 알린다.
// 변경 이력은 신청자 알림(request_retime) + 서버 info 로그 (새 테이블 없음).
import type { Session } from "next-auth";
import { prisma } from "@/lib/prisma";
import { canViewDepartment, isAdminSession } from "@/lib/auth-helpers";
import { isLeaveCategoryType } from "@/lib/category-kind";
import { LIVE_REQUEST_STATUSES } from "@/lib/attendance-live-requests";
import { loadAttendancePolicy } from "@/lib/attendance-policy";
import { markAttendanceRecalc } from "@/lib/attendance-recalc";
import { updateCalendarEventTime } from "@/lib/calendar-event";
import { createNotifications } from "@/lib/notify";

export const RETIME_NOTIFY_TYPE = "request_retime";

export type RetimeCalendarResult = "updated" | "failed" | "not_found" | "none";

type Result = { status: number; body: Record<string, unknown> };

// ── 순수 판정 ──

/** 관리자·CEO 이고, 대상 직원 부서를 볼 수 있을 때만 (전체 근태 조회와 같은 범위) */
export function canRetime(session: Session | null | undefined, targetDepartmentId: number | null): boolean {
  return isAdminSession(session) && canViewDepartment(session, targetDepartmentId);
}

const ymd = (d: Date) => d.toISOString().slice(0, 10);

/** 수정할 수 있는 신청인지 — 안 되면 { status, error } */
export function retimeTargetError(
  req: {
    status: string;
    externalSource: string | null;
    startDate: Date;
    endDate: Date;
    correctedCheckIn: Date | null;
    correctedCheckOut: Date | null;
  },
  categoryType: string | null | undefined
): { status: number; error: string } | null {
  if (req.externalSource === "google_calendar") {
    return { status: 409, error: "구글 캘린더에서 만든 일정입니다. 캘린더에서 고쳐야 합니다." };
  }
  if (req.externalSource === "trip") {
    return { status: 409, error: "출장 기록은 출장 및 외근 관리에서 고치세요." };
  }
  if (req.externalSource && req.externalSource !== "hr") {
    return { status: 409, error: `이 화면에서 고칠 수 없는 출처(${req.externalSource})의 신청입니다.` };
  }
  if (!LIVE_REQUEST_STATUSES.includes(req.status)) {
    return { status: 409, error: "승인된 신청만 시각을 수정할 수 있습니다." };
  }
  if (!isLeaveCategoryType(categoryType)) {
    return { status: 409, error: "휴가 신청만 시각을 수정할 수 있습니다." };
  }
  if (!req.correctedCheckIn || !req.correctedCheckOut) {
    return { status: 409, error: "종일 휴가는 시각을 수정할 수 없습니다." };
  }
  if (ymd(req.startDate) !== ymd(req.endDate)) {
    return { status: 409, error: "하루짜리 신청만 시각을 수정할 수 있습니다." };
  }
  return null;
}

/** "HH:MM" 은 그 날짜의 KST 시각으로, 그 밖에는 ISO 일시로 해석. 틀리면 null */
export function parseRetimeTime(value: unknown, dateYmd: string): Date | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const v = value.trim();
  const m = /^(\d{2}):(\d{2})$/.exec(v);
  const d = m
    ? Number(m[1]) < 24 && Number(m[2]) < 60
      ? new Date(`${dateYmd}T${v}:00+09:00`)
      : null
    : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)
      ? new Date(v)
      : null;
  return d && !isNaN(d.getTime()) ? d : null;
}

/** 근무일 창 [날짜 cutoff시, 다음날 cutoff시] (KST) */
export function workDayWindow(dateYmd: string, cutoffHour: number): { start: Date; end: Date } {
  const start = new Date(`${dateYmd}T${String(cutoffHour).padStart(2, "0")}:00:00+09:00`);
  return { start, end: new Date(start.getTime() + 86400000) };
}

/** KST "HH:MM" */
export function kstHHMM(d: Date): string {
  return new Date(d.getTime() + 9 * 3600000).toISOString().slice(11, 16);
}

/** "관리자 홍길동님이 11/20 오후반차 시각을 13:00~20:00 → 12:00~20:00 으로 변경했습니다." */
export function retimeNotificationBody(args: {
  adminName: string;
  dateYmd: string;
  categoryName: string;
  before: { in: Date; out: Date };
  after: { in: Date; out: Date };
}): string {
  const md = `${Number(args.dateYmd.slice(5, 7))}/${Number(args.dateYmd.slice(8, 10))}`;
  const range = (r: { in: Date; out: Date }) => `${kstHHMM(r.in)}~${kstHHMM(r.out)}`;
  return `관리자 ${args.adminName}님이 ${md} ${args.categoryName} 시각을 ${range(args.before)} → ${range(args.after)} 으로 변경했습니다.`;
}

// ── 처리 ──

export async function retimeAttendanceRequest(
  session: Session,
  id: number,
  body: { correctedCheckIn?: unknown; correctedCheckOut?: unknown }
): Promise<Result> {
  const fail = (status: number, error: string): Result => ({ status, body: { error } });
  if (!isAdminSession(session)) return fail(403, "관리자만 시각을 수정할 수 있습니다.");

  const before = await prisma.attendanceRequest.findUnique({
    where: { id },
    include: {
      category: { select: { type: true, name: true } },
      employee: { select: { name: true, departmentId: true } },
    },
  });
  if (!before) return fail(404, "요청을 찾을 수 없습니다.");
  if (!canRetime(session, before.employee.departmentId)) {
    return fail(403, "이 직원의 신청을 수정할 권한이 없습니다.");
  }
  const targetErr = retimeTargetError(before, before.category.type);
  if (targetErr) return fail(targetErr.status, targetErr.error);
  const beforeIn = before.correctedCheckIn!;
  const beforeOut = before.correctedCheckOut!;

  const dateYmd = ymd(before.startDate);
  const newIn = parseRetimeTime(body.correctedCheckIn, dateYmd);
  const newOut = parseRetimeTime(body.correctedCheckOut, dateYmd);
  if (!newIn || !newOut) return fail(400, "시작·종료 시각(HH:MM)을 모두 입력하세요.");
  if (newOut <= newIn) return fail(400, "종료 시각은 시작 시각보다 늦어야 합니다.");
  const { cutoffHour } = await loadAttendancePolicy(prisma);
  const win = workDayWindow(dateYmd, cutoffHour);
  if (newIn < win.start || newOut > win.end) {
    return fail(400, `시각은 그 근무일(${dateYmd} ${String(cutoffHour).padStart(2, "0")}:00 ~ 다음날 ${String(cutoffHour).padStart(2, "0")}:00) 안이어야 합니다.`);
  }

  // 같은 직원 같은 날 다른 시간형 휴가와 겹치면 409
  const others = await prisma.attendanceRequest.findMany({
    where: {
      id: { not: id },
      employeeId: before.employeeId,
      status: { in: LIVE_REQUEST_STATUSES },
      startDate: { lte: before.startDate },
      endDate: { gte: before.startDate },
      correctedCheckIn: { not: null },
      correctedCheckOut: { not: null },
    },
    select: { id: true, correctedCheckIn: true, correctedCheckOut: true, category: { select: { type: true, name: true } } },
  });
  const clash = others.find(
    (o) =>
      isLeaveCategoryType(o.category.type) &&
      o.correctedCheckIn! < newOut &&
      newIn < o.correctedCheckOut!
  );
  if (clash) {
    return fail(
      409,
      `같은 날 다른 휴가(${clash.category.name} ${kstHHMM(clash.correctedCheckIn!)}~${kstHHMM(clash.correctedCheckOut!)})와 시간이 겹칩니다.`
    );
  }

  const changed = newIn.getTime() !== beforeIn.getTime() || newOut.getTime() !== beforeOut.getTime();
  let recalcMarked: string[] = [];
  if (changed) {
    // 낙관적 잠금 — 조회 이후 상태·시각이 바뀌었으면 0건 → 409
    const saved = await prisma.$transaction(async (tx) => {
      const upd = await tx.attendanceRequest.updateMany({
        where: { id, status: before.status, correctedCheckIn: beforeIn, correctedCheckOut: beforeOut },
        data: { correctedCheckIn: newIn, correctedCheckOut: newOut, updatedAt: new Date() },
      });
      if (upd.count === 0) return null;
      // 지난 날짜만 재계산 표시 (오늘은 aggregator 다음 사이클, 미래는 할 일 없음)
      return await markAttendanceRecalc(tx, before.employeeId, [before.startDate]);
    });
    if (saved === null) return fail(409, "신청이 그사이 바뀌었습니다. 새로고침 후 다시 시도하세요.");
    recalcMarked = saved;
  }

  // 캘린더 — 커밋 뒤, hr 출처 일정만. 시각이 같아도 다시 맞춘다("캘린더 다시 반영").
  let calendar: RetimeCalendarResult = "none";
  if (before.externalSource === "hr" && before.externalEventId && before.calendarSourceId) {
    try {
      const src = await prisma.calendarSource.findUnique({
        where: { id: before.calendarSourceId },
        select: { calendarId: true },
      });
      calendar = src
        ? await updateCalendarEventTime(src.calendarId, before.externalEventId, newIn, newOut)
        : "not_found";
      if (calendar === "not_found") {
        console.error(
          `[retime] 신청 #${id} 캘린더 일정을 찾지 못함 (DB 변경은 유지): eventId=${before.externalEventId}, calendarSourceId=${before.calendarSourceId}`
        );
      }
    } catch (e) {
      calendar = "failed";
      console.error(`[retime] 신청 #${id} 캘린더 반영 실패 (DB 변경은 유지):`, e);
    }
  }

  const adminEmp = Number.isInteger(session.user.employeeId)
    ? await prisma.employee.findUnique({ where: { id: session.user.employeeId as number }, select: { name: true } })
    : null;
  const adminName = adminEmp?.name ?? session.user.name ?? "관리자";
  const range = (a: Date, b: Date) => `${kstHHMM(a)}~${kstHHMM(b)}`;
  console.info(
    `[retime] ${new Date().toISOString()} 관리자 ${adminName}(employeeId=${session.user.employeeId ?? "-"}) ` +
      `신청 #${id} ${before.employee.name} ${dateYmd} ${before.category.name} ` +
      `${range(beforeIn, beforeOut)} → ${range(newIn, newOut)}` +
      `${changed ? "" : " (시각 같음 — 캘린더만 다시 반영)"} recalc=[${recalcMarked.join(",")}] calendar=${calendar}`
  );

  if (changed) {
    try {
      await createNotifications({
        employeeIds: [before.employeeId],
        type: RETIME_NOTIFY_TYPE,
        title: "근태 신청 시각 변경",
        body: retimeNotificationBody({
          adminName,
          dateYmd,
          categoryName: before.category.name,
          before: { in: beforeIn, out: beforeOut },
          after: { in: newIn, out: newOut },
        }),
        linkPage: "request",
        linkRefId: id,
        sourceType: "attendance_request",
      });
    } catch (e) {
      console.warn(`[retime] 신청 #${id} 시각 변경 알림 실패 (저장은 유지):`, e);
    }
  }

  return {
    status: 200,
    body: {
      id,
      changed,
      correctedCheckIn: newIn.toISOString(),
      correctedCheckOut: newOut.toISOString(),
      recalcMarked,
      calendar,
    },
  };
}

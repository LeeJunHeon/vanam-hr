import type { Prisma } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { createNotifications } from "@/lib/notify";

// 그룹 출장(Field Trip) API 공용 헬퍼.
// Phase 7 2단계 — 참석자 관리 라우트들이 공유.

// YYYY-MM-DD → UTC midnight Date. 잘못된 형식이면 null.
export function parseYmd(s: unknown): Date | null {
  if (typeof s !== "string") return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(s + "T00:00:00.000Z");
  return isNaN(d.getTime()) ? null : d;
}

// "HH:MM" → @db.Time(6) 저장용 Date (UTC 1970-01-01 기준).
// 잘못된 형식이면 null. 빈 문자열/undefined/null도 null.
export function parseHhmm(s: unknown): Date | null {
  if (s == null || s === "") return null;
  if (typeof s !== "string") return null;
  if (!/^\d{2}:\d{2}$/.test(s)) return null;
  const [hh, mm] = s.split(":").map(Number);
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  return new Date(Date.UTC(1970, 0, 1, hh, mm, 0));
}

// 참석자 요청 본문의 dates 배열 항목 1개 검증/정규화 결과.
export interface ParsedDate {
  attendDate: Date;
  startTime: Date | null;
  endTime: Date | null;
}

// dates 배열 → ParsedDate[] 또는 에러 문자열.
// - 모든 attendDate는 [eventStart, eventEnd] 이내여야 함.
// - startTime/endTime 둘 다 있으면 start < end.
// - 항목 1개라도 검증 실패 시 즉시 에러 반환.
export function parseDatesArray(
  raw: unknown,
  eventStart: Date,
  eventEnd: Date
): { ok: true; dates: ParsedDate[] } | { ok: false; error: string } {
  if (!Array.isArray(raw)) {
    return { ok: false, error: "dates는 배열이어야 합니다." };
  }
  const out: ParsedDate[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== "object") {
      return { ok: false, error: "dates 항목 형식 오류" };
    }
    const r = item as Record<string, unknown>;
    const d = parseYmd(r.attendDate);
    if (!d) {
      return {
        ok: false,
        error: "attendDate 형식이 잘못되었습니다 (YYYY-MM-DD).",
      };
    }
    if (d.getTime() < eventStart.getTime() || d.getTime() > eventEnd.getTime()) {
      return {
        ok: false,
        error: "attendDate가 이벤트 기간(start~end)을 벗어났습니다.",
      };
    }
    const ymd = d.toISOString().split("T")[0];
    if (seen.has(ymd)) {
      return { ok: false, error: `중복 attendDate: ${ymd}` };
    }
    seen.add(ymd);

    // 시간은 선택. 빈/누락이면 종일(NULL).
    const startTime =
      r.startTime !== undefined && r.startTime !== null && r.startTime !== ""
        ? parseHhmm(r.startTime)
        : null;
    if (r.startTime !== undefined && r.startTime !== null && r.startTime !== "" && startTime === null) {
      return { ok: false, error: "startTime 형식이 잘못되었습니다 (HH:MM)." };
    }
    const endTime =
      r.endTime !== undefined && r.endTime !== null && r.endTime !== ""
        ? parseHhmm(r.endTime)
        : null;
    if (r.endTime !== undefined && r.endTime !== null && r.endTime !== "" && endTime === null) {
      return { ok: false, error: "endTime 형식이 잘못되었습니다 (HH:MM)." };
    }
    if (startTime && endTime && startTime.getTime() >= endTime.getTime()) {
      return {
        ok: false,
        error: "startTime은 endTime보다 빨라야 합니다.",
      };
    }

    out.push({ attendDate: d, startTime, endTime });
  }
  return { ok: true, dates: out };
}

// 참석자 추가 시 approval_status 자동 결정 규칙(스펙 §2):
// - admin/ceo가 개입한 참석(타인 초대 or 본인 self-join) → "not_required"
// - employee가 참석 → "pending"
export function computeApprovalStatus(
  requesterRole: string | undefined | null
): "not_required" | "pending" {
  if (requesterRole === "admin" || requesterRole === "ceo") return "not_required";
  return "pending";
}

// ── 확정 참석자 — 단일 정의 ─────────────────────────────────
// 확정 = 초대 수락(accepted) + 결재 완료(approved 또는 결재 불필요 not_required) + 취소 안 된(active) 출장.
// 수락하지 않은 채 승인된 참여는 확정이 아니다.
// 근태 생성·캘린더 재구성·보고서 미제출 알림·내 출장/보고서 현황이 모두 이 정의를 쓴다.
const CONFIRMED_APPROVAL_STATUSES = ["approved", "not_required"];

export function isConfirmedParticipant(p: {
  inviteStatus: string;
  approvalStatus: string;
}): boolean {
  return (
    p.inviteStatus === "accepted" &&
    CONFIRMED_APPROVAL_STATUSES.includes(p.approvalStatus)
  );
}

export function confirmedParticipantWhere(): Prisma.TripParticipantWhereInput {
  return {
    inviteStatus: "accepted",
    approvalStatus: { in: CONFIRMED_APPROVAL_STATUSES },
    tripEvent: { status: "active" },
  };
}

// 출장보고서 대상(내 출장·보고서 현황): 확정 참석자이거나,
// 출장이 취소됐어도 보고서가 이미 있는 참여(작성 기록 보존).
export function tripReportTargetWhere(): Prisma.TripParticipantWhereInput {
  return {
    inviteStatus: "accepted",
    approvalStatus: { in: CONFIRMED_APPROVAL_STATUSES },
    OR: [{ tripEvent: { status: "active" } }, { report: { isNot: null } }],
  };
}

// ── 초대 응답 가능 상태 — 웹(trip-participants PATCH)·챗(respond-trip-invite) 공용 ──
// 수락: 초대됨·거절 상태에서만. 거절: 초대됨 상태에서만. 허용이면 null, 아니면 안내 문구.
export function checkInviteResponse(
  inviteStatus: string,
  action: "accept" | "decline"
): string | null {
  if (action === "accept") {
    if (inviteStatus === "invited" || inviteStatus === "declined") return null;
    if (inviteStatus === "accepted") {
      return "이미 수락한 출장입니다. 날짜를 바꾸려면 출장 관리의 날짜 변경을, 빠지려면 참석자 제거를 이용하세요.";
    }
    return "수락할 수 없는 초대 상태입니다.";
  }
  if (inviteStatus === "invited") return null;
  if (inviteStatus === "declined") return "이미 거절한 출장입니다.";
  if (inviteStatus === "accepted") {
    return "이미 수락한 출장은 거절할 수 없습니다. 참석을 취소하려면 출장 관리에서 참석자 제거를 이용하세요.";
  }
  return "거절할 수 없는 초대 상태입니다.";
}

// ── "새 출장 결재 요청" 알림 — 참여(self-join)·초대 수락(웹·챗)·날짜 변경 재결재 공용 ──
// 결재자가 없으면 보내지 않는다. 실패는 로그만(본 처리에 영향 없음).
export async function notifyTripApprovalRequested(args: {
  approverIds: number[];
  requesterEmployeeId: number;
  tripEventId: number;
  logLabel: string;
}): Promise<void> {
  if (args.approverIds.length === 0) return;
  try {
    const me = await prisma.employee.findUnique({
      where: { id: args.requesterEmployeeId },
      select: { name: true },
    });
    const requesterName = me?.name ?? "직원";
    await createNotifications({
      employeeIds: args.approverIds,
      type: "trip_request",
      title: "새 출장 결재 요청",
      body: `${requesterName}님의 출장 참여 결재 요청`,
      linkPage: "approval",
      linkRefId: args.tripEventId,
      sourceType: "trip",
    });
  } catch (e) {
    console.error(`[notify] 출장 결재 요청 알림 생성 실패(${args.logLabel}):`, e);
  }
}

import { prisma } from "@/lib/prisma";
import { createNotifications } from "@/lib/notify";

// ─────────────────────────────────────────────────────────────
// 팀 일정 알림 — 근태 신청이 승인 확정되면 같은 부서 동료에게 알린다.
//
// 설정(policy_settings):
//   team_schedule_notify_enabled      "true"/"false"       기능 on/off        (기본 true)
//   team_schedule_notify_categories   JSON 배열 문자열     알릴 카테고리 code (기본 아래)
//   team_schedule_notify_include_approvers  "true"/"false"  결재자 포함 여부   (기본 false)
//
// 발송 채널(app/email/push)은 기존 규칙 notify_team_schedule_{app,email,push} 를 따른다.
// 중복 방지: attendance_requests.team_notified_at 이 이미 채워져 있으면 스킵.
// ─────────────────────────────────────────────────────────────

export const TEAM_SCHEDULE_KEYS = {
  enabled: "team_schedule_notify_enabled",
  categories: "team_schedule_notify_categories",
  includeApprovers: "team_schedule_notify_include_approvers",
} as const;

// 기본 규칙에서 제외할 카테고리 code 패턴 (출장/외근 계열).
// 관리자가 설정 탭에서 목록을 한 번이라도 저장하면 policy_settings 값이 우선한다.
export const TEAM_SCHEDULE_DEFAULT_EXCLUDE_CODE_RE = /TRIP|OUT|BUSINESS/i;

export interface TeamScheduleSettings {
  enabled: boolean;
  categoryCodes: string[] | null; // null = 미설정(기본 규칙 적용)
  includeApprovers: boolean;
}

export async function getTeamScheduleSettings(): Promise<TeamScheduleSettings> {
  const rows = await prisma.policySetting.findMany({
    where: { key: { in: Object.values(TEAM_SCHEDULE_KEYS) } },
    select: { key: true, value: true },
  });
  const m = new Map(rows.map((r) => [r.key, r.value]));
  const enabledRaw = m.get(TEAM_SCHEDULE_KEYS.enabled);
  const catRaw = m.get(TEAM_SCHEDULE_KEYS.categories);
  const inclRaw = m.get(TEAM_SCHEDULE_KEYS.includeApprovers);

  let categoryCodes: string[] | null = null;
  if (catRaw) {
    try {
      const parsed = JSON.parse(catRaw);
      if (Array.isArray(parsed)) categoryCodes = parsed.filter((c) => typeof c === "string");
    } catch {
      categoryCodes = null;
    }
  }
  return {
    enabled: enabledRaw !== undefined ? enabledRaw === "true" : true,
    categoryCodes,
    includeApprovers: inclRaw !== undefined ? inclRaw === "true" : false,
  };
}

// 기본 규칙: leave 타입이면서 출장/외근 계열이 아닌 것. (설정 API 의 "현재 선택" 표시에도 공용)
export function isDefaultTeamScheduleCategory(c: { code: string; type: string }): boolean {
  return c.type === "leave" && !TEAM_SCHEDULE_DEFAULT_EXCLUDE_CODE_RE.test(c.code);
}

// 설정된 code 목록 → categoryId Set. 미설정(null)이면 기본 규칙.
async function resolveTargetCategoryIds(codes: string[] | null): Promise<Set<number>> {
  const all = await prisma.attendanceCategory.findMany({
    where: { isActive: true },
    select: { id: true, code: true, type: true },
  });
  if (codes && codes.length > 0) {
    const set = new Set(codes.map((c) => c.toUpperCase()));
    return new Set(all.filter((c) => set.has(c.code.toUpperCase())).map((c) => c.id));
  }
  return new Set(all.filter(isDefaultTeamScheduleCategory).map((c) => c.id));
}

// 부서의 결재자 id 집합 (primary/deputy/approverIds 전부). 카테고리별 결재선까지 포함.
async function getDepartmentApproverIds(departmentId: number): Promise<Set<number>> {
  const lines = await prisma.approvalLine.findMany({
    where: { departmentId },
    select: { primaryApproverId: true, deputyApproverId: true, approverIds: true },
  });
  const ids = new Set<number>();
  for (const l of lines) {
    ids.add(l.primaryApproverId);
    if (l.deputyApproverId != null) ids.add(l.deputyApproverId);
    for (const a of l.approverIds) ids.add(a);
  }
  return ids;
}

// startDate/endDate 는 @db.Date (UTC 자정) 이므로 UTC 기준으로 읽으면 그 날짜가 나온다.
function ymd(d: Date): string {
  return d.toISOString().split("T")[0];
}
function weekdayKo(d: Date): string {
  return ["일", "월", "화", "수", "목", "금", "토"][d.getUTCDay()];
}
function fmtDate(d: Date): string {
  return `${ymd(d)}(${weekdayKo(d)})`;
}
function hhmm(d: Date): string {
  // KST 기준 HH:MM
  const k = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  return `${String(k.getUTCHours()).padStart(2, "0")}:${String(k.getUTCMinutes()).padStart(2, "0")}`;
}

/**
 * 승인 확정된 신청에 대해 같은 부서 동료에게 팀 일정 알림을 보낸다.
 * **트랜잭션 밖에서** 호출할 것. 실패해도 throw 하지 않는다.
 * 반환: 발송 대상 수 (스킵/실패 시 0)
 */
export async function notifyTeamOfApprovedRequest(
  requestId: number,
  logTag: string = "team-schedule"
): Promise<number> {
  try {
    const settings = await getTeamScheduleSettings();
    if (!settings.enabled) return 0;

    const req = await prisma.attendanceRequest.findUnique({
      where: { id: requestId },
      include: {
        employee: { select: { id: true, name: true, departmentId: true, isActive: true } },
        category: { select: { id: true, name: true, code: true } },
      },
    });
    if (!req) return 0;
    if (req.teamNotifiedAt) return 0; // 이미 발송됨 (중복 방지)
    if (!["approved", "auto_approved", "auto_delegated"].includes(req.status)) return 0;
    if (!req.employee?.departmentId) return 0; // 부서 없으면 알릴 동료가 없다

    const targetCats = await resolveTargetCategoryIds(settings.categoryCodes);
    if (!targetCats.has(req.categoryId)) return 0;

    // 수신자: 같은 부서 + 활성 + 본인 제외 (+ 결재자 제외, 설정에 따라)
    const mates = await prisma.employee.findMany({
      where: {
        departmentId: req.employee.departmentId,
        isActive: true,
        id: { not: req.employee.id },
      },
      select: { id: true },
    });
    let recipientIds = mates.map((m) => m.id);
    if (!settings.includeApprovers) {
      const approvers = await getDepartmentApproverIds(req.employee.departmentId);
      recipientIds = recipientIds.filter((id) => !approvers.has(id));
    }
    if (recipientIds.length === 0) {
      // 대상이 없어도 "처리됨"으로 표시해 재시도하지 않는다
      await prisma.attendanceRequest.update({
        where: { id: requestId },
        data: { teamNotifiedAt: new Date() },
      });
      return 0;
    }

    const isTimed = !!(req.correctedCheckIn && req.correctedCheckOut);
    const sameDay = ymd(req.startDate) === ymd(req.endDate);
    const period = sameDay
      ? fmtDate(req.startDate)
      : `${fmtDate(req.startDate)} ~ ${fmtDate(req.endDate)}`;
    const kind = isTimed
      ? `${req.category.name} (${hhmm(req.correctedCheckIn!)}~${hhmm(req.correctedCheckOut!)})`
      : `종일 일정 (${req.category.name})`;

    const sent = await createNotifications({
      employeeIds: recipientIds,
      type: "team_schedule",
      title: `팀 일정 안내 — ${req.employee.name}`,
      body:
        `${req.employee.name} 님이 ${period}에 ${kind}이 있습니다.\n` +
        `팀 스케줄을 확인해 주세요.`,
      // 전체 일정 조회(schedule-overview)는 관리자 전용이라 일반 팀원은 열 수 없다 → 대시보드로.
      linkPage: "dashboard",
      linkRefId: req.id,
      sourceType: "attendance_request",
    });

    await prisma.attendanceRequest.update({
      where: { id: requestId },
      data: { teamNotifiedAt: new Date() },
    });
    console.log(`[${logTag}] 팀 일정 알림 발송: id=${requestId} 대상 ${recipientIds.length}명`);
    return sent;
  } catch (e) {
    console.error(`[${logTag}] 팀 일정 알림 실패 (승인은 유지): id=${requestId}`, e);
    return 0;
  }
}

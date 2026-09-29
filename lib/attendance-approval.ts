import { prisma } from "@/lib/prisma";
import { createNotifications } from "@/lib/notify";
import {
  applyApprovedRequestToDaily,
  syncApprovedRequestToCalendar,
  notifyTeamOfApprovedRequest,
} from "@/lib/finalize-approval";
import { getDelegationHours } from "@/lib/approval-resolver";
import { isDelegationElapsed } from "@/lib/approval-inbox";

// 근태 결재(승인/반려)의 판정과 저장 — 단일 정의.
// 웹 결재 PUT(/api/approvals), 챗 결재(/api/internal/approve-request), 위임 자동 마감
// (lib/sweep-delegations)이 모두 이 파일을 쓴다. 결재함 카드의 canApprove 도
// evaluateApprovalRights 로 계산하므로 "화면에 버튼이 보임 = 실제로 처리됨"이 된다.
//
// 규칙:
//  - 결재 가능: pending && 아직 내가 승인 안 함 && 본인 신청 차단 아님
//               && (결재자 목록 포함 || 대리 + 위임 시간 지남 || CEO)
//  - 본인 신청 차단: 신청자 본인이 EMPLOYEE 면 차단 (ADMIN/CEO 는 본인 결재 허용)
//  - 이미 승인한 사람은 승인·반려 모두 불가
//  - 최종 승인: CEO 또는 활성 대리(decisive)이거나 mode any → 즉시 최종,
//               mode all → 결재자 전원이 승인했을 때 최종. 그 전엔 부분 승인(pending 유지).
//  - 동시 처리 보호: 저장은 "읽은 시점과 상태가 같을 때만"(status pending + approvedByIds 일치).
//    어긋나면 conflict — 근태·캘린더·알림 없음.

export type ApprovalRights = {
  isApprover: boolean;
  isDeputyActive: boolean;
  isCeo: boolean;
  iApproved: boolean;
  isSelfBlocked: boolean;
  decisive: boolean;
  canAct: boolean;
};

export function evaluateApprovalRights(
  request: {
    status: string;
    employeeId: number;
    approverIds: number[] | null;
    approvedByIds: number[] | null;
    deputyApproverId: number | null;
    requestedAt: Date;
  },
  viewer: { approverId: number; role: string | null | undefined },
  delegationHours: number
): ApprovalRights {
  const { approverId, role } = viewer;
  const isApprover = (request.approverIds ?? []).includes(approverId);
  const isDeputyActive =
    request.deputyApproverId === approverId &&
    isDelegationElapsed(request.requestedAt, delegationHours);
  const isCeo = role === "ceo";
  const iApproved = (request.approvedByIds ?? []).includes(approverId);
  const isSelfBlocked =
    request.employeeId === approverId && role !== "admin" && role !== "ceo";
  const decisive = isCeo || isDeputyActive;
  const canAct =
    request.status === "pending" &&
    !iApproved &&
    !isSelfBlocked &&
    (isApprover || isDeputyActive || isCeo);
  return { isApprover, isDeputyActive, isCeo, iApproved, isSelfBlocked, decisive, canAct };
}

type FinalizeTarget = {
  id: number;
  employeeId: number;
  categoryId: number;
  startDate: Date;
  endDate: Date;
  correctedCheckIn: Date | null;
  correctedCheckOut: Date | null;
};

// 웹 결재자가 카드에서 고친 캘린더 등록 정보 — 최종 저장(승인·반려)에만 반영.
export type CalendarEdits = {
  calendarSourceId?: number | null;
  calendarEventTitle?: string | null;
  calendarEventDescription?: string | null;
};

// 최종 승인 확정: 상태 저장 + attendance_daily 반영(같은 트랜잭션)
// → 트랜잭션 밖에서 캘린더 등록 · 팀 일정 알림 · 신청자 결과 알림(신청자 = 최종 승인자면 생략).
// expectedApprovedByIds: 읽은 시점의 승인자 목록. 저장 직전과 다르면 conflict.
export async function finalizeApprovedAttendanceRequest(args: {
  request: FinalizeTarget;
  category: { type: string; name: string };
  approverId: number;
  expectedApprovedByIds: number[];
  newApprovedByIds: number[];
  calendarEdits?: CalendarEdits;
  source: string;
}): Promise<
  | { ok: true; appliedDays: number; calendarEventId: string | null }
  | { ok: false; code: "conflict" }
> {
  const { request: t, category, approverId, source } = args;
  const now = new Date();

  const appliedDays = await prisma.$transaction(async (tx) => {
    const upd = await tx.attendanceRequest.updateMany({
      where: {
        id: t.id,
        status: "pending",
        approvedByIds: { equals: args.expectedApprovedByIds },
      },
      data: {
        status: "approved",
        approvedById: approverId,
        approvedAt: now,
        rejectReason: null,
        approvedByIds: args.newApprovedByIds,
        ...(args.calendarEdits ?? {}),
      },
    });
    if (upd.count === 0) return null;

    return applyApprovedRequestToDaily(tx, {
      id: t.id,
      employeeId: t.employeeId,
      categoryId: t.categoryId,
      startDate: t.startDate,
      endDate: t.endDate,
      correctedCheckIn: t.correctedCheckIn,
      correctedCheckOut: t.correctedCheckOut,
      category: { type: category.type, name: category.name },
    });
  });
  if (appliedDays === null) return { ok: false, code: "conflict" };

  // 외부 API 호출은 트랜잭션 밖
  const calendarEventId = await syncApprovedRequestToCalendar(t.id, source);
  await notifyTeamOfApprovedRequest(t.id, source);

  if (t.employeeId !== approverId) {
    try {
      await createNotifications({
        employeeIds: [t.employeeId],
        type: "approval_result",
        title: "결재 승인",
        body: `${category.name} 신청이 승인되었습니다.`,
        linkPage: "request",
        linkRefId: t.id,
        sourceType: "attendance_request",
      });
    } catch (e) {
      console.error(`[notify] 결재 결과 알림 생성 실패 (${source}):`, e);
    }
  }

  return { ok: true, appliedDays, calendarEventId };
}

export type DecideFailureCode =
  | "not_found"
  | "not_pending"
  | "no_permission"
  | "self_request"
  | "already_approved"
  | "category_missing"
  | "conflict";

export type DecideResult =
  | { ok: false; code: DecideFailureCode; message: string }
  | {
      ok: true;
      kind: "partial";
      id: number;
      status: "pending";
      approvedCount: number;
      totalApprovers: number;
    }
  | {
      ok: true;
      kind: "final";
      id: number;
      status: "approved" | "rejected";
      appliedDays: number;
      calendarEventId: string | null;
    };

const FAIL_MESSAGES: Record<DecideFailureCode, string> = {
  not_found: "요청을 찾을 수 없습니다.",
  not_pending: "결재 대기 상태가 아닙니다.",
  no_permission: "이 요청의 결재자로 지정되어 있지 않습니다.",
  self_request: "본인의 신청은 결재할 수 없습니다.",
  already_approved: "이미 승인하셨습니다.",
  category_missing: "카테고리 정보를 찾을 수 없습니다.",
  conflict: "다른 결재가 먼저 처리되었습니다. 새로고침 후 다시 확인하세요.",
};

const fail = (code: DecideFailureCode): DecideResult => ({
  ok: false,
  code,
  message: FAIL_MESSAGES[code],
});

// 근태 신청 1건 승인/반려. approverId 는 항상 호출한 본인(세션·챗 신원)이어야 한다.
// source: 캘린더 동기화·팀 알림 로그 라벨 ("approval" | "internal-approve").
export async function decideAttendanceApproval(args: {
  requestId: number;
  approverId: number;
  role: string | null | undefined;
  action: "approve" | "reject";
  rejectReason?: string | null;
  calendarEdits?: CalendarEdits;
  source: string;
}): Promise<DecideResult> {
  const { requestId, approverId, role, action, source } = args;

  const target = await prisma.attendanceRequest.findUnique({
    where: { id: requestId },
    include: { employee: { select: { departmentId: true } } },
  });
  if (!target) return fail("not_found");
  if (target.status !== "pending") return fail("not_pending");

  const category = await prisma.attendanceCategory.findUnique({
    where: { id: target.categoryId },
  });

  const delegationHours = await getDelegationHours(prisma, {
    departmentId: target.employee?.departmentId ?? null,
    categoryId: target.categoryId,
    categoryCode: category?.code,
  });
  const rights = evaluateApprovalRights(target, { approverId, role }, delegationHours);

  // 권한: 정규 결재자 / 대리(위임 경과) / CEO(상시) 중 하나여야 함
  if (!rights.isApprover && !rights.isDeputyActive && !rights.isCeo) {
    return fail("no_permission");
  }
  if (rights.isSelfBlocked) return fail("self_request");
  if (rights.iApproved) return fail("already_approved");
  if (!category) return fail("category_missing");

  const readApprovedBy = target.approvedByIds ?? [];

  // ── 반려: 즉시 최종, 근태 미반영 ──
  if (action === "reject") {
    const reason = args.rejectReason?.trim() || null;
    const upd = await prisma.attendanceRequest.updateMany({
      where: { id: target.id, status: "pending" },
      data: {
        status: "rejected",
        approvedById: approverId,
        approvedAt: new Date(),
        rejectReason: reason,
        ...(args.calendarEdits ?? {}),
      },
    });
    if (upd.count === 0) return fail("conflict");

    if (target.employeeId !== approverId) {
      try {
        let body = `${category.name} 신청이 반려되었습니다.`;
        if (reason) body += ` (사유: ${reason})`;
        await createNotifications({
          employeeIds: [target.employeeId],
          type: "approval_result",
          title: "결재 반려",
          body,
          linkPage: "request",
          linkRefId: target.id,
          sourceType: "attendance_request",
        });
      } catch (e) {
        console.error(`[notify] 결재 결과 알림 생성 실패 (${source}):`, e);
      }
    }
    return {
      ok: true,
      kind: "final",
      id: target.id,
      status: "rejected",
      appliedDays: 0,
      calendarEventId: null,
    };
  }

  // ── 승인: 부분/최종 판정 ──
  const newApprovedBy = [...readApprovedBy, approverId];
  const fullyApproved =
    rights.decisive ||
    target.approvalMode === "any" ||
    target.approverIds.every((id) => newApprovedBy.includes(id));

  // 부분 승인 → 승인자만 누적, pending 유지. 근태·캘린더·캘린더 수정값 미반영.
  if (!fullyApproved) {
    const upd = await prisma.attendanceRequest.updateMany({
      where: {
        id: target.id,
        status: "pending",
        approvedByIds: { equals: readApprovedBy },
      },
      data: { approvedByIds: newApprovedBy },
    });
    if (upd.count === 0) return fail("conflict");
    return {
      ok: true,
      kind: "partial",
      id: target.id,
      status: "pending",
      approvedCount: newApprovedBy.length,
      totalApprovers: (target.approverIds ?? []).length,
    };
  }

  const fin = await finalizeApprovedAttendanceRequest({
    request: target,
    category,
    approverId,
    expectedApprovedByIds: readApprovedBy,
    newApprovedByIds: newApprovedBy,
    calendarEdits: args.calendarEdits,
    source,
  });
  if (!fin.ok) return fail("conflict");
  return {
    ok: true,
    kind: "final",
    id: target.id,
    status: "approved",
    appliedDays: fin.appliedDays,
    calendarEventId: fin.calendarEventId,
  };
}

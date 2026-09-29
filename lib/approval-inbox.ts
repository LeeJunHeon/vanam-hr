import type { Prisma } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { evaluateApprovalRights } from "@/lib/attendance-approval";

// 결재함 "결재 대기" 범위의 단일 정의.
// 결재함 목록(GET /api/approvals), 출장 결재 권한(PUT /api/approvals kind=trip,
// /api/internal/approve-trip), 대시보드 결재 대기 숫자(/api/dashboard/stats)가
// 모두 이 파일을 쓴다. 범위를 바꿀 땐 여기만 고친다.
//
// 규칙:
//  - 근태·휴가: 본인이 approver_ids 에 포함되거나 대리(deputy)인 pending 신청.
//  - 출장: 초대를 수락한(inviteStatus=accepted) 참여자만 결재 대상. 수락 전·거절한 참여는 제외.
//    참여자별 approver_ids 포함 / deputy. ADMIN 은 approver_ids 가 빈 배열인
//    (결재선 도입 이전) 기존 출장도 폴백으로 본다.
//  - CEO 는 근태·출장 모두 상시 전체 pending.
//  - 내 출장 초대: 본인이 아직 응답하지 않은(invited) 활성 출장 초대.
//  - 근태 결재 카드의 권한·대기자 표시(describeAttendanceApproval)도 여기 한 곳.

export type InboxViewer = {
  /** 결재함 주인(보통 본인) */
  approverId: number;
  /** 조회하는 세션의 role */
  role: string | null | undefined;
};

export function pendingAttendanceWhere(
  v: InboxViewer
): Prisma.AttendanceRequestWhereInput {
  if (v.role === "ceo") return { status: "pending" };
  return {
    status: "pending",
    OR: [
      { approverIds: { has: v.approverId } },
      { deputyApproverId: v.approverId },
    ],
  };
}

// 출장 참여자에 대한 결재 권한 범위 (조회·승인·반려 공용)
export function tripApproverScope(
  v: InboxViewer
): Prisma.TripParticipantWhereInput {
  if (v.role === "ceo") return {};
  return {
    OR: [
      { approverIds: { has: v.approverId } },
      { deputyApproverId: v.approverId },
      ...(v.role === "admin" ? [{ approverIds: { isEmpty: true } }] : []),
    ],
  };
}

export function pendingTripWhere(
  v: InboxViewer
): Prisma.TripParticipantWhereInput {
  return {
    approvalStatus: "pending",
    inviteStatus: "accepted",
    tripEvent: { status: "active" },
    ...tripApproverScope(v),
  };
}

export function myTripInviteWhere(
  employeeId: number
): Prisma.TripParticipantWhereInput {
  return {
    employeeId,
    inviteStatus: "invited",
    tripEvent: { status: "active" },
  };
}

// 결재함 "결재 대기" 탭 카드 수. 출장은 이벤트 1건 = 카드 1장.
export async function countPendingInbox(v: InboxViewer): Promise<{
  attendance: number;
  trip: number;
  invites: number;
  total: number;
}> {
  const [attendance, tripGroups, invites] = await Promise.all([
    prisma.attendanceRequest.count({ where: pendingAttendanceWhere(v) }),
    prisma.tripParticipant.groupBy({
      by: ["tripEventId"],
      where: pendingTripWhere(v),
    }),
    prisma.tripParticipant.count({ where: myTripInviteWhere(v.approverId) }),
  ]);
  const trip = tripGroups.length;
  return { attendance, trip, invites, total: attendance + trip + invites };
}

// ── 근태 결재 카드 상태 ─────────────────────────────────────

// 대리 위임 시간 경과 판정
export function isDelegationElapsed(requestedAt: Date, hours: number): boolean {
  const elapsed = Date.now() - requestedAt.getTime();
  return elapsed >= hours * 60 * 60 * 1000;
}

export function hoursUntilDelegation(requestedAt: Date, hours: number): number {
  const elapsed = Date.now() - requestedAt.getTime();
  const total = hours * 60 * 60 * 1000;
  return Math.max(0, (total - elapsed) / (1000 * 60 * 60));
}

export type AttendanceApprovalView = {
  canApprove: boolean;
  iApproved: boolean;
  myRole: "primary" | "deputy" | null;
  delegated: boolean;
  hoursLeft: number;
  waitingOn: Array<{ id: number; name: string | null }>;
  statusText: string | null;
};

// 근태 결재 카드 1건의 권한·상태. 결재함 GET 과 챗 my-approvals 공용.
// - canApprove 는 실제 결재 처리(decideAttendanceApproval)와 같은 evaluateApprovalRights 로 계산.
// - autoDelegateHours: 신청이 탄 결재선의 위임 시간(lib/approval-resolver getDelegationHours).
// - approverId: 결재함 주인(보통 본인). viewerRole/viewerEmployeeId: 조회하는 세션.
// - waitingOn: mode any → approverIds 전체, all → approverIds 중 아직 승인 안 한 사람.
// - statusText: pending 일 때만. 이름이 세션 본인이면 "나".
export function describeAttendanceApproval(input: {
  request: {
    status: string;
    employeeId: number;
    approverIds: number[] | null;
    approvedByIds: number[] | null;
    approvalMode: string;
    primaryApproverId: number | null;
    deputyApproverId: number | null;
    requestedAt: Date;
  };
  approverId: number;
  viewerRole: string | null | undefined;
  viewerEmployeeId: number | null | undefined;
  autoDelegateHours: number;
  nameMap: Map<number, string>;
}): AttendanceApprovalView {
  const { request: r, approverId, viewerRole, viewerEmployeeId, autoDelegateHours, nameMap } = input;
  const approverIds = r.approverIds ?? [];
  const approvedByIds = r.approvedByIds ?? [];

  const isPrimary = r.primaryApproverId === approverId;
  const isDeputy = r.deputyApproverId === approverId;
  const delegated = isDelegationElapsed(r.requestedAt, autoDelegateHours);
  const hoursLeft = hoursUntilDelegation(r.requestedAt, autoDelegateHours);

  let myRole: "primary" | "deputy" | null = null;
  if (isPrimary) myRole = "primary";
  else if (isDeputy) myRole = "deputy";

  // 결재 가능 여부 = 실제 처리 규칙 (lib/attendance-approval)
  const rights = evaluateApprovalRights(r, { approverId, role: viewerRole }, autoDelegateHours);
  const { isApprover, isCeo, iApproved, isSelfBlocked } = rights;
  const canApprove = rights.canAct;

  const waitingIds =
    r.approvalMode === "any"
      ? approverIds
      : approverIds.filter((id) => !approvedByIds.includes(id));
  const waitingOn = waitingIds.map((id) => ({ id, name: nameMap.get(id) ?? null }));

  let statusText: string | null = null;
  if (r.status === "pending") {
    const label = (w: { id: number; name: string | null }) =>
      w.id === viewerEmployeeId ? "나" : w.name ?? `#${w.id}`;
    const who = waitingOn.map(label).join(", ") || "결재자";
    // 우선순위: 이미 승인 → 본인 신청 차단 → 결재자 → CEO → 대리 → 그 외
    if (iApproved) {
      statusText = `내 승인 완료 · ${who} 결재 대기 중`;
    } else if (isSelfBlocked) {
      // 본인은 결재할 수 없으므로 대기자에서 제외
      const others = waitingOn.filter((w) => w.id !== approverId).map(label).join(", ");
      statusText = others
        ? `본인 신청이라 결재할 수 없음 · ${others} 결재 대기 중`
        : "본인 신청이라 결재할 수 없음";
    } else if (isApprover) {
      // 결재자이면서 대리인 경우도 결재자 규칙 우선
      statusText = `${who} 결재 대기 중`;
    } else if (isCeo) {
      // CEO 가 대리로 지정된 건도 대표 결재 가능 문구 우선
      statusText = `${who} 결재 대기 중 · 대표 결재 가능`;
    } else if (isDeputy) {
      statusText = delegated
        ? `${who} 무응답 · 대리 결재 가능`
        : `${who} 결재 대기 중 · 약 ${Math.ceil(hoursLeft)}시간 후 대리 결재 가능`;
    } else {
      statusText = `${who} 결재 대기 중`;
    }
  }

  return { canApprove, iApproved, myRole, delegated, hoursLeft, waitingOn, statusText };
}

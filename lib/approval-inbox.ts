import type { Prisma } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/prisma";

// 결재함 "결재 대기" 범위의 단일 정의.
// 결재함 목록(GET /api/approvals), 출장 결재 권한(PUT /api/approvals kind=trip,
// /api/internal/approve-trip), 대시보드 결재 대기 숫자(/api/dashboard/stats)가
// 모두 이 파일을 쓴다. 범위를 바꿀 땐 여기만 고친다.
//
// 규칙:
//  - 근태·휴가: 본인이 approver_ids 에 포함되거나 대리(deputy)인 pending 신청.
//  - 출장: 참여자별 approver_ids 포함 / deputy. ADMIN 은 approver_ids 가 빈 배열인
//    (결재선 도입 이전) 기존 출장도 폴백으로 본다.
//  - CEO 는 근태·출장 모두 상시 전체 pending.
//  - 내 출장 초대: 본인이 아직 응답하지 않은(invited) 활성 출장 초대.

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

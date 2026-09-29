import { prisma } from "@/lib/prisma";
import { createDelegationHoursLoader } from "@/lib/approval-resolver";
import {
  isDelegationElapsed,
  finalizeApprovedAttendanceRequest,
} from "@/lib/attendance-approval";

// 대리 위임 자동 마감 스윕 공용 함수.
// 대리결재자가 이미 승인했는데 위임 창(autoDelegateHours, 기본 24h) 경과 시점에
// 자동 확정이 안 되는 구멍을 메운다. 결재함 조회 트리거(B)와 aggregator(A)가 공용으로 호출.

// 조건을 만족하는 pending 요청들을 최종 승인 처리한다. 처리 건수 반환.
export async function sweepEligibleDelegations(): Promise<number> {
  // 1) 후보 조회: pending + 대리결재자 지정된 요청
  const candidates = await prisma.attendanceRequest.findMany({
    where: { status: "pending", deputyApproverId: { not: null } },
    include: {
      category: true,
      employee: { select: { departmentId: true } },
    },
  });

  // 위임 시간 — 신청이 탄 결재선 기준, (부서, 결재 항목) 조합마다 한 번만 조회
  const loadDelegationHours = createDelegationHoursLoader(prisma);
  let finalized = 0;

  for (const req of candidates) {
    // 2) 코드 필터
    // - 대리 승인 확인: 대리결재자가 이미 승인자 목록에 있어야 함
    const deputyId = req.deputyApproverId as number;
    if (!(req.approvedByIds ?? []).includes(deputyId)) continue;

    // - 위임 창 경과 확인
    const h = await loadDelegationHours({
      departmentId: req.employee.departmentId,
      categoryId: req.categoryId,
      categoryCode: req.category.code,
    });
    if (!isDelegationElapsed(req.requestedAt, h)) continue;

    // 3) finalize — 결재 PUT·챗 결재의 최종 승인과 같은 lib/attendance-approval 공용 함수.
    //    상태·승인자 목록이 읽은 시점과 같을 때만 확정(다른 경로가 먼저 처리했으면 conflict → 건너뜀).
    //    캘린더 등록·팀 알림·신청자 결과 알림(본인=대리결재자면 생략)까지 포함.
    try {
      const res = await finalizeApprovedAttendanceRequest({
        request: req,
        category: req.category,
        approverId: deputyId,
        expectedApprovedByIds: req.approvedByIds ?? [],
        newApprovedByIds: req.approvedByIds ?? [],
        source: "sweep-delegation",
      });
      if (!res.ok) continue;
      finalized++;
    } catch (e) {
      // 개별 요청 실패는 로그만 — 다음 요청 계속
      console.error(`[sweep-delegations] finalize 실패 (req=${req.id}):`, e);
    }
  }

  return finalized;
}

import { prisma } from "@/lib/prisma";
import { createNotifications } from "@/lib/notify";
import {
  applyApprovedRequestToDaily,
  syncApprovedRequestToCalendar,
} from "@/lib/finalize-approval";

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
      employee: {
        select: {
          departmentId: true,
          department: {
            select: {
              approvalLines: {
                where: { categoryId: null },
                select: { autoDelegateHours: true },
              },
            },
          },
        },
      },
    },
  });

  let finalized = 0;

  for (const req of candidates) {
    // 2) 코드 필터
    // - 대리 승인 확인: 대리결재자가 이미 승인자 목록에 있어야 함
    const deputyId = req.deputyApproverId as number;
    if (!(req.approvedByIds ?? []).includes(deputyId)) continue;

    // - 위임 창 경과 확인
    const h = req.employee.department?.approvalLines?.[0]?.autoDelegateHours ?? 24;
    if (Date.now() - req.requestedAt.getTime() < h * 3600 * 1000) continue;

    // 3) finalize — approvals PUT "최종 승인"과 동일하게(트랜잭션)
    try {
      const now = new Date();
      const category = req.category;

      const didFinalize = await prisma.$transaction(async (tx) => {
        // 동시성 방어: 여전히 pending일 때만 확정(다른 경로가 먼저 확정했으면 count 0).
        const upd = await tx.attendanceRequest.updateMany({
          where: { id: req.id, status: "pending" },
          data: {
            status: "approved",
            approvedById: deputyId,
            approvedAt: now,
            rejectReason: null,
          },
        });
        if (upd.count === 0) return false;

        await applyApprovedRequestToDaily(tx, {
          id: req.id,
          employeeId: req.employeeId,
          categoryId: req.categoryId,
          startDate: req.startDate,
          endDate: req.endDate,
          correctedCheckIn: req.correctedCheckIn,
          correctedCheckOut: req.correctedCheckOut,
          category: { type: category.type, name: category.name },
        });
        return true;
      });

      // 이미 다른 경로에서 확정됐으면 알림/카운트 없이 다음으로.
      if (!didFinalize) continue;

      // 캘린더 등록 (트랜잭션 밖). approvals 경로와 동일 — 여기 빠져 있어서
      // 대리 24h 자동마감 건이 캘린더에 반영되지 않던 버그 수정(2026-09).
      await syncApprovedRequestToCalendar(req.id, "sweep-delegation");

      // 결재 결과 알림 (신청자에게). 본인=대리결재자면 스킵.
      if (req.employeeId !== deputyId) {
        try {
          await createNotifications({
            employeeIds: [req.employeeId],
            type: "approval_result",
            title: "결재 승인",
            body: `${req.category.name} 신청이 승인되었습니다.`,
            linkPage: "request",
            linkRefId: req.id,
            sourceType: "attendance_request",
          });
        } catch (e) {
          console.error(`[sweep-delegations] 알림 생성 실패 (req=${req.id}):`, e);
        }
      }

      finalized++;
    } catch (e) {
      // 개별 요청 실패는 로그만 — 다음 요청 계속
      console.error(`[sweep-delegations] finalize 실패 (req=${req.id}):`, e);
    }
  }

  return finalized;
}

import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/app/generated/prisma/client";

// 직원의 부서 결재선을 계산한다.
// - 부서에 approval_line이 있으면 그 approverIds/approvalMode/deputyApproverId.
// - 없으면 fallback 결재자(policy_settings.fallback_approver_employee_id) 단독, mode='any'.
// - 둘 다 없으면 approverIds=[] (호출부에서 "결재자 없음" 처리).
// attendance-requests의 결재선 결정과 동일 규칙 — 출장/일반 결재가 공유.
//
// 규칙: 신청자 본인은 결재자가 될 수 없다(자기결재 차단).
//   excludeEmployeeId를 넘기면 라인 결정이 끝난 뒤 결과에서만 본인을 제거한다.
//   - 라인 결정 순서((부서+카테고리) → 부서 기본 → fallback)와 approvalMode는 영향 없음.
//   - excludeEmployeeId=null(기본)이면 기존과 100% 동일하게 동작한다(하위호환).
//   - excludedSelf: 원본 결재선에 본인이 있었는지. 호출부가 "원래 결재선은 있었는데
//     본인 제외로 0명이 됐다"를 "애초에 결재자가 없다"와 구분하는 데 쓴다.
export async function resolveApprovers(
  db: Prisma.TransactionClient | typeof prisma,
  departmentId: number | null,
  categoryId: number | null = null,
  excludeEmployeeId: number | null = null
): Promise<{
  approverIds: number[];
  approvalMode: "all" | "any";
  deputyApproverId: number | null;
  excludedSelf: boolean;
}> {
  let approverIds: number[] = [];
  let approvalMode: "all" | "any" = "all";
  let deputyApproverId: number | null = null;

  let line = null;
  if (departmentId !== null) {
    // 1순위: (부서 + 카테고리) 항목별 라인
    line = await db.approvalLine.findFirst({
      where: { departmentId, categoryId },
    });
    // 2순위: 항목별 라인이 없으면 부서 기본 라인(category_id NULL)
    if (!line && categoryId !== null) {
      line = await db.approvalLine.findFirst({
        where: { departmentId, categoryId: null },
      });
    }
  }
  if (line && Array.isArray(line.approverIds) && line.approverIds.length > 0) {
    approverIds = line.approverIds;
    approvalMode = line.approvalMode === "any" ? "any" : "all";
    deputyApproverId = line.deputyApproverId;
  } else {
    const fb = await db.policySetting.findUnique({
      where: { key: "fallback_approver_employee_id" },
    });
    const fbId = fb ? Number(fb.value) : NaN;
    if (Number.isInteger(fbId)) {
      approverIds = [fbId];
      approvalMode = "any";
    }
  }
  // ── 결과에만 적용: 신청자 본인 제외 (라인 결정 로직은 위에서 이미 끝났다) ──
  if (excludeEmployeeId === null) {
    return { approverIds, approvalMode, deputyApproverId, excludedSelf: false };
  }
  const excludedSelf = approverIds.includes(excludeEmployeeId);
  return {
    approverIds: approverIds.filter((id) => id !== excludeEmployeeId),
    approvalMode,
    deputyApproverId:
      deputyApproverId === excludeEmployeeId ? null : deputyApproverId,
    excludedSelf,
  };
}

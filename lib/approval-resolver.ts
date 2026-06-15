import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/app/generated/prisma/client";

// 직원의 부서 결재선을 계산한다.
// - 부서에 approval_line이 있으면 그 approverIds/approvalMode/deputyApproverId.
// - 없으면 fallback 결재자(policy_settings.fallback_approver_employee_id) 단독, mode='any'.
// - 둘 다 없으면 approverIds=[] (호출부에서 "결재자 없음" 처리).
// attendance-requests의 결재선 결정과 동일 규칙 — 출장/일반 결재가 공유.
export async function resolveApprovers(
  db: Prisma.TransactionClient | typeof prisma,
  departmentId: number | null
): Promise<{
  approverIds: number[];
  approvalMode: "all" | "any";
  deputyApproverId: number | null;
}> {
  let approverIds: number[] = [];
  let approvalMode: "all" | "any" = "all";
  let deputyApproverId: number | null = null;

  let line = null;
  if (departmentId !== null) {
    line = await db.approvalLine.findUnique({
      where: { departmentId },
    });
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
  return { approverIds, approvalMode, deputyApproverId };
}

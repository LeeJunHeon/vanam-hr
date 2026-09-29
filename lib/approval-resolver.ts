import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/app/generated/prisma/client";
import { getBusinessTripCategoryId } from "@/lib/trip-calendar";

type Db = Prisma.TransactionClient | typeof prisma;

// 신청이 타는 결재선 찾기: 1순위 (부서 + 결재 항목) 라인 → 2순위 부서 기본 라인(category_id NULL).
// resolveApprovers(결재자 배정)와 getDelegationHours(대리 위임 시간)가 같은 규칙을 쓴다.
export async function findApprovalLine(
  db: Db,
  departmentId: number,
  categoryId: number | null
) {
  const line = await db.approvalLine.findFirst({
    where: { departmentId, categoryId },
  });
  if (line || categoryId === null) return line;
  return db.approvalLine.findFirst({
    where: { departmentId, categoryId: null },
  });
}

// 결재선 기준 항목 id. 외근(EXTERNAL_WORK)은 '출장 및 외근'(BUSINESS_TRIP) 결재선을 공유한다.
export async function getApprovalCategoryId(category: {
  id: number;
  code: string | null | undefined;
}): Promise<number | null> {
  if (category.code === "EXTERNAL_WORK") return getBusinessTripCategoryId();
  return category.id;
}

// 대리 위임 시간(시간 단위): 신청이 탄 결재선(항목 라인 → 부서 기본 라인)의 autoDelegateHours.
// 부서가 없거나 라인이 없으면 24.
export async function getDelegationHours(
  db: Db,
  args: { departmentId: number | null; categoryId: number; categoryCode: string | null | undefined }
): Promise<number> {
  if (args.departmentId === null) return 24;
  const approvalCategoryId = await getApprovalCategoryId({
    id: args.categoryId,
    code: args.categoryCode,
  });
  const line = await findApprovalLine(db, args.departmentId, approvalCategoryId);
  return line?.autoDelegateHours ?? 24;
}

// 목록 조회용: 한 요청 안에서 (부서, 결재 항목) 조합마다 한 번만 getDelegationHours 를 조회한다.
export function createDelegationHoursLoader(db: Db) {
  const cache = new Map<string, Promise<number>>();
  return async (args: {
    departmentId: number | null;
    categoryId: number;
    categoryCode: string | null | undefined;
  }): Promise<number> => {
    if (args.departmentId === null) return 24;
    const approvalCategoryId = await getApprovalCategoryId({
      id: args.categoryId,
      code: args.categoryCode,
    });
    const key = `${args.departmentId}:${approvalCategoryId}`;
    let hit = cache.get(key);
    if (!hit) {
      hit = findApprovalLine(db, args.departmentId, approvalCategoryId).then(
        (line) => line?.autoDelegateHours ?? 24
      );
      cache.set(key, hit);
    }
    return hit;
  };
}

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
  db: Db,
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

  const line =
    departmentId !== null ? await findApprovalLine(db, departmentId, categoryId) : null;
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

// 출장 참여자의 결재선 — 참여 확정 시점(self-join / 웹 초대 수락 / 챗 초대 수락) 공용.
// 참여자 부서의 '출장 및 외근'(BUSINESS_TRIP) 항목 라인 → 없으면 부서 기본 라인 → fallback.
// 참여자 본인은 결재선에서 제외. 결과가 0명이면 notRequired(결재 불성립 → not_required 로 승격).
export async function resolveTripParticipantApprovers(employeeId: number): Promise<{
  approverIds: number[];
  approvalMode: "all" | "any";
  deputyApproverId: number | null;
  notRequired: boolean;
}> {
  const emp = await prisma.employee.findUnique({
    where: { id: employeeId },
    select: { departmentId: true },
  });
  const resolved = await resolveApprovers(
    prisma,
    emp?.departmentId ?? null,
    await getBusinessTripCategoryId(),
    employeeId
  );
  return {
    approverIds: resolved.approverIds,
    approvalMode: resolved.approvalMode,
    deputyApproverId: resolved.deputyApproverId,
    notRequired: resolved.approverIds.length === 0,
  };
}

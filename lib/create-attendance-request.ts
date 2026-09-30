import type { Prisma } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { createNotifications } from "@/lib/notify";
import { loadShiftAndGrace, shiftEndBoundary } from "@/lib/attendance-correction";
import {
  applyApprovedRequestToDaily,
  syncApprovedRequestToCalendar,
  notifyTeamOfApprovedRequest,
} from "@/lib/finalize-approval";
import { checkLeaveRequest } from "@/lib/annual-leave";
import { resolveApprovers, getApprovalCategoryId } from "@/lib/approval-resolver";

// ─────────────────────────────────────────────────────────────
// 근태 신청 규칙 — 신청(웹·챗)·결재 대기 중 수정·신청 화면 안내가 모두 이 파일의 함수를 쓴다.
//   validateAttendanceRequestInput  신청 검사 (날짜·직원·항목·연차 잔여·정정 규칙·시간 규칙)
//   decideApprovalRoute             결재선 결정 (자동승인 여부·이유, 결재자)
//   applyAutoApprovalInTx / runAutoApprovalSideEffects  자동승인 후처리
// ─────────────────────────────────────────────────────────────

function parseDate(s: string | null | undefined): Date | null {
  if (!s || typeof s !== "string") return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(s + "T00:00:00.000Z");
  return isNaN(d.getTime()) ? null : d;
}

function ymdFromDate(d: Date): string {
  return d.toISOString().split("T")[0];
}

// category.type → requestType 매핑
export function categoryTypeToRequestType(categoryType: string): string {
  if (categoryType === "correction") return "correction";
  if (categoryType === "work") return "external_work";
  // leave, long_leave, 기타
  return "leave";
}

type Fail = { ok: false; error: string; status: number };

export type AttendanceRequestInput = {
  employeeId: number;
  categoryId: number;
  startDate: string;
  endDate: string;
  correctedCheckIn?: string | null;
  correctedCheckOut?: string | null;
};

const employeeWithPosition = {
  include: { position: { select: { code: true } } },
} satisfies Prisma.EmployeeDefaultArgs;
export type RequestEmployee = Prisma.EmployeeGetPayload<typeof employeeWithPosition>;
export type RequestCategory = NonNullable<
  Awaited<ReturnType<typeof prisma.attendanceCategory.findUnique>>
>;

export type ValidatedAttendanceRequest = {
  ok: true;
  startD: Date;
  endD: Date;
  cciDate: Date | null;
  ccoDate: Date | null;
  reqType: string;
  emp: RequestEmployee;
  category: RequestCategory;
};

/**
 * 근태 신청 검사 — 신청(웹·챗)과 결재 대기 중 수정이 같이 쓴다.
 * excludeRequestId: 수정 중인 신청 id. 연차 잔여의 결재 대기 합계에서 자기 자신을 뺀다.
 */
export async function validateAttendanceRequestInput(
  input: AttendanceRequestInput,
  opts: { excludeRequestId?: number } = {}
): Promise<ValidatedAttendanceRequest | Fail> {
  const employeeIdNum = input.employeeId;
  const categoryIdNum = input.categoryId;
  const { startDate, endDate, correctedCheckIn, correctedCheckOut } = input;

  const startD = parseDate(startDate);
  const endD = parseDate(endDate);
  if (!startD || !endD) {
    return { ok: false, error: "startDate, endDate 형식이 잘못되었습니다 (YYYY-MM-DD).", status: 400 };
  }
  if (endD < startD) {
    return { ok: false, error: "종료일은 시작일 이후여야 합니다.", status: 400 };
  }

  // 직원 활성 검증
  const emp = await prisma.employee.findUnique({
    where: { id: employeeIdNum },
    ...employeeWithPosition,
  });
  if (!emp || !emp.isActive) {
    return { ok: false, error: "활성 직원이 아닙니다.", status: 400 };
  }

  // 카테고리 활성 검증
  const category = await prisma.attendanceCategory.findUnique({
    where: { id: categoryIdNum },
  });
  if (!category || !category.isActive) {
    return { ok: false, error: "활성 근태 항목이 아닙니다.", status: 400 };
  }

  const reqType = categoryTypeToRequestType(category.type);

  // ── 연차 잔여 검증 (annualLeaveDeduct > 0인 카테고리만) ──
  // 연도별로 "이번 차감량 ≤ 신청 가능(잔여 − 결재 대기)". 부여 0 이어도 같은 검사.
  const deductPerDay = category.annualLeaveDeduct
    ? Number(category.annualLeaveDeduct)
    : 0;
  if (deductPerDay > 0) {
    const check = await checkLeaveRequest(employeeIdNum, startD, endD, deductPerDay, {
      excludeRequestId: opts.excludeRequestId,
    });
    if (!check.ok) {
      return { ok: false, error: check.message ?? "연차 잔여가 부족합니다.", status: 400 };
    }
  }

  // correction 타입은 정정 시각 필수
  let cciDate: Date | null = null;
  let ccoDate: Date | null = null;
  if (reqType === "correction") {
    // 단일 날짜 강제
    if (ymdFromDate(startD) !== ymdFromDate(endD)) {
      return { ok: false, error: "근태정정은 단일 날짜만 가능합니다.", status: 400 };
    }
    // 한쪽 이상 필수
    if (!correctedCheckIn && !correctedCheckOut) {
      return { ok: false, error: "정정 출근 시각과 정정 퇴근 시각 중 하나 이상 입력하세요.", status: 400 };
    }
    if (correctedCheckIn) {
      cciDate = new Date(correctedCheckIn);
      if (isNaN(cciDate.getTime())) {
        return { ok: false, error: "정정 출근 시각 형식이 잘못되었습니다.", status: 400 };
      }
    }
    if (correctedCheckOut) {
      ccoDate = new Date(correctedCheckOut);
      if (isNaN(ccoDate.getTime())) {
        return { ok: false, error: "정정 퇴근 시각 형식이 잘못되었습니다.", status: 400 };
      }
    }
    // 둘 다 있을 때만 순서 비교
    if (cciDate && ccoDate && ccoDate <= cciDate) {
      return { ok: false, error: "정정 퇴근 시각은 정정 출근 시각 이후여야 합니다.", status: 400 };
    }
    // 규칙 A — 정정은 이미 지난 일을 고치는 행위다. 미래 시각은 오전/오후 착오다.
    // (2026-09-23 사례: 13:46 에 09:00 대신 21:00 으로 신청 → 즉시 승인)
    const now = new Date();
    if (cciDate && cciDate > now) {
      return {
        ok: false,
        error: "정정 출근 시각이 현재 시각보다 미래입니다. 오전/오후를 확인해주세요.",
        status: 400,
      };
    }
    if (ccoDate && ccoDate > now) {
      return {
        ok: false,
        error: "정정 퇴근 시각이 현재 시각보다 미래입니다. 오전/오후를 확인해주세요.",
        status: 400,
      };
    }
    // 규칙 B — 출근 정정이 그날 근무 종료 시각을 넘을 수는 없다.
    // 퇴근 정정에는 적용하지 않는다(야근 후 퇴근 정정은 정상).
    if (cciDate) {
      const { shiftStartHHMM, shiftEndHHMM } = await loadShiftAndGrace(
        prisma,
        employeeIdNum,
        startD
      );
      const endBoundary = shiftEndBoundary(cciDate, shiftStartHHMM, shiftEndHHMM);
      if (endBoundary && cciDate > endBoundary) {
        return {
          ok: false,
          error:
            `정정 출근 시각이 해당 일자의 근무 종료 시각(${shiftEndHHMM}) 이후입니다. ` +
            "오전/오후를 확인해주세요.",
          status: 400,
        };
      }
    }

    // 한쪽만 정정하는 경우 반대쪽은 기존 attendance_daily 값과 병합된다.
    // 병합된 최종값이 역전이면 work_minutes가 음수가 되므로 여기서 막는다.
    // (2026-07-24 사례: 출근만 21:00으로 정정 → 기존 퇴근 14:36과 합쳐져 -384분)
    if (!cciDate || !ccoDate) {
      const existingDaily = await prisma.attendanceDaily.findUnique({
        where: {
          employeeId_workDate: { employeeId: employeeIdNum, workDate: startD },
        },
        select: { checkIn: true, checkOut: true },
      });
      const finalIn = cciDate ?? existingDaily?.checkIn ?? null;
      const finalOut = ccoDate ?? existingDaily?.checkOut ?? null;
      if (finalIn && finalOut && finalOut <= finalIn) {
        return {
          ok: false,
          error:
            "기존 근태 기록과 합치면 퇴근 시각이 출근 시각보다 빠릅니다. " +
            "출근과 퇴근을 함께 정정해주세요.",
          status: 400,
        };
      }
    }
  } else {
    // Phase 6-2F: 정정 외 카테고리(휴가/외근/출장/재택/기타)
    // — correctedCheckIn/Out이 둘 다 비어 있으면 종일 (NULL).
    // — 채워져 있으면 클라이언트가 startDate+HH:MM / endDate+HH:MM ISO로 전송.
    // — 다일 일정 시간 지정 가능 (예: "6/3 13:00 ~ 6/5 17:00").

    // Phase 6-2G: 한쪽만 시간 입력 차단
    const cciFilled = !!correctedCheckIn;
    const ccoFilled = !!correctedCheckOut;
    if (cciFilled !== ccoFilled) {
      return { ok: false, error: "시작 시간과 종료 시간 중 하나만 입력할 수 없습니다. 모두 입력하거나 모두 비워주세요.", status: 400 };
    }

    if (correctedCheckIn) {
      cciDate = new Date(correctedCheckIn);
      if (isNaN(cciDate.getTime())) {
        return { ok: false, error: "시작 시간 형식이 올바르지 않습니다.", status: 400 };
      }
    }
    if (correctedCheckOut) {
      ccoDate = new Date(correctedCheckOut);
      if (isNaN(ccoDate.getTime())) {
        return { ok: false, error: "종료 시간 형식이 올바르지 않습니다.", status: 400 };
      }
    }
    // 둘 다 있으면 종료 >= 시작 검증
    if (cciDate && ccoDate && ccoDate < cciDate) {
      return { ok: false, error: "종료 시간은 시작 시간 이후여야 합니다.", status: 400 };
    }
  }

  return { ok: true, startD, endD, cciDate, ccoDate, reqType, emp, category };
}

export type AutoApproveReason =
  | "ceo"
  | "admin_external"
  | "no_approval_needed"
  | "self_approval";

export type ApprovalRoute = {
  ok: true;
  autoApprove: boolean;
  autoReason: AutoApproveReason | null;
  approverIds: number[];
  approvalMode: "all" | "any";
  primaryApproverId: number | null;
  deputyApproverId: number | null;
};

export const NO_APPROVER_ERROR =
  "결재자를 찾을 수 없습니다. 관리자에게 결재선 또는 대체 결재자(fallback) 설정을 요청하세요.";

/**
 * 결재선 결정 — 항상 신청자(직원) 기준. 신청·수정·신청 화면 안내가 같이 쓴다.
 * 정책: CEO는 자동승인. ADMIN은 외근(EXTERNAL_WORK)만 자동승인이고, 그 외(휴가/재택/정정 등)는
 *       EMPLOYEE와 동일하게 부서 결재선(없으면 fallback)을 거친다.
 */
export async function decideApprovalRoute(
  emp: { id: number; departmentId: number | null; position: { code: string } | null },
  category: { id: number; code: string; requireApproval: boolean }
): Promise<ApprovalRoute | Fail> {
  const isCeoRequester = emp.position?.code === "CEO";
  const isAdminRequester = emp.position?.code === "ADMIN";

  // 외근이면 ADMIN 자동승인 유지(예외). 그 외 카테고리는 ADMIN도 결재선을 탄다.
  const isExternalWork = category.code === "EXTERNAL_WORK";
  const adminAutoApprove = isAdminRequester && isExternalWork;

  let approverIds: number[] = [];
  let approvalMode: "all" | "any" = "all";
  let deputyApproverId: number | null = null; // 호환용 컬럼
  // 자기결재 여부. resolveApprovers를 타지 않는 분기(CEO/ADMIN 외근)에선 false 유지.
  let isSelfApproval = false;

  // 결재선을 타는 대상: CEO 아님 + (ADMIN이면서 외근)도 아님
  //  → EMPLOYEE 전부, 그리고 "외근이 아닌 ADMIN"이 여기에 해당.
  if (!isCeoRequester && !adminAutoApprove) {
    // 외근/출장은 '출장 및 외근'(BUSINESS_TRIP) 결재선을 공유 → 외근이면 출장 categoryId로 정규화
    const approvalCategoryId = await getApprovalCategoryId({
      id: category.id,
      code: category.code,
    });
    // 결재선 결정을 resolveApprovers로 통일: (부서+카테고리) 항목별 라인 → 부서 기본 → fallback
    // 신청자 본인은 결재자가 될 수 없다 → resolveApprovers가 결과에서 제외해준다.
    const resolved = await resolveApprovers(
      prisma,
      emp.departmentId,
      approvalCategoryId,
      emp.id
    );
    approverIds = resolved.approverIds;
    approvalMode = resolved.approvalMode;
    deputyApproverId = resolved.deputyApproverId;

    // 본인 제외 후 결재자가 남지 않으면 자기결재 → 자동승인
    //  - 예: fallback이 LEE인데 신청자도 LEE면 원본 [LEE] → 제외 후 [] → 자기결재.
    //  - 원래 결재선이 비어 있던 경우(excludedSelf=false)는 자기결재가 아니라
    //    "결재자 없음"이므로 아래 가드에서 차단된다.
    isSelfApproval = resolved.excludedSelf && approverIds.length === 0;
  }

  const autoReason: AutoApproveReason | null = isCeoRequester
    ? "ceo"
    : adminAutoApprove
    ? "admin_external"
    : !category.requireApproval
    ? "no_approval_needed"
    : isSelfApproval
    ? "self_approval"
    : null;
  const autoApprove = autoReason !== null;

  // 결재 필요한데 결재자를 못 찾으면 차단
  if (!autoApprove && approverIds.length === 0) {
    return { ok: false, error: NO_APPROVER_ERROR, status: 400 };
  }

  return {
    ok: true,
    autoApprove,
    autoReason,
    approverIds,
    approvalMode,
    primaryApproverId: approverIds.length > 0 ? approverIds[0] : null,
    deputyApproverId,
  };
}

// 결재선 필드 — 자동승인이면 신청과 같게 비운다(approvalMode 는 계산값 그대로 저장).
export function approvalRouteFields(route: ApprovalRoute) {
  return {
    approverIds: route.autoApprove ? [] : route.approverIds,
    approvalMode: route.approvalMode,
    primaryApproverId: route.autoApprove ? null : route.primaryApproverId, // 호환
    deputyApproverId: route.autoApprove ? null : route.deputyApproverId, // 호환
  };
}

/**
 * 자동승인 후처리 (1) — 근태 반영. **트랜잭션 안에서** 호출할 것.
 * type 과 무관하게 결재자 승인과 같은 applyApprovedRequestToDaily 를 쓴다
 * (지난 날은 재계산 표시, 오늘·앞날은 기록, 정정은 정정 반영).
 */
export async function applyAutoApprovalInTx(
  tx: Prisma.TransactionClient,
  req: {
    id: number;
    employeeId: number;
    categoryId: number;
    startDate: Date;
    endDate: Date;
    correctedCheckIn: Date | null;
    correctedCheckOut: Date | null;
  },
  category: { type: string; name: string }
): Promise<number> {
  return applyApprovedRequestToDaily(tx, {
    ...req,
    category: { type: category.type, name: category.name },
  });
}

/**
 * 자동승인 후처리 (2) — 캘린더 등록 + 팀 일정 알림. **트랜잭션 밖에서** 호출할 것.
 * 둘 다 실패해도 신청은 유지된다.
 */
export async function runAutoApprovalSideEffects(
  requestId: number,
  logTag: string = "create-attendance-request"
): Promise<void> {
  await syncApprovedRequestToCalendar(requestId, logTag);
  await notifyTeamOfApprovedRequest(requestId, logTag);
}

export type CreateAttendanceRequestInput = AttendanceRequestInput & {
  reason?: string | null;
  calendarSourceId?: string | number | null;
  calendarEventTitle?: string | null;
  calendarEventDescription?: string | null;
};
export type CreateAttendanceRequestResult =
  | { ok: true; id: number; status: string }
  | { ok: false; error: string; status: number };

export async function createAttendanceRequest(
  input: CreateAttendanceRequestInput
): Promise<CreateAttendanceRequestResult> {
  const { reason, calendarSourceId, calendarEventTitle, calendarEventDescription } = input;

  const v = await validateAttendanceRequestInput(input);
  if (!v.ok) return v;
  const { startD, endD, cciDate, ccoDate, reqType, emp, category } = v;

  const route = await decideApprovalRoute(emp, category);
  if (!route.ok) return route;
  const isAutoApproved = route.autoApprove;

  const now = new Date();

  const created = await prisma.$transaction(async (tx) => {
    const req = await tx.attendanceRequest.create({
      data: {
        employeeId: emp.id,
        categoryId: category.id,
        requestType: reqType,
        startDate: startD,
        endDate: endD,
        reason: reason?.trim() || null,
        correctedCheckIn: cciDate,
        correctedCheckOut: ccoDate,
        status: isAutoApproved ? "auto_approved" : "pending",
        ...approvalRouteFields(route),
        approvedByIds: [],
        approvedAt: isAutoApproved ? now : null,
        // Phase 6-2E 캘린더 등록 정보 (NULL 허용)
        calendarSourceId:
          calendarSourceId != null && calendarSourceId !== ""
            ? Number(calendarSourceId)
            : null,
        calendarEventTitle: calendarEventTitle?.trim() || null,
        calendarEventDescription: calendarEventDescription?.trim() || null,
      },
    });

    // 자동승인이면 결재자 승인과 같은 함수로 attendance_daily 에 반영
    // (일반 승인은 결재 경로에서 처리되지만, 자동승인은 여기서 처리해야 누락 안 됨)
    if (isAutoApproved) {
      await applyAutoApprovalInTx(tx, req, category);
    }

    return req;
  });

  // 자동승인 → 캘린더 등록 + 팀 일정 알림 (트랜잭션 밖, 실패해도 신청 유지)
  if (isAutoApproved) {
    await runAutoApprovalSideEffects(created.id, "create-attendance-request");
  }

  // 결재 요청 알림 — 자동승인이 아니고 결재자가 있을 때만
  if (!isAutoApproved && route.approverIds.length > 0) {
    try {
      await createNotifications({
        employeeIds: route.approverIds,
        type: "approval_request",
        title: "새 결재 요청",
        body: `${emp.name ?? "직원"}님의 ${category.name} 결재 요청`,
        linkPage: "approval",
        linkRefId: created.id,
        sourceType: "attendance_request",
      });
    } catch (e) {
      console.error("[notify] 결재 요청 알림 생성 실패:", e);
    }
  }

  return { ok: true, id: created.id, status: created.status };
}

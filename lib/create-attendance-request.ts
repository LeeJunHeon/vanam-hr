import { prisma } from "@/lib/prisma";
import { createNotifications } from "@/lib/notify";
import { applyCorrectionToDaily } from "@/lib/attendance-correction";
import { getRemainingDays } from "@/lib/annual-leave";

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
function categoryTypeToRequestType(categoryType: string): string {
  if (categoryType === "correction") return "correction";
  if (categoryType === "work") return "external_work";
  // leave, long_leave, 기타
  return "leave";
}

export type CreateAttendanceRequestInput = {
  employeeId: number;
  categoryId: number;
  startDate: string;
  endDate: string;
  reason?: string | null;
  correctedCheckIn?: string | null;
  correctedCheckOut?: string | null;
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
  const employeeIdNum = input.employeeId;
  const categoryIdNum = input.categoryId;
  const {
    startDate, endDate, reason,
    correctedCheckIn, correctedCheckOut,
    calendarSourceId, calendarEventTitle, calendarEventDescription,
  } = input;

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
    include: { position: { select: { code: true } } },
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
  // 연차/반차 등 차감 대상이면, 이번 신청량이 잔여를 넘는지 확인.
  const deductPerDay = category.annualLeaveDeduct
    ? Number(category.annualLeaveDeduct)
    : 0;
  if (deductPerDay > 0) {
    // 신청 일수 (startDate~endDate 양끝 포함)
    const reqDays =
      Math.floor((endD.getTime() - startD.getTime()) / 86400000) + 1;
    const requestAmount = reqDays * deductPerDay;
    // 신청 시작 연도 기준 잔여 (역년)
    const reqYear = startD.getUTCFullYear();
    const { granted, remaining } = await getRemainingDays(
      employeeIdNum,
      reqYear
    );
    // 부여가 0인데 차감 신청이면(정책 미설정 등) 막지 않고 통과시킬지 결정:
    // 여기서는 granted=0이면 "부여 정보 없음"으로 보고 통과(차단 안 함).
    // 단, granted>0이면 잔여 검증.
    if (granted > 0 && requestAmount > remaining) {
      return { ok: false, error: `연차 잔여가 부족합니다. (신청 ${requestAmount}일 / 잔여 ${remaining.toFixed(1)}일)`, status: 400 };
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

  // 결재선 결정 (다중 결재자 + 모드 + fallback)
  // 정책: CEO는 자동승인. ADMIN은 외근(EXTERNAL_WORK)만 자동승인이고, 그 외(휴가/재택/정정 등)는
  //       EMPLOYEE와 동일하게 부서 결재선(없으면 fallback)을 거친다.
  const isCeoRequester = emp.position?.code === "CEO";
  const isAdminRequester = emp.position?.code === "ADMIN";

  // 외근이면 ADMIN 자동승인 유지(예외). 그 외 카테고리는 ADMIN도 결재선을 탄다.
  const isExternalWork = category.code === "EXTERNAL_WORK";
  const adminAutoApprove = isAdminRequester && isExternalWork;

  let approverIds: number[] = [];
  let approvalMode: "all" | "any" = "all";
  let primaryApproverId: number | null = null; // 호환용 컬럼
  let deputyApproverId: number | null = null; // 호환용 컬럼

  // 결재선을 타는 대상: CEO 아님 + (ADMIN이면서 외근)도 아님
  //  → EMPLOYEE 전부, 그리고 "외근이 아닌 ADMIN"이 여기에 해당.
  if (!isCeoRequester && !adminAutoApprove) {
    let line = null;
    if (emp.departmentId !== null) {
      line = await prisma.approvalLine.findUnique({
        where: { departmentId: emp.departmentId },
      });
    }
    if (line && Array.isArray(line.approverIds) && line.approverIds.length > 0) {
      approverIds = line.approverIds;
      approvalMode = line.approvalMode === "any" ? "any" : "all";
      deputyApproverId = line.deputyApproverId; // 호환 유지
    } else {
      // 부서 결재선이 없으면 fallback 결재자(policy_settings) 단독
      const fb = await prisma.policySetting.findUnique({
        where: { key: "fallback_approver_employee_id" },
      });
      const fbId = fb ? Number(fb.value) : NaN;
      if (Number.isInteger(fbId)) {
        approverIds = [fbId];
        approvalMode = "any";
      }
    }
    primaryApproverId = approverIds.length > 0 ? approverIds[0] : null;
  }

  // 자기결재 여부: 결재자가 본인뿐이면(자기가 자기를 결재) 자동승인 처리.
  //  - 예: fallback이 LEE인데 신청자도 LEE면 approverIds=[LEE], 신청자=LEE → 자기결재.
  //  - 자기결재는 형식상 의미 없으므로 자동승인하되, 신청 기록(attendance_request)은 남는다.
  const isSelfApproval =
    approverIds.length > 0 &&
    approverIds.every((id) => id === employeeIdNum);

  // 자동승인 조건:
  //  - CEO 신청
  //  - ADMIN의 외근(adminAutoApprove)
  //  - 카테고리가 결재 불필요(requireApproval=false)
  //  - 자기결재(isSelfApproval)
  const isAutoApproved =
    isCeoRequester ||
    adminAutoApprove ||
    !category.requireApproval ||
    isSelfApproval;

  // 결재 필요한데 결재자를 못 찾으면 차단
  if (!isAutoApproved && approverIds.length === 0) {
    return { ok: false, error: "결재자를 찾을 수 없습니다. 관리자에게 결재선 또는 대체 결재자(fallback) 설정을 요청하세요.", status: 400 };
  }

  const now = new Date();

  const created = await prisma.$transaction(async (tx) => {
    const req = await tx.attendanceRequest.create({
      data: {
        employeeId: employeeIdNum,
        categoryId: categoryIdNum,
        requestType: reqType,
        startDate: startD,
        endDate: endD,
        reason: reason?.trim() || null,
        correctedCheckIn: cciDate,
        correctedCheckOut: ccoDate,
        status: isAutoApproved ? "auto_approved" : "pending",
        approverIds: isAutoApproved ? [] : approverIds,
        approvalMode,
        approvedByIds: [],
        primaryApproverId: isAutoApproved ? null : primaryApproverId, // 호환
        deputyApproverId: isAutoApproved ? null : deputyApproverId, // 호환
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

    // 자동승인 + 정정(correction)이면 attendance_daily에 즉시 반영
    // (일반 승인은 approvals에서 처리되지만, 자동승인은 여기서 처리해야 누락 안 됨)
    if (isAutoApproved && category.type === "correction") {
      await applyCorrectionToDaily(tx, {
        employeeId: employeeIdNum,
        workDate: startD,
        correctedCheckIn: cciDate,
        correctedCheckOut: ccoDate,
        requestId: req.id,
      });
    }

    return req;
  });

  // 결재 요청 알림 — 자동승인이 아니고 결재자가 있을 때만
  if (!isAutoApproved && approverIds.length > 0) {
    try {
      const cat = category.name; // 카테고리명 (이미 위에서 조회된 category 사용)
      const requesterName = emp.name ?? "직원"; // 위에서 조회된 emp 사용
      await createNotifications({
        employeeIds: approverIds,
        type: "approval_request",
        title: "새 결재 요청",
        body: `${requesterName}님의 ${cat} 결재 요청`,
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

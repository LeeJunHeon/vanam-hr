import { NextRequest, NextResponse } from "next/server";
import type { Prisma } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/auth-helpers";
import {
  pendingAttendanceWhere,
  pendingTripWhere,
  myTripInviteWhere,
  describeAttendanceApproval,
} from "@/lib/approval-inbox";
import { createDelegationHoursLoader } from "@/lib/approval-resolver";
import { decideAttendanceApproval, type CalendarEdits } from "@/lib/attendance-approval";
import {
  syncTripParticipantAttendance,
  rebuildTripEventCalendar,
} from "@/lib/trip-calendar";
import { createNotifications } from "@/lib/notify";
import { sweepEligibleDelegations } from "@/lib/sweep-delegations";
import { checkLeaveRequest, computeLeaveAmount } from "@/lib/annual-leave";

// 결재함 조회 시 위임 자동 마감을 throttle로 트리거(B). 모듈 레벨 상태.
const DELEGATION_SWEEP_INTERVAL_MS = 5 * 60 * 1000; // 결재함 조회 트리거 throttle
let lastDelegationSweepAt = 0;

// Phase 7 3단계: 결재함에 출장(trip) 결재를 합치는 방식 A.
// - 출장 카테고리 표기는 attendance 카테고리와 통일된 키로 노출(필터/표시 공유).
// - 색상은 AttendanceCalendarView의 BUSINESS_TRIP 색(#f97316)과 동일.
const TRIP_CATEGORY = {
  code: "BUSINESS_TRIP",
  name: "출장 및 외근",
  type: "work",
  color: "#f97316",
} as const;

// @db.Time(6) → "HH:MM" 추출. 없으면 null.
function hhmmFromTime(d: Date | null | undefined): string | null {
  if (!d) return null;
  return d.toISOString().slice(11, 16);
}

// Phase 7 3단계: 출장 결재 항목 1개(이벤트 묶음)를 빌드.
// ps: 같은 trip_event에 속하는 trip_participant 묶음 (조건에 맞는 것만 — pending or 본인 처리).
function buildTripItem(
  ps: Array<{
    id: number;
    employeeId: number;
    inviteStatus: string;
    approvalStatus: string;
    approvedById: number | null;
    approvedAt: Date | null;
    rejectReason: string | null;
    createdAt: Date;
    employee: {
      id: number;
      name: string;
      employeeNo: string | null;
      department: { id: number; name: string } | null;
    };
    approvedBy: { id: number; name: string } | null;
    dates: Array<{
      id: number;
      attendDate: Date;
      startTime: Date | null;
      endTime: Date | null;
    }>;
    tripEvent: {
      id: number;
      name: string;
      location: string | null;
      startDate: Date;
      endDate: Date;
      status: string;
      createdAt: Date;
      createdById: number;
      createdBy: { id: number; name: string } | null;
    };
  }>,
  approverId: number
) {
  const ev = ps[0].tripEvent;
  // requestedAt 정렬키: 가장 오래된 참석자 createdAt (대기 큐의 머리 역할)
  const oldest = ps.reduce(
    (min, p) => (p.createdAt.getTime() < min.getTime() ? p.createdAt : min),
    ps[0].createdAt
  );
  // 가장 최근 처리 시각 (history 표시용)
  const latestApproved = ps
    .map((p) => p.approvedAt?.getTime() ?? 0)
    .reduce((mx, t) => (t > mx ? t : mx), 0);

  // 모든 참석자가 같은 처리 결과면 그 상태 — 섞여있으면 'pending' 우선(이벤트 카드에 노출되는 상태)
  const allPending = ps.every((p) => p.approvalStatus === "pending");
  const allApproved = ps.every((p) => p.approvalStatus === "approved");
  const allRejected = ps.every((p) => p.approvalStatus === "rejected");
  const itemStatus = allPending
    ? "pending"
    : allApproved
    ? "approved"
    : allRejected
    ? "rejected"
    : "pending";

  return {
    kind: "trip" as const,
    // 결재함 공통 필드 (한 줄 카드 표시 + 필터용)
    id: ev.id, // attendance.id와 의미 다름. PUT은 tripEventId로 명시 호출.
    categoryCode: TRIP_CATEGORY.code,
    categoryName: TRIP_CATEGORY.name,
    categoryType: TRIP_CATEGORY.type,
    categoryColor: TRIP_CATEGORY.color,
    status: itemStatus,
    startDate: ev.startDate.toISOString().split("T")[0],
    endDate: ev.endDate.toISOString().split("T")[0],
    requestedAt: oldest.toISOString(),
    // 표시용 대표 신청자: 이벤트 생성자
    employeeId: ev.createdById,
    employeeName: ev.createdBy?.name ?? null,
    isSelfRequest: ev.createdById === approverId,
    // 출장 고유 필드
    tripEventId: ev.id,
    eventName: ev.name,
    location: ev.location,
    eventStartDate: ev.startDate.toISOString().split("T")[0],
    eventEndDate: ev.endDate.toISOString().split("T")[0],
    pendingCount: ps.length,
    pendingParticipants: ps.map((p) => ({
      participantId: p.id,
      employeeId: p.employeeId,
      employeeName: p.employee.name,
      employeeNo: p.employee.employeeNo,
      departmentName: p.employee.department?.name ?? null,
      inviteStatus: p.inviteStatus,
      approvalStatus: p.approvalStatus,
      approvedById: p.approvedById,
      approvedByName: p.approvedBy?.name ?? null,
      approvedAt: p.approvedAt ? p.approvedAt.toISOString() : null,
      rejectReason: p.rejectReason,
      dates: p.dates.map((d) => ({
        attendDate: d.attendDate.toISOString().split("T")[0],
        startTime: hhmmFromTime(d.startTime),
        endTime: hhmmFromTime(d.endTime),
      })),
    })),
    // history 카드용 처리 시각 (가장 최근)
    approvedAt: latestApproved > 0 ? new Date(latestApproved).toISOString() : null,
  };
}

// GET /api/approvals?approverId=N&status=pending|approved|rejected|all
// 비관리자: 본인 결재함만 (approverId 무시 또는 본인과 다르면 403)
// 관리자: 다른 결재자도 조회 가능.
export async function GET(request: NextRequest) {
  try {
    // Phase 6-2H: CEO만 query param으로 다른 사람 결재함 조회 가능.
    // ADMIN/EMPLOYEE는 본인 결재함만 (query param 무시 또는 본인 id면 OK).
    const sessionR = await requireSession();
    if (!sessionR.ok) return sessionR.response;
    const { session } = sessionR;
    const isCeo = session.user.role === "ceo";
    const ownEmployeeId = session.user.employeeId;

    // 위임 자동 마감 트리거(fire-and-forget, throttle). 응답은 기다리지 않는다.
    if (Date.now() - lastDelegationSweepAt > DELEGATION_SWEEP_INTERVAL_MS) {
      lastDelegationSweepAt = Date.now();
      void sweepEligibleDelegations().catch((e) =>
        console.error("[sweep] 위임 마감 실패:", e)
      );
    }

    const { searchParams } = new URL(request.url);
    const status = searchParams.get("status") || "pending";
    const queryApproverIdRaw = searchParams.get("approverId");

    let approverId: number;
    if (isCeo && queryApproverIdRaw) {
      const n = Number(queryApproverIdRaw);
      if (!Number.isInteger(n)) {
        return NextResponse.json(
          { error: "approverId가 유효하지 않습니다." },
          { status: 400 }
        );
      }
      approverId = n;
    } else if (
      queryApproverIdRaw &&
      Number(queryApproverIdRaw) !== ownEmployeeId
    ) {
      // ADMIN/EMPLOYEE가 다른 사람 결재함 조회 시도 → 403
      return NextResponse.json(
        { error: "다른 직원의 결재함을 조회할 권한이 없습니다." },
        { status: 403 }
      );
    } else {
      if (!Number.isInteger(ownEmployeeId)) {
        return NextResponse.json(
          { error: "본인 직원 정보가 매핑되어 있지 않습니다." },
          { status: 403 }
        );
      }
      approverId = ownEmployeeId as number;
    }

    let where: Prisma.AttendanceRequestWhereInput = {};
    if (status === "pending") {
      where = pendingAttendanceWhere({ approverId, role: session.user.role });
    } else if (status === "approved") {
      where = { status: "approved", approvedByIds: { has: approverId } };
    } else if (status === "rejected") {
      where = {
        status: "rejected",
        OR: [
          { approvedById: approverId },
          { approvedByIds: { has: approverId } },
        ],
      };
    } else {
      where = {
        status: { in: ["approved", "rejected", "cancelled"] },
        OR: [
          { approvedById: approverId },
          { approvedByIds: { has: approverId } },
        ],
      };
    }

    const requests = await prisma.attendanceRequest.findMany({
      where,
      orderBy: [{ requestedAt: "desc" }],
      include: {
        employee: {
          select: {
            id: true,
            employeeNo: true,
            name: true,
            departmentId: true,
            department: {
              select: {
                id: true,
                name: true,
              },
            },
          },
        },
        category: {
          select: {
            id: true,
            code: true,
            name: true,
            type: true,
            displayColor: true,
            annualLeaveDeduct: true,
          },
        },
        primaryApprover: { select: { id: true, name: true } },
        deputyApprover: { select: { id: true, name: true } },
      },
    });

    // 결재자 이름 매핑 (approver_ids/approved_by_ids 표시용)
    const allApproverIds = Array.from(
      new Set(
        requests.flatMap((r) => [
          ...(r.approverIds ?? []),
          ...(r.approvedByIds ?? []),
        ])
      )
    );
    const approverNameMap = new Map<number, string>();
    if (allApproverIds.length > 0) {
      const emps = await prisma.employee.findMany({
        where: { id: { in: allApproverIds } },
        select: { id: true, name: true },
      });
      for (const e of emps) approverNameMap.set(e.id, e.name);
    }

    // 대리 위임 시간 — 신청이 탄 결재선 기준. (부서, 결재 항목) 조합마다 한 번만 조회.
    const loadDelegationHours = createDelegationHoursLoader(prisma);
    const delegationHoursList = await Promise.all(
      requests.map((r) =>
        loadDelegationHours({
          departmentId: r.employee.departmentId,
          categoryId: r.categoryId,
          categoryCode: r.category.code,
        })
      )
    );

    // 기존 attendance 항목 — Phase 7 3단계: kind:'attendance' 필드만 추가.
    // 그 외 모든 필드/형식 변경 금지.
    const attendanceItems = requests.map((r, idx) => {
      const autoDelegateHours = delegationHoursList[idx];
      // 권한·대리 위임·대기자 표시는 lib/approval-inbox 의 describeAttendanceApproval 한 곳에서.
      const {
        canApprove,
        iApproved,
        myRole,
        delegated,
        hoursLeft,
        waitingOn,
        statusText,
      } = describeAttendanceApproval({
        request: r,
        approverId,
        viewerRole: session.user.role,
        viewerEmployeeId: ownEmployeeId,
        autoDelegateHours,
        nameMap: approverNameMap,
      });

      return {
        kind: "attendance" as const,
        id: r.id,
        employeeId: r.employeeId,
        employeeNo: r.employee.employeeNo,
        employeeName: r.employee.name,
        departmentName: r.employee.department?.name ?? null,
        categoryId: r.categoryId,
        categoryCode: r.category.code,
        categoryName: r.category.name,
        categoryType: r.category.type,
        categoryColor: r.category.displayColor,
        requestType: r.requestType,
        startDate: r.startDate.toISOString().split("T")[0],
        endDate: r.endDate.toISOString().split("T")[0],
        reason: r.reason,
        correctedCheckIn: r.correctedCheckIn
          ? r.correctedCheckIn.toISOString()
          : null,
        correctedCheckOut: r.correctedCheckOut
          ? r.correctedCheckOut.toISOString()
          : null,
        status: r.status,
        primaryApproverId: r.primaryApproverId,
        primaryApproverName: r.primaryApprover?.name ?? null,
        deputyApproverId: r.deputyApproverId,
        deputyApproverName: r.deputyApprover?.name ?? null,
        approvedById: r.approvedById,
        approvedAt: r.approvedAt ? r.approvedAt.toISOString() : null,
        rejectReason: r.rejectReason,
        requestedAt: r.requestedAt.toISOString(),
        myRole,
        autoDelegateHours,
        delegated,
        hoursLeft,
        canApprove,
        isSelfRequest: r.employeeId === approverId,
        // 4·5-2b: 다중 결재자 진행도/표시
        approverIds: r.approverIds,
        approvalMode: r.approvalMode,
        approvedByIds: r.approvedByIds,
        approvedCount: (r.approvedByIds ?? []).length,
        totalApprovers: (r.approverIds ?? []).length,
        iApproved,
        // 누가 결재 대기 중인지 (결재 대기 탭 한 줄 표시)
        waitingOn,
        statusText,
        approvers: (r.approverIds ?? []).map((aid) => ({
          id: aid,
          name: approverNameMap.get(aid) ?? null,
          approved: (r.approvedByIds ?? []).includes(aid),
        })),
        // Phase 6-2E 캘린더 등록 정보
        calendarSourceId: r.calendarSourceId ?? null,
        calendarEventTitle: r.calendarEventTitle ?? null,
        calendarEventDescription: r.calendarEventDescription ?? null,
        externalSource: r.externalSource ?? null,
        externalEventId: r.externalEventId ?? null,
        // 연차 차감 정보 (차감 대상만 아래 enrich 루프에서 채움)
        leaveDeductPerDay: r.category?.annualLeaveDeduct ? Number(r.category.annualLeaveDeduct) : 0,
        leaveGranted: null as number | null,
        leaveRemaining: null as number | null,
        leaveRequestAmount: null as number | null,
        leaveRemainingAfter: null as number | null,
      };
    });

    // 연차 차감 신청만 차감량 계산 (미리보기·초과차단과 같은 checkLeaveRequest)
    // - pending: 잔여·이번 차감·신청 후 신청 가능 (결재 판단용). 결재 대기는 그 신청 자신을 빼고 센다.
    //   leaveRemaining = 시작 연도 잔여, leaveRemainingAfter = 연도별 신청 후 신청 가능 중 최솟값.
    // - approved: 차감량만 ("N일 차감됨"). 지금 잔여는 이미 차감이 반영돼 있어 신청 후 잔여 계산이 틀어지므로 null.
    // - rejected/cancelled: 연차 필드 모두 null
    for (const it of attendanceItems) {
      if (it.leaveDeductPerDay <= 0) continue;
      if (it.status !== "pending" && it.status !== "approved") continue;
      if (it.status === "approved") {
        // 처리 완료 목록은 차감량만 — 잔여·대기 조회 없이 근무일 × 계수만 센다
        it.leaveRequestAmount = await computeLeaveAmount(
          it.employeeId,
          new Date(it.startDate + "T00:00:00.000Z"),
          new Date(it.endDate + "T00:00:00.000Z"),
          it.leaveDeductPerDay
        );
        continue;
      }
      const check = await checkLeaveRequest(
        it.employeeId,
        new Date(it.startDate + "T00:00:00.000Z"),
        new Date(it.endDate + "T00:00:00.000Z"),
        it.leaveDeductPerDay,
        { excludeRequestId: it.id }
      );
      it.leaveRequestAmount = check.amount;
      if (it.status === "pending" && check.years.length > 0) {
        it.leaveGranted = check.years[0].granted;
        it.leaveRemaining = check.years[0].remaining;
        it.leaveRemainingAfter = Math.min(...check.years.map((y) => y.availableAfter));
      }
    }

    // ────────────────────────────────────────────────────
    // Phase 7 3단계: 출장(trip) 결재 항목 합치기 (admin/ceo만)
    // - 부서 결재선과 무관. role이 admin/ceo면 모든 trip 결재 표시.
    // - pending: approval_status='pending'인 참석자가 있는 이벤트 1줄
    // - approved/rejected: 본인이 직접 처리한 것(approvedById === approverId)
    // - all(else): 본인이 처리한 approved/rejected 합쳐서
    // 정렬은 attendance와 함께 requestedAt(ISO) 기준 desc.
    // ────────────────────────────────────────────────────
    type TripItem = ReturnType<typeof buildTripItem>;
    let tripItems: TripItem[] = [];

    // 출장 결재 조회 자격:
    //  - 누구나 "본인이 결재자(approver_ids 포함)이거나 대리(deputy)"인 출장은 볼 수 있다.
    //  - 관리자(ADMIN)는 추가로 "approver_ids가 빈 배열인 기존 출장"도 본다(폴백).
    //  - CEO는 상시 모든 pending 출장을 본다.
    // approved/rejected/all 이력은 기존처럼 "본인이 처리한 것"만.
    {
      // pending where: 결재자 필터 (lib/approval-inbox)
      let participantWhere: Prisma.TripParticipantWhereInput;
      if (status === "pending") {
        participantWhere = pendingTripWhere({ approverId, role: session.user.role });
      } else if (status === "approved") {
        participantWhere = {
          approvalStatus: "approved",
          approvedById: approverId,
        };
      } else if (status === "rejected") {
        participantWhere = {
          approvalStatus: "rejected",
          approvedById: approverId,
        };
      } else {
        // all → 본인이 처리한 전체 이력
        participantWhere = {
          approvalStatus: { in: ["approved", "rejected"] },
          approvedById: approverId,
        };
      }

      const tripParticipants = await prisma.tripParticipant.findMany({
        where: {
          ...participantWhere,
          tripEvent: { status: "active" },
        },
        include: {
          employee: {
            select: {
              id: true,
              name: true,
              employeeNo: true,
              department: { select: { id: true, name: true } },
            },
          },
          approvedBy: { select: { id: true, name: true } },
          dates: {
            orderBy: [{ attendDate: "asc" }],
            select: {
              id: true,
              attendDate: true,
              startTime: true,
              endTime: true,
            },
          },
          tripEvent: {
            select: {
              id: true,
              name: true,
              location: true,
              startDate: true,
              endDate: true,
              status: true,
              createdAt: true,
              createdById: true,
              createdBy: { select: { id: true, name: true } },
            },
          },
        },
        orderBy: [{ createdAt: "asc" }],
      });

      // 이벤트별 그룹핑
      const byEvent = new Map<number, typeof tripParticipants>();
      for (const p of tripParticipants) {
        const arr = byEvent.get(p.tripEventId) ?? [];
        arr.push(p);
        byEvent.set(p.tripEventId, arr);
      }
      tripItems = [...byEvent.entries()].map(([, ps]) =>
        buildTripItem(ps, approverId)
      );
    }

    // ── 내 출장 초대(수락/거부) ──────────────────────────────
    // pending 탭이고 "본인 결재함"일 때만 노출. 초대 응답(accept/decline)은
    // 본인만 가능하므로 CEO가 남의 결재함(approverId≠본인)을 볼 땐 제외한다.
    // 결재(approval_status)와 무관하게 inviteStatus='invited'(아직 응답 안 한 초대)만 대상.
    const myInvites =
      status === "pending" &&
      Number.isInteger(ownEmployeeId) &&
      approverId === ownEmployeeId
        ? await prisma.tripParticipant.findMany({
            where: myTripInviteWhere(ownEmployeeId as number),
            include: {
              tripEvent: {
                select: {
                  id: true,
                  name: true,
                  location: true,
                  startDate: true,
                  endDate: true,
                },
              },
              dates: {
                orderBy: [{ attendDate: "asc" }],
                select: { attendDate: true, startTime: true, endTime: true },
              },
            },
            orderBy: [{ createdAt: "asc" }],
          })
        : [];

    const tripInviteItems = myInvites.map((p) => ({
      kind: "trip_invite" as const,
      participantId: p.id,
      tripEventId: p.tripEventId,
      eventName: p.tripEvent.name,
      location: p.tripEvent.location,
      eventStartDate: p.tripEvent.startDate.toISOString().split("T")[0],
      eventEndDate: p.tripEvent.endDate.toISOString().split("T")[0],
      inviteStatus: p.inviteStatus,
      // 내 현재 참석 날짜(있으면). 시간은 "HH:MM"(없으면 종일=null).
      dates: p.dates.map((d) => ({
        attendDate: d.attendDate.toISOString().split("T")[0],
        startTime: hhmmFromTime(d.startTime),
        endTime: hhmmFromTime(d.endTime),
      })),
      // 정렬용 — 초대 생성 시각.
      requestedAt: p.createdAt.toISOString(),
    }));

    // 세 종류(근태/출장결재/내 초대)를 합쳐 requestedAt 기준 최근순 정렬
    const merged: Array<
      (typeof attendanceItems)[number] | TripItem | (typeof tripInviteItems)[number]
    > = [...attendanceItems, ...tripItems, ...tripInviteItems];
    merged.sort((a, b) => {
      const ta = new Date(a.requestedAt).getTime();
      const tb = new Date(b.requestedAt).getTime();
      return tb - ta;
    });

    return NextResponse.json(merged);
  } catch (error) {
    console.error("GET /api/approvals error:", error);
    return NextResponse.json(
      { error: "결재 목록 조회 실패" },
      { status: 500 }
    );
  }
}

// PUT /api/approvals?id=N — 승인/반려
// body(공통): { kind?: 'attendance'|'trip', action: 'approve'|'reject', rejectReason? }
// kind='attendance'(기본): 기존 동작 그대로. body.approverId 등 기존 필드 사용.
// kind='trip': 출장 결재. body: { tripEventId, participantIds?, action, rejectReason? }.
//              권한 admin/ceo, 부서 결재선 무관.
export async function PUT(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");

    const body = await request.json();
    const kind = body.kind === "trip" ? "trip" : "attendance";

    if (kind === "trip") {
      return await handleTripApproval(request, body);
    }

    if (!id) {
      return NextResponse.json({ error: "id 파라미터 필요" }, { status: 400 });
    }
    const idNum = Number(id);

    const {
      action,
      rejectReason,
      // Phase 6-2E 결재자가 수정 가능한 캘린더 필드
      calendarSourceId,
      calendarEventTitle,
      calendarEventDescription,
    } = body;

    if (!action) {
      return NextResponse.json(
        { error: "action은 필수입니다." },
        { status: 400 }
      );
    }
    if (action !== "approve" && action !== "reject") {
      return NextResponse.json(
        { error: "action은 'approve' 또는 'reject'여야 합니다." },
        { status: 400 }
      );
    }
    if (action === "reject" && !rejectReason?.trim()) {
      return NextResponse.json(
        { error: "반려는 사유가 필수입니다." },
        { status: 400 }
      );
    }

    // 결재자는 항상 로그인한 본인 (body/query 의 approverId 는 무시)
    const sessionR = await requireSession();
    if (!sessionR.ok) return sessionR.response;
    const { session } = sessionR;
    const approverIdNum = session.user.employeeId;
    if (!Number.isInteger(approverIdNum)) {
      return NextResponse.json(
        {
          error:
            "본인 직원 정보가 매핑되어 있지 않습니다. 관리자에게 직원 등록을 요청하세요.",
        },
        { status: 403 }
      );
    }

    // Phase 6-2E: 결재자가 수정한 캘린더 정보 (undefined는 유지). 최종 저장(승인·반려)에만 반영.
    const calendarEdits: CalendarEdits = {};
    if (calendarSourceId !== undefined) {
      calendarEdits.calendarSourceId =
        calendarSourceId === null || calendarSourceId === ""
          ? null
          : Number(calendarSourceId);
    }
    if (calendarEventTitle !== undefined) {
      calendarEdits.calendarEventTitle = calendarEventTitle?.trim() || null;
    }
    if (calendarEventDescription !== undefined) {
      calendarEdits.calendarEventDescription =
        calendarEventDescription?.trim() || null;
    }

    // 판정·저장·최종 확정·결과 알림은 lib/attendance-approval 공용
    const result = await decideAttendanceApproval({
      requestId: idNum,
      approverId: approverIdNum as number,
      role: session.user.role,
      action,
      rejectReason: action === "reject" ? rejectReason : null,
      calendarEdits,
      source: "approval",
    });

    if (!result.ok) {
      const httpStatus: Record<typeof result.code, number> = {
        not_found: 404,
        not_pending: 409,
        no_permission: 403,
        self_request: 403,
        already_approved: 409,
        category_missing: 500,
        conflict: 409,
      };
      return NextResponse.json(
        { error: result.message },
        { status: httpStatus[result.code] }
      );
    }

    // 부분 승인(아직 전원 아님) → pending 유지
    if (result.kind === "partial") {
      return NextResponse.json({
        id: result.id,
        status: result.status,
        approvedCount: result.approvedCount,
        totalApprovers: result.totalApprovers,
        finalized: false,
      });
    }

    return NextResponse.json({
      id: result.id,
      status: result.status,
      appliedDays: result.appliedDays,
      calendarEventId: result.calendarEventId,
    });
  } catch (error) {
    console.error("PUT /api/approvals error:", error);
    return NextResponse.json({ error: "결재 처리 실패" }, { status: 500 });
  }
}

// ─────────────────────────────────────────────────────────
// Phase 7 3단계: 출장 결재 처리 (kind='trip').
// body: { tripEventId, action: 'approve'|'reject', rejectReason?, participantIds?: number[] }
// - 권한: 세션 role이 admin/ceo만. 부서 결재선 무관.
// - participantIds 미지정 시 해당 이벤트의 approval_status='pending' 전체 일괄 처리.
// - action='reject'면 rejectReason 필수.
// - 이미 pending이 아닌 참석자는 건너뜀(부분 처리 가능).
// - 이번 단계에선 캘린더/근태 반영하지 않음(4단계). approval_status + 승인자 정보까지만.
async function handleTripApproval(_request: NextRequest, body: unknown) {
  const sessionR = await requireSession();
  if (!sessionR.ok) return sessionR.response;
  const { session } = sessionR;

  // 로그인 + 직원 매핑만 확인. 실제 결재 권한은 참여자별 approver_ids로 판정한다.
  const approverEmployeeId = session.user.employeeId;
  if (!Number.isInteger(approverEmployeeId)) {
    return NextResponse.json(
      { error: "본인 직원 정보가 매핑되어 있지 않습니다." },
      { status: 403 }
    );
  }

  const { tripEventId, action, rejectReason, participantIds } = body as {
    tripEventId?: unknown;
    action?: unknown;
    rejectReason?: unknown;
    participantIds?: unknown;
  };

  const eventIdNum = Number(tripEventId);
  if (!Number.isInteger(eventIdNum) || eventIdNum <= 0) {
    return NextResponse.json(
      { error: "tripEventId는 양의 정수여야 합니다." },
      { status: 400 }
    );
  }
  if (action !== "approve" && action !== "reject") {
    return NextResponse.json(
      { error: "action은 'approve' 또는 'reject'여야 합니다." },
      { status: 400 }
    );
  }
  let trimmedReason: string | null = null;
  if (action === "reject") {
    if (typeof rejectReason !== "string" || !rejectReason.trim()) {
      return NextResponse.json(
        { error: "반려는 사유가 필수입니다." },
        { status: 400 }
      );
    }
    trimmedReason = rejectReason.trim();
  }

  // participantIds 검증 (옵션)
  let participantIdFilter: number[] | null = null;
  if (participantIds !== undefined && participantIds !== null) {
    if (!Array.isArray(participantIds)) {
      return NextResponse.json(
        { error: "participantIds는 배열이어야 합니다." },
        { status: 400 }
      );
    }
    const ids = participantIds
      .map((v) => Number(v))
      .filter((n) => Number.isInteger(n) && n > 0);
    if (ids.length === 0) {
      return NextResponse.json(
        { error: "participantIds가 비어 있습니다." },
        { status: 400 }
      );
    }
    participantIdFilter = ids;
  }

  // 이벤트 존재 확인
  const ev = await prisma.tripEvent.findUnique({
    where: { id: eventIdNum },
    select: { id: true, status: true },
  });
  if (!ev) {
    return NextResponse.json(
      { error: "이벤트를 찾을 수 없습니다." },
      { status: 404 }
    );
  }
  if (ev.status !== "active") {
    return NextResponse.json(
      { error: "활성(active) 이벤트만 결재할 수 있습니다." },
      { status: 400 }
    );
  }

  // 처리 대상: pending이면서, 본인이 결재 권한을 가진 참여자만.
  //  - 본인이 approver_ids에 포함 또는 deputy
  //  - approver_ids가 빈 배열(기존 출장)이고 본인이 관리자 → 폴백
  //  - CEO는 모든 pending 처리 가능
  //  - 초대를 수락한 참여자만 (수락 전·거절 제외)
  // (범위 정의는 lib/approval-inbox 의 pendingTripWhere)
  const targetWhere: Prisma.TripParticipantWhereInput = {
    ...pendingTripWhere({
      approverId: approverEmployeeId as number,
      role: session.user.role,
    }),
    tripEventId: eventIdNum,
  };
  if (participantIdFilter) {
    targetWhere.id = { in: participantIdFilter };
  }

  const now = new Date();
  // 처리 대상 ID를 먼저 잡아둔다 — 4단계 후처리에서 사용.
  const targetIds = (
    await prisma.tripParticipant.findMany({
      where: targetWhere,
      select: { id: true },
    })
  ).map((p) => p.id);

  const result = await prisma.$transaction(async (tx) => {
    const updateRes = await tx.tripParticipant.updateMany({
      where: targetWhere,
      data: {
        approvalStatus: action === "approve" ? "approved" : "rejected",
        approvedById: approverEmployeeId as number,
        approvedAt: now,
        rejectReason: action === "reject" ? trimmedReason : null,
      },
    });
    return updateRes.count;
  });

  // Phase 7 (이벤트 단위 재구성):
  //  - 승인된 참석자 각각에 대해 근태(attendance_request) 동기화(늦은 승인이면 지난 날짜도 채움)
  //  - 이벤트 단위로 캘린더 재구성 한 번
  // 트랜잭션 밖에서 실행 — 외부 호출 시간 동안 DB 락 잡지 않음.
  if (action === "approve" && targetIds.length > 0) {
    for (const pid of targetIds) {
      try {
        await syncTripParticipantAttendance(pid);
      } catch (e) {
        console.error(
          `[trip-approval] syncTripParticipantAttendance(${pid}) 실패:`,
          e
        );
      }
    }
    try {
      await rebuildTripEventCalendar(eventIdNum);
    } catch (e) {
      console.error(
        `[trip-approval] rebuildTripEventCalendar(${eventIdNum}) 실패:`,
        e
      );
    }
  }

  // ── 출장 결재 결과 알림 (각 참석자에게) ──────────────────
  if (Array.isArray(targetIds) && targetIds.length > 0) {
    try {
      const parts = await prisma.tripParticipant.findMany({
        where: { id: { in: targetIds } },
        select: { employeeId: true },
      });
      const empIds = parts
        .map((p) => p.employeeId)
        .filter((id): id is number => Number.isInteger(id));
      if (empIds.length > 0) {
        const resultLabel = action === "approve" ? "승인" : "반려";
        let resultBody = `출장 신청이 ${resultLabel}되었습니다.`;
        if (action === "reject" && trimmedReason && trimmedReason.trim()) {
          resultBody += ` (사유: ${trimmedReason.trim()})`;
        }
        await createNotifications({
          employeeIds: empIds,
          type: "trip_result",
          title: `출장 ${resultLabel}`,
          body: resultBody,
          linkPage: "field-trip",
          linkRefId: eventIdNum,
          sourceType: "trip",
        });
      }
    } catch (e) {
      console.error("[notify] 출장 결재 결과 알림 생성 실패:", e);
    }
  }

  return NextResponse.json({
    kind: "trip",
    tripEventId: eventIdNum,
    action,
    processedCount: result,
  });
}

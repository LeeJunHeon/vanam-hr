import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getApproverId, requireSession, isAdminSession } from "@/lib/auth-helpers";
import {
  createTripParticipantAttendanceRequests,
  rebuildTripEventCalendar,
} from "@/lib/trip-calendar";
import { createNotifications } from "@/lib/notify";
import { applyCorrectionToDaily } from "@/lib/attendance-correction";

// Phase 7 3단계: 결재함에 출장(trip) 결재를 합치는 방식 A.
// - 출장 카테고리 표기는 attendance 카테고리와 통일된 키로 노출(필터/표시 공유).
// - 색상은 AttendanceCalendarView의 BUSINESS_TRIP 색(#f97316)과 동일.
const TRIP_CATEGORY = {
  code: "BUSINESS_TRIP",
  name: "출장",
  type: "work",
  color: "#f97316",
} as const;

// @db.Time(6) → "HH:MM" 추출. 없으면 null.
function hhmmFromTime(d: Date | null | undefined): string | null {
  if (!d) return null;
  return d.toISOString().slice(11, 16);
}

// Phase 6-2E: 캘린더 일정 등록 (calendar-syncer POST 호출).
// 성공 시 event_id 반환. 실패 시 throw (호출자가 try/catch로 결재 자체는 유지).
interface CreateEventParams {
  calendarId: string;
  summary: string;
  description: string;
  startDate: Date;
  endDate: Date;
  correctedCheckIn: Date | null;
  correctedCheckOut: Date | null;
}

async function createCalendarEvent(
  p: CreateEventParams
): Promise<string | null> {
  const base = process.env.CALENDAR_SYNCER_URL;
  if (!base) throw new Error("CALENDAR_SYNCER_URL env not set");

  // 종일 vs 시간 지정 판단
  // Phase 6-2G: 한쪽만 있어도 종일로 안전 처리 (런타임 에러 방지 — null!.toISOString() 방지)
  const isAllDay = !p.correctedCheckIn || !p.correctedCheckOut;

  let startObj: Record<string, string>;
  let endObj: Record<string, string>;
  if (isAllDay) {
    // 종일: start.date, end.date (Google API exclusive end → +1일)
    const sYmd = p.startDate.toISOString().split("T")[0];
    const eDate = new Date(p.endDate);
    eDate.setUTCDate(eDate.getUTCDate() + 1);
    const eYmd = eDate.toISOString().split("T")[0];
    startObj = { date: sYmd };
    endObj = { date: eYmd };
  } else {
    // 시간 지정: dateTime + timeZone (KST)
    startObj = {
      dateTime: p.correctedCheckIn!.toISOString(),
      timeZone: "Asia/Seoul",
    };
    endObj = {
      dateTime: p.correctedCheckOut!.toISOString(),
      timeZone: "Asia/Seoul",
    };
  }

  const url = `${base}/internal/calendar-event`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Internal-Token": process.env.INTERNAL_API_TOKEN ?? "",
    },
    body: JSON.stringify({
      calendar_id: p.calendarId,
      vanam_source: "hr",
      summary: p.summary,
      description: p.description,
      start: startObj,
      end: endObj,
    }),
  });
  if (!res.ok) {
    throw new Error(`calendar-syncer POST failed: ${res.status}`);
  }
  const data = await res.json();
  return data.eventId ?? data.event_id ?? data.id ?? null;
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

// 자동 위임 시간 계산
function isDelegationElapsed(requestedAt: Date, hours: number): boolean {
  const elapsed = Date.now() - requestedAt.getTime();
  return elapsed >= hours * 60 * 60 * 1000;
}

function hoursUntilDelegation(requestedAt: Date, hours: number): number {
  const elapsed = Date.now() - requestedAt.getTime();
  const total = hours * 60 * 60 * 1000;
  return Math.max(0, (total - elapsed) / (1000 * 60 * 60));
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

    const viewerIsCeo = session.user.role === "ceo";
    let where: any = {};
    if (status === "pending") {
      where = viewerIsCeo
        ? { status: "pending" }
        : {
            status: "pending",
            OR: [
              { approverIds: { has: approverId } },
              { deputyApproverId: approverId },
            ],
          };
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
                approvalLine: {
                  select: { autoDelegateHours: true },
                },
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

    // 기존 attendance 항목 — Phase 7 3단계: kind:'attendance' 필드만 추가.
    // 그 외 모든 필드/형식 변경 금지.
    const attendanceItems = requests.map((r) => {
      const isPrimary = r.primaryApproverId === approverId;
      const isDeputy = r.deputyApproverId === approverId;
      const autoDelegateHours =
        r.employee.department?.approvalLine?.autoDelegateHours ?? 24;
      const delegated = isDelegationElapsed(r.requestedAt, autoDelegateHours);
      const hoursLeft = hoursUntilDelegation(r.requestedAt, autoDelegateHours);

      let myRole: "primary" | "deputy" | null = null;
      if (isPrimary) myRole = "primary";
      else if (isDeputy) myRole = "deputy";

      // 4·5-2b: 다중 결재자 — approver_ids 포함 & 미승인 & pending 이면 결재 가능
      const isApprover =
        Array.isArray(r.approverIds) && r.approverIds.includes(approverId);
      const iApproved =
        Array.isArray(r.approvedByIds) && r.approvedByIds.includes(approverId);
      let canApprove =
        r.status === "pending" &&
        !iApproved &&
        (isApprover || viewerIsCeo || (isDeputy && delegated));

      // Phase 6-2J: 본인 신청은 일반 직원만 차단 (ADMIN/CEO는 본인 결재 허용)
      if (r.employeeId === approverId) {
        const viewerRole = session.user.role;
        if (viewerRole !== "admin" && viewerRole !== "ceo") {
          canApprove = false;
        }
      }

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
      };
    });

    // ────────────────────────────────────────────────────
    // Phase 7 3단계: 출장(trip) 결재 항목 합치기 (admin/ceo만)
    // - 부서 결재선과 무관. role이 admin/ceo면 모든 trip 결재 표시.
    // - pending: approval_status='pending'인 참석자가 있는 이벤트 1줄
    // - approved/rejected: 본인이 직접 처리한 것(approvedById === approverId)
    // - all(else): 본인이 처리한 approved/rejected 합쳐서
    // 정렬은 attendance와 함께 requestedAt(ISO) 기준 desc.
    // ────────────────────────────────────────────────────
    const adminLike = isAdminSession(session);
    const viewerIsCeoTrip = session.user.role === "ceo";
    type TripItem = ReturnType<typeof buildTripItem>;
    let tripItems: TripItem[] = [];

    // 출장 결재 조회 자격:
    //  - 누구나 "본인이 결재자(approver_ids 포함)이거나 대리(deputy)"인 출장은 볼 수 있다.
    //  - 관리자(adminLike)는 추가로 "approver_ids가 빈 배열인 기존 출장"도 본다(폴백).
    //  - CEO는 상시 모든 pending 출장을 본다.
    // approved/rejected/all 이력은 기존처럼 "본인이 처리한 것"만.
    {
      // pending where: 결재자 필터
      let participantWhere: any;
      if (status === "pending") {
        if (viewerIsCeoTrip) {
          // CEO는 모든 pending
          participantWhere = { approvalStatus: "pending" };
        } else {
          const pendingOr: any[] = [
            { approverIds: { has: approverId } },
            { deputyApproverId: approverId },
          ];
          // 관리자는 빈 배열(기존 출장)도 폴백으로 본다
          if (adminLike) {
            pendingOr.push({ approverIds: { isEmpty: true } });
          }
          participantWhere = {
            approvalStatus: "pending",
            OR: pendingOr,
          };
        }
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

    // 두 종류를 합쳐 requestedAt 기준 최근순 정렬
    const merged: Array<
      (typeof attendanceItems)[number] | TripItem
    > = [...attendanceItems, ...tripItems];
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
      approverId: bodyApproverId,
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

    const r = await getApproverId(request, bodyApproverId);
    if (!r.ok) return r.response;
    const approverIdNum = r.approverId;

    const target = await prisma.attendanceRequest.findUnique({
      where: { id: idNum },
      include: {
        employee: {
          select: {
            departmentId: true,
            department: {
              select: {
                approvalLine: { select: { autoDelegateHours: true } },
              },
            },
          },
        },
      },
    });
    if (!target) {
      return NextResponse.json(
        { error: "요청을 찾을 수 없습니다." },
        { status: 404 }
      );
    }

    if (target.status !== "pending") {
      return NextResponse.json(
        { error: "결재 대기 상태가 아닙니다." },
        { status: 409 }
      );
    }

    const viewerRole = r.session.user.role;
    const isCeoApprover = viewerRole === "ceo";

    // 대리 위임 경과 판정 (autoDelegateHours = 신청자 부서 결재선 기준, 기본 24)
    const autoDelegateHours =
      target.employee?.department?.approvalLine?.autoDelegateHours ?? 24;
    const delegationElapsed = isDelegationElapsed(
      target.requestedAt,
      autoDelegateHours
    );
    const isApproverIn =
      Array.isArray(target.approverIds) &&
      target.approverIds.includes(approverIdNum);
    const isDeputyApprover =
      target.deputyApproverId === approverIdNum && delegationElapsed;

    // 권한: 정규 결재자 / 대리(위임 경과) / CEO(상시) 중 하나여야 함
    if (!isApproverIn && !isDeputyApprover && !isCeoApprover) {
      return NextResponse.json(
        { error: "이 요청의 결재자로 지정되어 있지 않습니다." },
        { status: 403 }
      );
    }

    // 본인 신청은 일반 직원만 차단 (ADMIN/CEO는 본인 결재 허용)
    if (
      target.employeeId === approverIdNum &&
      viewerRole !== "admin" &&
      viewerRole !== "ceo"
    ) {
      return NextResponse.json(
        { error: "본인의 신청은 결재할 수 없습니다." },
        { status: 403 }
      );
    }

    let newApprovedBy: number[] = target.approvedByIds ?? [];

    if (action === "approve") {
      if ((target.approvedByIds ?? []).includes(approverIdNum)) {
        return NextResponse.json(
          { error: "이미 승인하셨습니다." },
          { status: 409 }
        );
      }
      newApprovedBy = [...(target.approvedByIds ?? []), approverIdNum];

      // CEO 또는 대리(위임 경과) = 즉시 최종 확정. 정규 결재자 = 모드별 판정.
      const decisive = isCeoApprover || isDeputyApprover;
      const fullyApproved = decisive
        ? true
        : target.approvalMode === "any"
        ? true
        : target.approverIds.every((id) => newApprovedBy.includes(id));

      // 부분 승인(아직 전원 아님) → 승인자만 누적, pending 유지. 근태·캘린더 미반영.
      if (!fullyApproved) {
        const partial = await prisma.attendanceRequest.update({
          where: { id: idNum },
          data: { approvedByIds: newApprovedBy },
        });
        return NextResponse.json({
          id: partial.id,
          status: partial.status,
          approvedCount: newApprovedBy.length,
          totalApprovers: (target.approverIds ?? []).length,
          finalized: false,
        });
      }
      // 최종 승인 → 아래 finalize 진행 (newApprovedBy 반영)
    }
    // 여기 도달 = 반려 OR 최종 승인 → 아래 기존 finalize 로직 그대로 진행.

    const newStatus = action === "approve" ? "approved" : "rejected";
    const now = new Date();

    // 카테고리 정보 다시 조회 (type 필요)
    const category = await prisma.attendanceCategory.findUnique({
      where: { id: target.categoryId },
    });
    if (!category) {
      return NextResponse.json(
        { error: "카테고리 정보를 찾을 수 없습니다." },
        { status: 500 }
      );
    }

    // YYYY-MM-DD 배열 생성 (startDate ~ endDate inclusive)
    function daysBetween(start: Date, end: Date): string[] {
      const days: string[] = [];
      const cur = new Date(start);
      while (cur <= end) {
        days.push(cur.toISOString().split("T")[0]);
        cur.setUTCDate(cur.getUTCDate() + 1);
      }
      return days;
    }

    const result = await prisma.$transaction(async (tx) => {
      // 1) attendance_request 상태 업데이트
      //    Phase 6-2E: 결재자가 캘린더 정보 수정한 경우 함께 반영 (undefined는 유지)
      const calendarUpdateFields: Record<string, unknown> = {};
      if (calendarSourceId !== undefined) {
        calendarUpdateFields.calendarSourceId =
          calendarSourceId === null || calendarSourceId === ""
            ? null
            : Number(calendarSourceId);
      }
      if (calendarEventTitle !== undefined) {
        calendarUpdateFields.calendarEventTitle =
          calendarEventTitle?.trim() || null;
      }
      if (calendarEventDescription !== undefined) {
        calendarUpdateFields.calendarEventDescription =
          calendarEventDescription?.trim() || null;
      }

      const updated = await tx.attendanceRequest.update({
        where: { id: idNum },
        data: {
          status: newStatus,
          approvedById: approverIdNum,
          approvedAt: now,
          rejectReason: action === "reject" ? rejectReason.trim() : null,
          ...(action === "approve" ? { approvedByIds: newApprovedBy } : {}),
          ...calendarUpdateFields,
        },
      });

      // 반려는 attendance_daily 안 건드림
      if (action !== "approve") {
        return { updated, applied: 0 };
      }

      let applied = 0;

      if (category.type === "correction") {
        await applyCorrectionToDaily(tx, {
          employeeId: target.employeeId,
          workDate: target.startDate,
          correctedCheckIn: target.correctedCheckIn,
          correctedCheckOut: target.correctedCheckOut,
          requestId: updated.id,
        });
        applied = 1;
      } else if (category.type === "leave" || category.type === "work") {
        // 휴가 / 외근·출장·재택: startDate~endDate 각 날 categoryId 세팅
        // 출퇴근 시각은 기존값 유지 (있으면 그대로, 없으면 NULL)
        // auto_status='normal' 강제 (휴가/외근은 정상 처리)
        const days = daysBetween(target.startDate, target.endDate);

        for (const ymd of days) {
          const wd = new Date(ymd + "T00:00:00.000Z");

          const existing = await tx.attendanceDaily.findUnique({
            where: {
              employeeId_workDate: {
                employeeId: target.employeeId,
                workDate: wd,
              },
            },
          });

          await tx.attendanceDaily.upsert({
            where: {
              employeeId_workDate: {
                employeeId: target.employeeId,
                workDate: wd,
              },
            },
            create: {
              employeeId: target.employeeId,
              workDate: wd,
              checkIn: null,
              checkOut: null,
              categoryId: target.categoryId,
              autoStatus: "normal",
              isOverridden: true,
              overrideSource: "manual", // Phase 6-2L+ C-3: 수동 결재 적용 → 보호 대상
              note: `결재 #${updated.id} (${category.name})`,
            },
            update: {
              categoryId: target.categoryId,
              autoStatus: "normal",
              isOverridden: true,
              overrideSource: "manual", // Phase 6-2L+ C-3
              note: existing?.note ?? `결재 #${updated.id} (${category.name})`,
            },
          });
          applied++;
        }
      }
      // 그 외 카테고리 type (없음 — correction/leave/work 3종만)

      return { updated, applied };
    });

    // Phase 6-2E: 승인 시 + 캘린더 정보 있으면 → Google Calendar 등록
    // (transaction 밖에서 실행 — 외부 API 호출은 트랜잭션 안에 두지 않음)
    let calendarEventId: string | null = null;
    if (action === "approve") {
      const finalRequest = await prisma.attendanceRequest.findUnique({
        where: { id: idNum },
        include: {
          calendarSource: { select: { calendarId: true, calendarName: true } },
        },
      });

      if (
        finalRequest?.calendarSource &&
        finalRequest.calendarEventTitle &&
        !finalRequest.externalEventId // 이미 등록된 경우 중복 방지
      ) {
        try {
          calendarEventId = await createCalendarEvent({
            calendarId: finalRequest.calendarSource.calendarId,
            summary: finalRequest.calendarEventTitle,
            description: finalRequest.calendarEventDescription ?? "",
            startDate: finalRequest.startDate,
            endDate: finalRequest.endDate,
            correctedCheckIn: finalRequest.correctedCheckIn,
            correctedCheckOut: finalRequest.correctedCheckOut,
          });
          if (calendarEventId) {
            await prisma.attendanceRequest.update({
              where: { id: idNum },
              data: {
                externalSource: "hr",
                externalEventId: calendarEventId,
              },
            });
            console.log(
              `[approval] 캘린더 등록 완료: eventId=${calendarEventId}`
            );
          }
        } catch (e) {
          console.error(`[approval] 캘린더 등록 실패 (결재는 유지):`, e);
          // 캘린더 실패해도 결재는 유지 (멱등적 — 관리자가 수동 등록하면 됨)
        }
      }
    }

    // ── 결재 결과 알림 (신청자에게) ──────────────────────────
    // - 여기 도달 = 최종 승인 또는 반려 (부분 승인은 위에서 이미 return됨)
    // - 본인이 본인 신청을 처리한 경우(ADMIN/CEO 자기결재)는 알림 불필요 → 스킵
    if (target.employeeId !== approverIdNum) {
      try {
        const catName = category?.name ?? "근태";
        const resultLabel = newStatus === "approved" ? "승인" : "반려";
        let resultBody = `${catName} 신청이 ${resultLabel}되었습니다.`;
        if (newStatus === "rejected" && typeof rejectReason === "string" && rejectReason.trim()) {
          resultBody += ` (사유: ${rejectReason.trim()})`;
        }
        await createNotifications({
          employeeIds: [target.employeeId],
          type: "approval_result",
          title: `결재 ${resultLabel}`,
          body: resultBody,
          linkPage: "attendance",
          linkRefId: idNum,
          sourceType: "attendance_request",
        });
      } catch (e) {
        console.error("[notify] 결재 결과 알림 생성 실패:", e);
      }
    }

    return NextResponse.json({
      id: result.updated.id,
      status: result.updated.status,
      appliedDays: result.applied,
      calendarEventId,
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
async function handleTripApproval(_request: NextRequest, body: any) {
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
  const viewerIsCeoTrip = session.user.role === "ceo";
  const viewerIsAdminTrip = isAdminSession(session);

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
  const approverFilter: any = viewerIsCeoTrip
    ? {} // CEO는 제한 없음
    : {
        OR: [
          { approverIds: { has: approverEmployeeId as number } },
          { deputyApproverId: approverEmployeeId as number },
          ...(viewerIsAdminTrip ? [{ approverIds: { isEmpty: true } }] : []),
        ],
      };

  const targetWhere: any = {
    tripEventId: eventIdNum,
    approvalStatus: "pending",
    ...approverFilter,
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
  //  - 승인된 참석자 각각에 대해 근태(attendance_request) 생성
  //  - 이벤트 단위로 캘린더 재구성 한 번
  // 트랜잭션 밖에서 실행 — 외부 호출 시간 동안 DB 락 잡지 않음.
  if (action === "approve" && targetIds.length > 0) {
    for (const pid of targetIds) {
      try {
        await createTripParticipantAttendanceRequests(pid);
      } catch (e) {
        console.error(
          `[trip-approval] createTripParticipantAttendanceRequests(${pid}) 실패:`,
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
          type: "approval_result",
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

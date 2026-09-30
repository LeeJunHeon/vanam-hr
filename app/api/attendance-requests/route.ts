import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  getTargetEmployeeId,
  requireSession,
  isAdminSession,
} from "@/lib/auth-helpers";
import { createNotifications } from "@/lib/notify";
import type { Prisma } from "@/app/generated/prisma/client";
import {
  createAttendanceRequest,
  validateAttendanceRequestInput,
  decideApprovalRoute,
  approvalRouteFields,
  applyAutoApprovalInTx,
  runAutoApprovalSideEffects,
} from "@/lib/create-attendance-request";
import { revertCancelledRequestFromDaily } from "@/lib/finalize-approval";

function parseDate(s: string | null | undefined): Date | null {
  if (!s || typeof s !== "string") return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(s + "T00:00:00.000Z");
  return isNaN(d.getTime()) ? null : d;
}

function ymdFromDate(d: Date): string {
  return d.toISOString().split("T")[0];
}

// 캘린더 일정 삭제 — calendar-syncer DELETE endpoint 호출.
// 실패해도 throw (호출자가 try/catch로 멱등 처리).
async function deleteCalendarEvent(
  calendarId: string,
  eventId: string
): Promise<void> {
  const base = process.env.CALENDAR_SYNCER_URL;
  if (!base) {
    throw new Error("CALENDAR_SYNCER_URL env not set");
  }
  const url = `${base}/internal/calendar-event/${encodeURIComponent(eventId)}`;
  const res = await fetch(url, {
    method: "DELETE",
    headers: {
      "Content-Type": "application/json",
      "X-Internal-Token": process.env.INTERNAL_API_TOKEN ?? "",
    },
    body: JSON.stringify({ calendar_id: calendarId }),
  });
  if (!res.ok) {
    throw new Error(`calendar-syncer DELETE failed: ${res.status}`);
  }
}

// GET /api/attendance-requests?employeeId=N&status=...&from=...&to=...
// 비관리자: 본인 요청만, 관리자: 다른 직원도 조회 가능.
export async function GET(request: NextRequest) {
  try {
    const r = await getTargetEmployeeId(request);
    if (!r.ok) return r.response;
    const employeeId = r.employeeId;

    const { searchParams } = new URL(request.url);
    const status = searchParams.get("status") || "";
    const fromRaw = searchParams.get("from");
    const toRaw = searchParams.get("to");

    const where: any = { employeeId };
    if (status) where.status = status;
    if (fromRaw || toRaw) {
      where.startDate = {};
      if (fromRaw) {
        const f = parseDate(fromRaw);
        if (f) where.startDate.gte = f;
      }
      if (toRaw) {
        const t = parseDate(toRaw);
        if (t) {
          const next = new Date(t);
          next.setUTCDate(next.getUTCDate() + 1);
          where.startDate.lt = next;
        }
      }
    }

    const requests = await prisma.attendanceRequest.findMany({
      where,
      orderBy: [{ requestedAt: "desc" }],
      include: {
        category: {
          select: {
            id: true,
            code: true,
            name: true,
            type: true,
            displayColor: true,
            requireApproval: true,
          },
        },
        primaryApprover: {
          select: { id: true, employeeNo: true, name: true },
        },
        deputyApprover: {
          select: { id: true, employeeNo: true, name: true },
        },
        approvedBy: { select: { id: true, employeeNo: true, name: true } },
      },
    });

    return NextResponse.json(
      requests.map((r) => ({
        id: r.id,
        employeeId: r.employeeId,
        categoryId: r.categoryId,
        categoryCode: r.category.code,
        categoryName: r.category.name,
        categoryType: r.category.type,
        categoryColor: r.category.displayColor,
        requestType: r.requestType,
        startDate: ymdFromDate(r.startDate),
        endDate: ymdFromDate(r.endDate),
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
        approvedByName: r.approvedBy?.name ?? null,
        approvedAt: r.approvedAt ? r.approvedAt.toISOString() : null,
        rejectReason: r.rejectReason,
        requestedAt: r.requestedAt.toISOString(),
        // Phase 6-2E 캘린더 등록 정보
        calendarSourceId: r.calendarSourceId ?? null,
        calendarEventTitle: r.calendarEventTitle ?? null,
        calendarEventDescription: r.calendarEventDescription ?? null,
        externalSource: r.externalSource ?? null,
        externalEventId: r.externalEventId ?? null,
        cancelSource: r.cancelSource ?? null,
      }))
    );
  } catch (error) {
    console.error("GET /api/attendance-requests error:", error);
    return NextResponse.json(
      { error: "결재 요청 조회 실패" },
      { status: 500 }
    );
  }
}

// POST /api/attendance-requests — 본인 신청
// body.employeeId는 비관리자의 경우 본인 employeeId여야 함.
export async function POST(request: NextRequest) {
  try {
    const sessionR = await requireSession();
    if (!sessionR.ok) return sessionR.response;
    const { session } = sessionR;
    const ownId = session.user.employeeId;
    const isAdmin = isAdminSession(session);

    const body = await request.json();
    const {
      employeeId,
      categoryId,
      startDate,
      endDate,
      reason,
      correctedCheckIn,
      correctedCheckOut,
      // Phase 6-2E 캘린더 등록 정보 (선택)
      calendarSourceId,
      calendarEventTitle,
      calendarEventDescription,
    } = body;

    if (!employeeId || !categoryId || !startDate || !endDate) {
      return NextResponse.json(
        { error: "employeeId, categoryId, startDate, endDate는 필수입니다." },
        { status: 400 }
      );
    }

    const employeeIdNum = Number(employeeId);
    const categoryIdNum = Number(categoryId);

    if (!Number.isInteger(employeeIdNum) || !Number.isInteger(categoryIdNum)) {
      return NextResponse.json(
        { error: "employeeId, categoryId는 정수여야 합니다." },
        { status: 400 }
      );
    }

    // 비관리자는 본인만 신청 가능
    if (!isAdmin) {
      if (!Number.isInteger(ownId)) {
        return NextResponse.json(
          {
            error:
              "본인 직원 정보가 매핑되어 있지 않습니다. 관리자에게 직원 등록을 요청하세요.",
          },
          { status: 403 }
        );
      }
      if (employeeIdNum !== ownId) {
        return NextResponse.json(
          { error: "본인 명의로만 신청할 수 있습니다." },
          { status: 403 }
        );
      }
    }

    const result = await createAttendanceRequest({
      employeeId: employeeIdNum,
      categoryId: categoryIdNum,
      startDate,
      endDate,
      reason,
      correctedCheckIn,
      correctedCheckOut,
      calendarSourceId,
      calendarEventTitle,
      calendarEventDescription,
    });
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }
    return NextResponse.json(
      { id: result.id, status: result.status },
      { status: 201 }
    );
  } catch (error) {
    console.error("POST /api/attendance-requests error:", error);
    return NextResponse.json(
      { error: "결재 요청 등록 실패" },
      { status: 500 }
    );
  }
}

// PUT /api/attendance-requests?id=N
// 두 흐름: action="cancel" 취소 / 그 외 필드 수정 (수정은 pending 만 — 신청과 같은 검사·결재선 재계산,
//        승인 초기화, requested_at 갱신. 자동승인 대상이 되면 바로 auto_approved + 후처리)
// 비관리자: 본인 요청만 수정/취소 가능.
export async function PUT(request: NextRequest) {
  try {
    const sessionR = await requireSession();
    if (!sessionR.ok) return sessionR.response;
    const { session } = sessionR;
    const ownId = session.user.employeeId;
    const isAdmin = isAdminSession(session);

    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");
    if (!id) {
      return NextResponse.json({ error: "id 파라미터 필요" }, { status: 400 });
    }
    const idNum = Number(id);

    const body = await request.json();
    const {
      action, // "cancel" | undefined
      categoryId,
      startDate,
      endDate,
      reason,
      correctedCheckIn,
      correctedCheckOut,
      // Phase 6-2E 캘린더 등록 정보 (수정 시)
      calendarSourceId,
      calendarEventTitle,
      calendarEventDescription,
    } = body;

    const before = await prisma.attendanceRequest.findUnique({
      where: { id: idNum },
    });
    if (!before) {
      return NextResponse.json(
        { error: "요청을 찾을 수 없습니다." },
        { status: 404 }
      );
    }

    // 본인 검증 (관리자 우회 허용)
    if (!isAdmin) {
      if (!Number.isInteger(ownId) || before.employeeId !== ownId) {
        return NextResponse.json(
          { error: "본인의 요청만 수정/취소할 수 있습니다." },
          { status: 403 }
        );
      }
    }

    // Phase 6-2E: cancel은 approved/auto_approved 상태도 허용 (캘린더 삭제 동기화)
    const isCancelAction = action === "cancel";
    const cancelAllowedStatuses = ["pending", "auto_approved", "approved"];
    if (isCancelAction) {
      if (!cancelAllowedStatuses.includes(before.status)) {
        return NextResponse.json(
          { error: `'${before.status}' 상태는 취소할 수 없습니다.` },
          { status: 409 }
        );
      }
    } else {
      // 일반 수정은 pending만 허용 (기존 동작)
      if (before.status !== "pending") {
        return NextResponse.json(
          { error: "결재 대기 상태가 아니므로 수정할 수 없습니다." },
          { status: 409 }
        );
      }
    }

    // 취소 흐름
    if (isCancelAction) {
      // 출장에서 만든 근태 기록은 출장 화면에서만 바꾼다(참석 날짜와 근태가 어긋나지 않도록).
      if (before.externalSource === "trip") {
        return NextResponse.json(
          {
            error:
              "출장 기록은 출장 및 외근 관리에서 날짜를 변경하거나 참석을 취소하세요.",
          },
          { status: 409 }
        );
      }

      // 1) attendance_daily 원복 — lib/finalize-approval revertCancelledRequestFromDaily 한 곳에서.
      //    결재 대기(pending)는 근태에 반영된 적이 없으므로 attendance_daily 를 건드리지 않는다.
      const cat = await prisma.attendanceCategory.findUnique({
        where: { id: before.categoryId },
        select: { type: true, code: true },
      });
      const catType = cat?.type ?? null;
      const wasApplied = before.status === "approved" || before.status === "auto_approved";

      // 2) 원자적 트랜잭션 — status='cancelled' → 원복 → 결재 요청 알림 삭제
      const updated = await prisma.$transaction(async (tx) => {
        // 조회 이후 상태가 바뀌었으면(동시 승인·취소) 409
        const upd = await tx.attendanceRequest.updateMany({
          where: { id: idNum, status: before.status },
          // 사람 취소 — calendar-syncer 는 이 행을 캘린더에 일정이 남아 있어도 되살리지 않는다
          data: { status: "cancelled", cancelSource: "user" },
        });
        if (upd.count === 0) return null;

        let revertedDays = 0;
        if (wasApplied) {
          revertedDays = await revertCancelledRequestFromDaily(tx, {
            id: before.id,
            employeeId: before.employeeId,
            startDate: before.startDate,
            endDate: before.endDate,
            correctedCheckIn: before.correctedCheckIn,
            correctedCheckOut: before.correctedCheckOut,
            categoryType: catType,
          });
        }

        // 이 요청으로 생성된 결재 요청 알림 삭제 (결재자 종에 유령 알림 방지)
        //    linkRefId = 요청 id, type = 'approval_request' 인 알림만 제거.
        //    결재자가 여러 명이면 알림도 여러 개라 deleteMany. 매칭 없으면 0건(안전).
        await tx.notification.deleteMany({
          where: {
            linkRefId: BigInt(idNum),
            type: "approval_request",
          },
        });

        return { id: idNum, status: "cancelled", revertedDays };
      });
      if (!updated) {
        return NextResponse.json(
          { error: "요청 상태가 바뀌었습니다. 새로고침 후 다시 시도하세요." },
          { status: 409 }
        );
      }

      // 3) 캘린더 등록되어 있으면 삭제 시도 (멱등적, 실패해도 DB 취소는 유지)
      //    외부 API 호출은 트랜잭션 밖에서 — 트랜잭션 안에 두면 롤백/재시도 시 일정 중복 위험.
      //    취소가 확정된 뒤에 지운다(동시 처리로 409 가 나면 일정은 그대로 남는다).
      if (
        before.externalSource === "hr" &&
        before.externalEventId &&
        before.calendarSourceId
      ) {
        try {
          const calSource = await prisma.calendarSource.findUnique({
            where: { id: before.calendarSourceId },
            select: { calendarId: true },
          });
          if (calSource) {
            await deleteCalendarEvent(
              calSource.calendarId,
              before.externalEventId
            );
            console.log(
              `[cancel] 캘린더 일정 삭제 OK: eventId=${before.externalEventId}`
            );
          }
        } catch (e) {
          console.error(
            `[cancel] 캘린더 삭제 실패 (DB 취소는 유지):`,
            e
          );
        }
      }

      console.log(
        `[cancel] 결재 #${idNum} 취소 완료 — type=${catType}, ` +
          `이전 상태=${before.status}, 원복 일수=${updated.revertedDays}`
      );

      // 승인(approved) 상태에서 취소한 경우, 승인한 결재자에게 "취소됨" 알림.
      // (pending 취소는 위에서 요청 알림을 삭제했고, auto_approved는 결재자가 없어 알림 불필요.)
      if (before.status === "approved") {
        try {
          // 승인자 수집: approvedByIds(다중) 우선, 없으면 approvedById(단일).
          const approverTargets: number[] = [];
          if (Array.isArray(before.approvedByIds) && before.approvedByIds.length > 0) {
            approverTargets.push(...before.approvedByIds);
          } else if (Number.isInteger(before.approvedById)) {
            approverTargets.push(before.approvedById as number);
          }
          if (approverTargets.length > 0) {
            const reqEmp = await prisma.employee.findUnique({
              where: { id: before.employeeId },
              select: { name: true },
            });
            const catName2 = cat?.code
              ? (await prisma.attendanceCategory.findUnique({
                  where: { id: before.categoryId },
                  select: { name: true },
                }))?.name ?? "근태"
              : "근태";
            const requesterName = reqEmp?.name ?? "직원";
            await createNotifications({
              employeeIds: approverTargets,
              type: "cancel",
              title: "결재 취소",
              body: `${requesterName}님이 승인된 '${catName2}' 신청을 취소했습니다.`,
              linkPage: "approval",
              linkRefId: idNum,
              sourceType: "attendance_request",
            });
          }
        } catch (e) {
          console.error("[notify] 취소 알림 생성 실패:", e);
        }
      }

      return NextResponse.json({ id: updated.id, status: updated.status });
    }

    // 수정 흐름 — 결재 대기 중 수정 = 다시 신청.
    // 기존값에 바뀐 값을 합친 최종값으로 신청과 같은 검사·결재선 계산을 다시 한다.
    const toIsoOrNull = (d: Date | null) => (d ? d.toISOString() : null);
    const finalInput = {
      employeeId: before.employeeId,
      categoryId: categoryId !== undefined ? Number(categoryId) : before.categoryId,
      startDate: startDate !== undefined ? startDate : ymdFromDate(before.startDate),
      endDate: endDate !== undefined ? endDate : ymdFromDate(before.endDate),
      correctedCheckIn:
        correctedCheckIn !== undefined ? correctedCheckIn || null : toIsoOrNull(before.correctedCheckIn),
      correctedCheckOut:
        correctedCheckOut !== undefined ? correctedCheckOut || null : toIsoOrNull(before.correctedCheckOut),
    };
    if (!Number.isInteger(finalInput.categoryId)) {
      return NextResponse.json(
        { error: "categoryId는 정수여야 합니다." },
        { status: 400 }
      );
    }
    const v = await validateAttendanceRequestInput(finalInput, { excludeRequestId: idNum });
    if (!v.ok) {
      return NextResponse.json({ error: v.error }, { status: v.status });
    }
    const route = await decideApprovalRoute(v.emp, v.category);
    if (!route.ok) {
      return NextResponse.json({ error: route.error }, { status: route.status });
    }

    const now = new Date();
    const data: Prisma.AttendanceRequestUncheckedUpdateManyInput = {
      categoryId: v.category.id,
      requestType: v.reqType,
      startDate: v.startD,
      endDate: v.endD,
      correctedCheckIn: v.cciDate,
      correctedCheckOut: v.ccoDate,
      ...approvalRouteFields(route),
      // 기존 승인 초기화 + 다시 신청(대리 위임 시간도 여기서 다시 센다)
      approvedByIds: [],
      approvedById: null,
      requestedAt: now,
      ...(route.autoApprove ? { status: "auto_approved", approvedAt: now } : {}),
    };
    if (reason !== undefined) data.reason = reason?.trim() || null;
    // Phase 6-2E 캘린더 필드 수정
    if (calendarSourceId !== undefined) {
      data.calendarSourceId =
        calendarSourceId === null || calendarSourceId === ""
          ? null
          : Number(calendarSourceId);
    }
    if (calendarEventTitle !== undefined) {
      data.calendarEventTitle = calendarEventTitle?.trim() || null;
    }
    if (calendarEventDescription !== undefined) {
      data.calendarEventDescription =
        calendarEventDescription?.trim() || null;
    }

    const saved = await prisma.$transaction(async (tx) => {
      // 조회 이후 상태가 바뀌었으면(동시 승인·취소) 409
      const upd = await tx.attendanceRequest.updateMany({
        where: { id: idNum, status: "pending" },
        data,
      });
      if (upd.count === 0) return null;

      // 이 신청의 기존 결재 요청 알림 삭제 (결재선이 바뀌었거나 승인이 초기화됨)
      await tx.notification.deleteMany({
        where: { linkRefId: BigInt(idNum), type: "approval_request" },
      });

      const req = await tx.attendanceRequest.findUniqueOrThrow({ where: { id: idNum } });
      if (route.autoApprove) {
        await applyAutoApprovalInTx(tx, req, v.category);
      }
      return req;
    });
    if (!saved) {
      return NextResponse.json(
        { error: "요청 상태가 바뀌었습니다. 새로고침 후 다시 시도하세요." },
        { status: 409 }
      );
    }

    if (route.autoApprove) {
      // 자동승인 → 캘린더 등록 + 팀 일정 알림 (트랜잭션 밖, 실패해도 수정 유지)
      await runAutoApprovalSideEffects(saved.id, "attendance-requests:edit");
    } else if (route.approverIds.length > 0) {
      try {
        await createNotifications({
          employeeIds: route.approverIds,
          type: "approval_request",
          title: "결재 요청 (수정됨)",
          body: `${v.emp.name ?? "직원"}님의 ${v.category.name} 결재 요청이 수정되었습니다`,
          linkPage: "approval",
          linkRefId: saved.id,
          sourceType: "attendance_request",
        });
      } catch (e) {
        console.error("[notify] 수정 결재 요청 알림 생성 실패:", e);
      }
    }
    return NextResponse.json({ id: saved.id, status: saved.status });
  } catch (error) {
    console.error("PUT /api/attendance-requests error:", error);
    return NextResponse.json(
      { error: "결재 요청 수정 실패" },
      { status: 500 }
    );
  }
}

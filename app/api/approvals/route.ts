import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getApproverId, requireSession } from "@/lib/auth-helpers";

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

    let where: any = {};
    if (status === "pending") {
      where = {
        status: "pending",
        OR: [
          { primaryApproverId: approverId },
          { deputyApproverId: approverId },
        ],
      };
    } else if (status === "approved" || status === "rejected") {
      where = { status, approvedById: approverId };
    } else {
      // 본인이 결재한 전체 이력
      where = {
        approvedById: approverId,
        status: { in: ["approved", "rejected"] },
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

    return NextResponse.json(
      requests.map((r) => {
        const isPrimary = r.primaryApproverId === approverId;
        const isDeputy = r.deputyApproverId === approverId;
        const autoDelegateHours =
          r.employee.department?.approvalLine?.autoDelegateHours ?? 24;
        const delegated = isDelegationElapsed(r.requestedAt, autoDelegateHours);
        const hoursLeft = hoursUntilDelegation(r.requestedAt, autoDelegateHours);

        let canApprove = false;
        let myRole: "primary" | "deputy" | null = null;
        if (isPrimary) {
          canApprove = true;
          myRole = "primary";
        } else if (isDeputy) {
          canApprove = delegated;
          myRole = "deputy";
        }

        // 본인이 신청자면 차단
        if (r.employeeId === approverId) {
          canApprove = false;
        }

        return {
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
          // Phase 6-2E 캘린더 등록 정보
          calendarSourceId: r.calendarSourceId ?? null,
          calendarEventTitle: r.calendarEventTitle ?? null,
          calendarEventDescription: r.calendarEventDescription ?? null,
          externalSource: r.externalSource ?? null,
          externalEventId: r.externalEventId ?? null,
        };
      })
    );
  } catch (error) {
    console.error("GET /api/approvals error:", error);
    return NextResponse.json(
      { error: "결재 목록 조회 실패" },
      { status: 500 }
    );
  }
}

// PUT /api/approvals?id=N — 승인/반려
// body: { approverId, action: 'approve' | 'reject', rejectReason? }
// 비관리자는 본인 명의 결재만 수행 가능. 관리자는 다른 결재자 명의 가능.
export async function PUT(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");
    if (!id) {
      return NextResponse.json({ error: "id 파라미터 필요" }, { status: 400 });
    }
    const idNum = Number(id);

    const body = await request.json();
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

    // 본인이 자기 신청을 결재하는 케이스 차단
    if (target.employeeId === approverIdNum) {
      return NextResponse.json(
        { error: "본인의 신청은 결재할 수 없습니다." },
        { status: 403 }
      );
    }

    const isPrimary = target.primaryApproverId === approverIdNum;
    const isDeputy = target.deputyApproverId === approverIdNum;
    if (!isPrimary && !isDeputy) {
      return NextResponse.json(
        { error: "이 요청의 결재자가 아닙니다." },
        { status: 403 }
      );
    }

    // 대리인 경우 자동 위임 시간 경과 검증
    if (!isPrimary && isDeputy) {
      const hours =
        target.employee.department?.approvalLine?.autoDelegateHours ?? 24;
      const elapsed = Date.now() - target.requestedAt.getTime();
      if (elapsed < hours * 60 * 60 * 1000) {
        return NextResponse.json(
          {
            error:
              "메인 결재자 응답 대기 중입니다. 자동 위임까지 시간이 남아 있어 대리 결재가 불가합니다.",
          },
          { status: 403 }
        );
      }
    }

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

    // 정정의 경우 시프트 + grace 정책 미리 로드 (auto_status 재계산용)
    let shiftStartHHMM: string | null = null;
    let shiftEndHHMM: string | null = null;
    let graceInMinutes = 10;
    let graceOutMinutes = 0;

    if (action === "approve" && category.type === "correction") {
      // 시프트 조회 (정정 날짜 기준)
      const workDateStr = target.startDate.toISOString().split("T")[0];
      const shiftRows = await prisma.$queryRaw<
        Array<{ start_time: string | null; end_time: string | null; type: string }>
      >`
        SELECT sp.start_time::text AS start_time, sp.end_time::text AS end_time, sp.type
        FROM hr.employee_shifts es
        JOIN hr.shift_patterns sp ON sp.id = es.pattern_id
        WHERE es.employee_id = ${target.employeeId}
          AND es.start_date <= ${workDateStr}::date
          AND (es.end_date IS NULL OR es.end_date >= ${workDateStr}::date)
          AND sp.is_active = true
        LIMIT 1
      `;
      if (shiftRows.length > 0 && shiftRows[0].type !== "off") {
        shiftStartHHMM = shiftRows[0].start_time;
        shiftEndHHMM = shiftRows[0].end_time;
      }

      // 정책 조회
      const policies = await prisma.policySetting.findMany({
        where: { key: { in: ["grace_in_minutes", "grace_out_minutes"] } },
      });
      for (const p of policies) {
        const v = parseInt(p.value, 10);
        if (!isNaN(v)) {
          if (p.key === "grace_in_minutes") graceInMinutes = v;
          if (p.key === "grace_out_minutes") graceOutMinutes = v;
        }
      }
    }

    // auto_status 계산 헬퍼
    function determineAutoStatus(
      checkIn: Date | null,
      checkOut: Date | null,
      startHHMM: string | null,
      endHHMM: string | null,
      graceIn: number,
      graceOut: number
    ): string | null {
      // 시프트 없음 → 단순 판정
      if (!startHHMM || !endHHMM) {
        if (checkIn && checkOut) return "normal";
        if (!checkIn && !checkOut) return "absent";
        return null;
      }
      // 시프트 있음 + 둘 다 NULL
      if (!checkIn && !checkOut) return "absent";
      // 한쪽만 NULL → 판정 보류
      if (!checkIn || !checkOut) return null;
      // 시프트 시각 파싱
      const [shH, shM] = startHHMM.split(":").map(Number);
      const [ehH, ehM] = endHHMM.split(":").map(Number);
      if ([shH, shM, ehH, ehM].some(isNaN)) return "normal";
      // 시프트 총 시간 (자정 넘김 처리)
      let shiftMinutes = ehH * 60 + ehM - (shH * 60 + shM);
      if (shiftMinutes <= 0) shiftMinutes += 24 * 60;
      // 시프트 시작 datetime (check_in 날짜 기준)
      const shiftStart = new Date(checkIn);
      shiftStart.setHours(shH, shM, 0, 0);
      const lateThreshold = new Date(shiftStart.getTime() + graceIn * 60 * 1000);
      if (checkIn > lateThreshold) return "late";
      // 근무시간 부족 (조퇴)
      const actualMinutes = Math.floor(
        (checkOut.getTime() - checkIn.getTime()) / (60 * 1000)
      );
      const requiredMinutes = shiftMinutes - graceOut;
      if (actualMinutes < requiredMinutes) return "early_leave";
      return "normal";
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
          ...calendarUpdateFields,
        },
      });

      // 반려는 attendance_daily 안 건드림
      if (action !== "approve") {
        return { updated, applied: 0 };
      }

      let applied = 0;

      if (category.type === "correction") {
        // 정정: 단일 날짜만, 기존 행이 있으면 선택적 컬럼 덮어쓰기
        const existing = await tx.attendanceDaily.findUnique({
          where: {
            employeeId_workDate: {
              employeeId: target.employeeId,
              workDate: target.startDate,
            },
          },
        });

        const newCheckIn = target.correctedCheckIn ?? existing?.checkIn ?? null;
        const newCheckOut = target.correctedCheckOut ?? existing?.checkOut ?? null;

        // work_minutes 재계산
        let newWorkMinutes: number | null = null;
        if (newCheckIn && newCheckOut) {
          newWorkMinutes = Math.floor(
            (newCheckOut.getTime() - newCheckIn.getTime()) / (60 * 1000)
          );
        }

        // auto_status 재계산
        const newAutoStatus = determineAutoStatus(
          newCheckIn,
          newCheckOut,
          shiftStartHHMM,
          shiftEndHHMM,
          graceInMinutes,
          graceOutMinutes
        );

        // Phase 6-2I: 첫 정정 시 원본 시간 백업 (이후 정정은 첫 백업값 그대로 유지)
        const shouldBackupOriginal =
          existing &&
          existing.originalCheckIn === null &&
          existing.originalCheckOut === null;

        await tx.attendanceDaily.upsert({
          where: {
            employeeId_workDate: {
              employeeId: target.employeeId,
              workDate: target.startDate,
            },
          },
          create: {
            employeeId: target.employeeId,
            workDate: target.startDate,
            checkIn: newCheckIn,
            checkOut: newCheckOut,
            workMinutes: newWorkMinutes,
            autoStatus: newAutoStatus,
            isOverridden: true,
            note: `결재정정 #${updated.id}`,
          },
          update: {
            checkIn: newCheckIn,
            checkOut: newCheckOut,
            workMinutes: newWorkMinutes,
            autoStatus: newAutoStatus,
            isOverridden: true,
            note: existing?.note ?? `결재정정 #${updated.id}`,
            // Phase 6-2I: 첫 정정이면 정정 전 값 백업 (영구 보존)
            ...(shouldBackupOriginal && {
              originalCheckIn: existing.checkIn,
              originalCheckOut: existing.checkOut,
            }),
          },
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
              note: `결재 #${updated.id} (${category.name})`,
            },
            update: {
              categoryId: target.categoryId,
              autoStatus: "normal",
              isOverridden: true,
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

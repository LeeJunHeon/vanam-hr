import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  getTargetEmployeeId,
  requireSession,
  isAdminSession,
} from "@/lib/auth-helpers";
import { createNotifications } from "@/lib/notify";
import { createAttendanceRequest } from "@/lib/create-attendance-request";

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

// category.type → requestType 매핑
function categoryTypeToRequestType(categoryType: string): string {
  if (categoryType === "correction") return "correction";
  if (categoryType === "work") return "external_work";
  // leave, long_leave, 기타
  return "leave";
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
// 두 흐름: action="cancel" 취소 / 그 외 필드 수정 (둘 다 pending 만 가능)
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
      // 1) 캘린더 등록되어 있으면 삭제 시도 (멱등적, 실패해도 DB 취소는 진행)
      //    외부 API 호출은 트랜잭션 밖에서 — 트랜잭션 안에 두면 롤백/재시도 시 일정 중복 위험.
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
            `[cancel] 캘린더 삭제 실패 (DB 취소는 진행):`,
            e
          );
        }
      }

      // 2) attendance_daily 원복 — 카테고리 type별 분기
      //    승인 시 만들었던 attendance_daily 보정 행을 is_overridden=false로 풀어,
      //    다음 aggregator 사이클(60초 이내)이 WiFi/시프트 기준으로 재계산하게 한다.
      //    행을 DELETE하지 않음(이력/연속성 보존). 행이 없으면 skip.
      const cat = await prisma.attendanceCategory.findUnique({
        where: { id: before.categoryId },
        select: { type: true, code: true },
      });
      const catType = cat?.type ?? null;

      const dayMs = 24 * 60 * 60 * 1000;
      const revertDays: Date[] = [];
      if (catType === "leave" || catType === "work") {
        // startDate~endDate 각 일자 (UTC 자정 기준 — DB workDate가 date 컬럼이라 시각 비교 안 함)
        const start = new Date(before.startDate);
        const end = new Date(before.endDate);
        for (let t = start.getTime(); t <= end.getTime(); t += dayMs) {
          revertDays.push(new Date(t));
        }
      } else if (catType === "correction") {
        // 정정은 단일 날짜
        revertDays.push(new Date(before.startDate));
      }

      // 3) 원자적 트랜잭션 — 원복 + status='cancelled'
      const updated = await prisma.$transaction(async (tx) => {
        if (catType === "leave" || catType === "work") {
          // 휴가/외근/출장/재택 취소:
          //  - 각 날짜의 행을 개별 확인.
          //  - WiFi 기록(checkIn/checkOut)이 둘 다 없으면 → 빈 행이므로 삭제
          //    (휴무일/미래날짜는 aggregator가 손대지 않아, 안 지우면 잘못된 auto_status가 남음)
          //  - 하나라도 있으면 → categoryId 등 보정 흔적만 풀고
          //    autoStatus/workMinutes를 null로 비워 aggregator가 WiFi/시프트로 재계산하게 함.
          for (const wd of revertDays) {
            const existing = await tx.attendanceDaily.findUnique({
              where: {
                employeeId_workDate: {
                  employeeId: before.employeeId,
                  workDate: wd,
                },
              },
            });
            if (!existing) continue;

            // 수동 정정(manual)으로 보호된 행은 건드리지 않는다(이 취소와 무관한 보정).
            // (정상 흐름에선 leave/work 보정행의 override_source는 'manual'이지만,
            //  이 취소는 그 보정을 만든 당사자이므로 푸는 게 맞다. 단 checkIn/out 유무로 분기.)
            const hasWifi =
              existing.checkIn !== null || existing.checkOut !== null;

            if (!hasWifi) {
              // WiFi 기록 없음 + 일정 취소 → 빈 행 → 삭제
              await tx.attendanceDaily.delete({
                where: { id: existing.id },
              });
            } else {
              // WiFi 기록 있음 → 보정만 풀고 aggregator 재계산에 위임
              await tx.attendanceDaily.update({
                where: { id: existing.id },
                data: {
                  categoryId: null,
                  isOverridden: false,
                  note: null,
                  overrideSource: null,
                  autoStatus: null,   // aggregator 재계산 트리거
                  workMinutes: null,  // aggregator 재계산 트리거
                  // checkIn/checkOut은 유지 (WiFi 원본)
                },
              });
            }
          }
        } else if (catType === "correction") {
          // 정정: originalCheckIn/Out이 있으면 복원, 없으면(원래 빈 자리에 정정 채운 경우)
          //       checkIn/Out 모두 null로. workMinutes는 null로 두고 aggregator에 위임.
          for (const wd of revertDays) {
            const existing = await tx.attendanceDaily.findUnique({
              where: {
                employeeId_workDate: {
                  employeeId: before.employeeId,
                  workDate: wd,
                },
              },
            });
            if (!existing) continue;
            const hasOriginal =
              existing.originalCheckIn !== null ||
              existing.originalCheckOut !== null;
            await tx.attendanceDaily.update({
              where: { id: existing.id },
              data: {
                checkIn: hasOriginal ? existing.originalCheckIn : null,
                checkOut: hasOriginal ? existing.originalCheckOut : null,
                originalCheckIn: null,
                originalCheckOut: null,
                workMinutes: null, // aggregator 재계산 트리거
                isOverridden: false,
                // Phase 6-2L+: 정정 흔적 제거
                note: null,
                overrideSource: null,
              },
            });
          }
        }

        // 4) attendance_requests 상태만 cancelled로 (이력 보존, 삭제 X)
        const cancelledReq = await tx.attendanceRequest.update({
          where: { id: idNum },
          data: { status: "cancelled" },
        });

        // 5) 이 요청으로 생성된 결재 요청 알림 삭제 (결재자 종에 유령 알림 방지)
        //    linkRefId = 요청 id, type = 'approval_request' 인 알림만 제거.
        //    결재자가 여러 명이면 알림도 여러 개라 deleteMany. 매칭 없으면 0건(안전).
        await tx.notification.deleteMany({
          where: {
            linkRefId: BigInt(idNum),
            type: "approval_request",
          },
        });

        return cancelledReq;
      });

      console.log(
        `[cancel] 결재 #${idNum} 취소 완료 — type=${catType}, ` +
          `원복 일수=${revertDays.length}`
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

    // 수정 흐름
    const data: any = {};
    if (categoryId !== undefined) {
      const cid = Number(categoryId);
      if (!Number.isInteger(cid)) {
        return NextResponse.json(
          { error: "categoryId는 정수여야 합니다." },
          { status: 400 }
        );
      }
      const cat = await prisma.attendanceCategory.findUnique({
        where: { id: cid },
      });
      if (!cat || !cat.isActive) {
        return NextResponse.json(
          { error: "활성 근태 항목이 아닙니다." },
          { status: 400 }
        );
      }
      data.categoryId = cid;
      data.requestType = categoryTypeToRequestType(cat.type);
    }
    if (startDate !== undefined) {
      const d = parseDate(startDate);
      if (!d)
        return NextResponse.json(
          { error: "startDate 형식 오류" },
          { status: 400 }
        );
      data.startDate = d;
    }
    if (endDate !== undefined) {
      const d = parseDate(endDate);
      if (!d)
        return NextResponse.json(
          { error: "endDate 형식 오류" },
          { status: 400 }
        );
      data.endDate = d;
    }
    // 시작/종료일 일관성 (최종값 기준)
    const finalStart = data.startDate ?? before.startDate;
    const finalEnd = data.endDate ?? before.endDate;
    if (finalEnd < finalStart) {
      return NextResponse.json(
        { error: "종료일은 시작일 이후여야 합니다." },
        { status: 400 }
      );
    }
    if (reason !== undefined) data.reason = reason?.trim() || null;
    if (correctedCheckIn !== undefined) {
      data.correctedCheckIn = correctedCheckIn
        ? new Date(correctedCheckIn)
        : null;
    }
    if (correctedCheckOut !== undefined) {
      data.correctedCheckOut = correctedCheckOut
        ? new Date(correctedCheckOut)
        : null;
    }

    // Phase 6-2G: 정정 외 카테고리는 시간 한쪽만 입력 차단 (병합 후 최종 상태 기준)
    // 카테고리는 정정인지 판단해야 하므로 before.requestType 사용
    if (before.requestType !== "correction") {
      const finalCci =
        data.correctedCheckIn !== undefined
          ? data.correctedCheckIn
          : before.correctedCheckIn;
      const finalCco =
        data.correctedCheckOut !== undefined
          ? data.correctedCheckOut
          : before.correctedCheckOut;
      if (!!finalCci !== !!finalCco) {
        return NextResponse.json(
          {
            error:
              "시작 시간과 종료 시간 중 하나만 입력할 수 없습니다. 모두 입력하거나 모두 비워주세요.",
          },
          { status: 400 }
        );
      }
      if (finalCci && finalCco && finalCco < finalCci) {
        return NextResponse.json(
          { error: "종료 시간은 시작 시간 이후여야 합니다." },
          { status: 400 }
        );
      }
    }

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

    const updated = await prisma.attendanceRequest.update({
      where: { id: idNum },
      data,
    });
    return NextResponse.json({ id: updated.id, status: updated.status });
  } catch (error) {
    console.error("PUT /api/attendance-requests error:", error);
    return NextResponse.json(
      { error: "결재 요청 수정 실패" },
      { status: 500 }
    );
  }
}

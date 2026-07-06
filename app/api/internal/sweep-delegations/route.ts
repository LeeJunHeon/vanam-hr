import { NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { prisma } from "@/lib/prisma";
import { createNotifications } from "@/lib/notify";
import { applyCorrectionToDaily } from "@/lib/attendance-correction";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/internal/sweep-delegations — 대리 위임 자동 마감 스윕.
// 대리결재자가 이미 승인했는데 위임 창(autoDelegateHours, 기본 24h) 경과 시점에
// 자동 확정이 안 되는 구멍을 메운다. 머신-투-머신(내부 시스템 전용).
// 인증: Authorization: Bearer <INTERNAL_API_TOKEN>. acting-user 불필요.

function safeStringEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

// YYYY-MM-DD 배열 생성 (startDate ~ endDate inclusive) — approvals route와 동일 로직.
function daysBetween(start: Date, end: Date): string[] {
  const days: string[] = [];
  const cur = new Date(start);
  while (cur <= end) {
    days.push(cur.toISOString().split("T")[0]);
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return days;
}

export async function POST(request: Request) {
  const expected = process.env.INTERNAL_API_TOKEN;
  if (!expected || expected.length === 0) {
    return NextResponse.json({ error: "내부 토큰 미설정" }, { status: 500 });
  }
  const authHeader = request.headers.get("authorization") ?? "";
  const m = authHeader.match(/^Bearer\s+(.+)$/i);
  const token = m?.[1]?.trim() ?? "";
  if (!token || !safeStringEqual(token, expected)) {
    return NextResponse.json({ error: "인증 실패" }, { status: 401 });
  }

  try {
    // 1) 후보 조회: pending + 대리결재자 지정된 요청
    const candidates = await prisma.attendanceRequest.findMany({
      where: { status: "pending", deputyApproverId: { not: null } },
      include: {
        category: true,
        employee: {
          select: {
            departmentId: true,
            department: {
              select: {
                approvalLines: {
                  where: { categoryId: null },
                  select: { autoDelegateHours: true },
                },
              },
            },
          },
        },
      },
    });

    let finalized = 0;

    for (const req of candidates) {
      // 2) 코드 필터
      // - 대리 승인 확인: 대리결재자가 이미 승인자 목록에 있어야 함
      const deputyId = req.deputyApproverId as number;
      if (!(req.approvedByIds ?? []).includes(deputyId)) continue;

      // - 위임 창 경과 확인
      const h = req.employee.department?.approvalLines?.[0]?.autoDelegateHours ?? 24;
      if (Date.now() - req.requestedAt.getTime() < h * 3600 * 1000) continue;

      // 3) finalize — approvals PUT "최종 승인"과 동일하게(트랜잭션)
      try {
        const now = new Date();
        const category = req.category;

        await prisma.$transaction(async (tx) => {
          await tx.attendanceRequest.update({
            where: { id: req.id },
            data: {
              status: "approved",
              approvedById: deputyId,
              approvedAt: now,
              rejectReason: null,
            },
          });

          if (category.type === "correction") {
            await applyCorrectionToDaily(tx, {
              employeeId: req.employeeId,
              workDate: req.startDate,
              correctedCheckIn: req.correctedCheckIn,
              correctedCheckOut: req.correctedCheckOut,
              requestId: req.id,
            });
          } else if (category.type === "leave" || category.type === "work") {
            const days = daysBetween(req.startDate, req.endDate);
            for (const ymd of days) {
              const wd = new Date(ymd + "T00:00:00.000Z");
              const existing = await tx.attendanceDaily.findUnique({
                where: {
                  employeeId_workDate: { employeeId: req.employeeId, workDate: wd },
                },
              });
              await tx.attendanceDaily.upsert({
                where: {
                  employeeId_workDate: { employeeId: req.employeeId, workDate: wd },
                },
                create: {
                  employeeId: req.employeeId,
                  workDate: wd,
                  checkIn: null,
                  checkOut: null,
                  categoryId: req.categoryId,
                  autoStatus: "normal",
                  isOverridden: true,
                  overrideSource: "manual",
                  note: `결재 #${req.id} (${category.name})`,
                },
                update: {
                  categoryId: req.categoryId,
                  autoStatus: "normal",
                  isOverridden: true,
                  overrideSource: "manual",
                  note: existing?.note ?? `결재 #${req.id} (${category.name})`,
                },
              });
            }
          }
        });

        // 결재 결과 알림 (신청자에게). 본인=대리결재자면 스킵.
        if (req.employeeId !== deputyId) {
          try {
            await createNotifications({
              employeeIds: [req.employeeId],
              type: "approval_result",
              title: "결재 승인",
              body: `${category.name} 신청이 승인되었습니다.`,
              linkPage: "request",
              linkRefId: req.id,
              sourceType: "attendance_request",
            });
          } catch (e) {
            console.error(
              `[sweep-delegations] 알림 생성 실패 (req=${req.id}):`,
              e
            );
          }
        }

        finalized++;
      } catch (e) {
        // 개별 요청 실패는 로그만 — 다음 요청 계속
        console.error(`[sweep-delegations] finalize 실패 (req=${req.id}):`, e);
      }
    }

    return NextResponse.json({ ok: true, finalized });
  } catch (error) {
    console.error("POST /api/internal/sweep-delegations error:", error);
    return NextResponse.json({ error: "위임 스윕 실패" }, { status: 500 });
  }
}

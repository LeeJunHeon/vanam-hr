import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireHrWriteAuth } from "@/lib/internal-write-auth";
import { resolveHrIdentity } from "@/lib/internal-identity";
import { applyCorrectionToDaily } from "@/lib/attendance-correction";
import { createNotifications } from "@/lib/notify";

export const dynamic = "force-dynamic";

// 대리 위임 시간 경과 판정 (웹 approvals 라우트와 동일)
function isDelegationElapsed(requestedAt: Date, hours: number): boolean {
  const elapsed = Date.now() - requestedAt.getTime();
  return elapsed >= hours * 60 * 60 * 1000;
}

// startDate~endDate inclusive YYYY-MM-DD 배열 (웹 approvals 라우트와 동일)
function daysBetween(start: Date, end: Date): string[] {
  const days: string[] = [];
  const cur = new Date(start);
  while (cur <= end) {
    days.push(cur.toISOString().split("T")[0]);
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return days;
}

type ProcessResult =
  | { ok: true; id: number; status: string; finalized: boolean }
  | { ok: false; id: number; reason: string };

// 근태 신청 1건 결재. 웹 PUT(kind=attendance) finalize 규칙과 동일.
// ⚠️ 캘린더 등록(Google)만 제외 — 웹에서 처리. correction/leave/work의 attendance_daily 반영은 동일.
async function processOne(
  t: {
    id: number; employeeId: number; categoryId: number;
    startDate: Date; endDate: Date;
    correctedCheckIn: Date | null; correctedCheckOut: Date | null;
    status: string; approverIds: number[]; approvalMode: string; approvedByIds: number[];
    deputyApproverId: number | null; requestedAt: Date; autoDelegateHours: number;
  },
  approverId: number,
  role: "ceo" | "admin" | "employee",
  action: "approve" | "reject",
  rejectReason: string | null
): Promise<ProcessResult> {
  if (t.status !== "pending") return { ok: false, id: t.id, reason: "이미 처리된 건" };

  const isCeo = role === "ceo";
  const delegated = isDelegationElapsed(t.requestedAt, t.autoDelegateHours);
  const isApproverIn = t.approverIds.includes(approverId);
  const isDeputy = t.deputyApproverId === approverId && delegated;
  if (!isApproverIn && !isDeputy && !isCeo) {
    return { ok: false, id: t.id, reason: "결재 권한 없음(대리 위임 시간 미경과 등)" };
  }
  // 본인 신청은 일반 직원만 차단 (ADMIN/CEO는 본인 결재 허용)
  if (t.employeeId === approverId && role !== "admin" && role !== "ceo") {
    return { ok: false, id: t.id, reason: "본인 신청은 결재 불가" };
  }

  const category = await prisma.attendanceCategory.findUnique({ where: { id: t.categoryId } });
  if (!category) return { ok: false, id: t.id, reason: "카테고리 없음" };

  const now = new Date();

  if (action === "approve") {
    if ((t.approvedByIds ?? []).includes(approverId)) {
      return { ok: false, id: t.id, reason: "이미 승인함" };
    }
    const newApprovedBy = [...(t.approvedByIds ?? []), approverId];
    const decisive = isCeo || isDeputy;
    const fullyApproved = decisive
      ? true
      : t.approvalMode === "any"
      ? true
      : t.approverIds.every((id) => newApprovedBy.includes(id));

    // 부분 승인 — pending 유지, 근태 미반영
    if (!fullyApproved) {
      await prisma.attendanceRequest.update({
        where: { id: t.id },
        data: { approvedByIds: newApprovedBy },
      });
      return { ok: true, id: t.id, status: "pending", finalized: false };
    }

    // 최종 승인 → finalize (status + attendance_daily)
    await prisma.$transaction(async (tx) => {
      await tx.attendanceRequest.update({
        where: { id: t.id },
        data: {
          status: "approved",
          approvedById: approverId,
          approvedAt: now,
          rejectReason: null,
          approvedByIds: newApprovedBy,
        },
      });

      if (category.type === "correction") {
        await applyCorrectionToDaily(tx, {
          employeeId: t.employeeId,
          workDate: t.startDate,
          correctedCheckIn: t.correctedCheckIn,
          correctedCheckOut: t.correctedCheckOut,
          requestId: t.id,
        });
      } else if (category.type === "leave" || category.type === "work") {
        const days = daysBetween(t.startDate, t.endDate);
        for (const ymd of days) {
          const wd = new Date(ymd + "T00:00:00.000Z");
          const existing = await tx.attendanceDaily.findUnique({
            where: { employeeId_workDate: { employeeId: t.employeeId, workDate: wd } },
          });
          await tx.attendanceDaily.upsert({
            where: { employeeId_workDate: { employeeId: t.employeeId, workDate: wd } },
            create: {
              employeeId: t.employeeId, workDate: wd, checkIn: null, checkOut: null,
              categoryId: t.categoryId, autoStatus: "normal", isOverridden: true,
              overrideSource: "manual", note: `결재 #${t.id} (${category.name})`,
            },
            update: {
              categoryId: t.categoryId, autoStatus: "normal", isOverridden: true,
              overrideSource: "manual",
              note: existing?.note ?? `결재 #${t.id} (${category.name})`,
            },
          });
        }
      }
    });

    if (t.employeeId !== approverId) {
      try {
        await createNotifications({
          employeeIds: [t.employeeId],
          type: "approval_result",
          title: "결재 승인",
          body: `${category.name} 신청이 승인되었습니다.`,
          linkPage: "attendance",
          linkRefId: t.id,
          sourceType: "attendance_request",
        });
      } catch (e) { console.error("[notify] 결재 결과 알림 실패:", e); }
    }
    return { ok: true, id: t.id, status: "approved", finalized: true };
  }

  // reject (즉시 finalize, 근태 미반영)
  await prisma.attendanceRequest.update({
    where: { id: t.id },
    data: {
      status: "rejected",
      approvedById: approverId,
      approvedAt: now,
      rejectReason: rejectReason?.trim() || null,
    },
  });
  if (t.employeeId !== approverId) {
    try {
      let body = `${category.name} 신청이 반려되었습니다.`;
      if (rejectReason?.trim()) body += ` (사유: ${rejectReason.trim()})`;
      await createNotifications({
        employeeIds: [t.employeeId],
        type: "approval_result",
        title: "결재 반려",
        body,
        linkPage: "attendance",
        linkRefId: t.id,
        sourceType: "attendance_request",
      });
    } catch (e) { console.error("[notify] 결재 결과 알림 실패:", e); }
  }
  return { ok: true, id: t.id, status: "rejected", finalized: true };
}

// POST /api/internal/approve-request — 챗 근태 결재(승인/반려).
// 결재자(권한)는 신원(x-acting-user-email→resolveHrIdentity)에서만. body로 위조 불가.
// target: 신청자 이름(영문) 또는 "전체". 내 결재 대기 큐(approverIds has me OR deputy=me) 안에서만 처리.
export async function POST(request: Request) {
  const auth = requireHrWriteAuth(request);
  if (!auth.ok) return auth.response;

  const identity = await resolveHrIdentity(auth.actingEmail);
  if (!Number.isInteger(identity.employeeId)) {
    return NextResponse.json(
      { error: "본인 직원 정보가 매핑되어 있지 않습니다. 관리자에게 직원 등록을 요청하세요." },
      { status: 403 }
    );
  }
  const approverId = identity.employeeId as number;
  const role = identity.role;

  let body: { target?: unknown; action?: unknown; rejectReason?: unknown };
  try { body = await request.json(); } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const targetRaw = typeof body.target === "string" ? body.target.trim() : "";
  const actionRaw = typeof body.action === "string" ? body.action.trim() : "";
  const rejectReason = typeof body.rejectReason === "string" ? body.rejectReason : null;

  const action: "approve" | "reject" | null =
    actionRaw === "승인" || actionRaw === "approve" ? "approve"
    : actionRaw === "반려" || actionRaw === "reject" ? "reject"
    : null;
  if (!action) {
    return NextResponse.json({ error: "결재 동작은 '승인' 또는 '반려'여야 합니다." }, { status: 400 });
  }
  if (!targetRaw) {
    return NextResponse.json({ error: "누구의 신청을 결재할지 알려주세요(신청자 이름 또는 '전체')." }, { status: 400 });
  }
  if (action === "reject" && !(rejectReason && rejectReason.trim())) {
    return NextResponse.json({ error: "반려는 사유(rejectReason)가 필수입니다." }, { status: 400 });
  }
  const isAll = targetRaw === "전체" || targetRaw.toLowerCase() === "all";
  if (action === "reject" && isAll) {
    return NextResponse.json({ error: "반려는 '전체'로 할 수 없습니다. 특정 신청자를 지정해 주세요." }, { status: 400 });
  }

  // 내 결재 대기 큐 (my-approvals와 동일 범위)
  const queue = await prisma.attendanceRequest.findMany({
    where: {
      status: "pending",
      OR: [{ approverIds: { has: approverId } }, { deputyApproverId: approverId }],
    },
    orderBy: [{ requestedAt: "desc" }],
    include: {
      employee: { select: { name: true } },
      category: { select: { name: true } },
    },
  });

  // 대상 필터: '전체' 또는 신청자 이름(정확→부분)
  let candidates = queue;
  if (!isAll) {
    const lower = targetRaw.toLowerCase();
    let m = queue.filter((r) => (r.employee?.name ?? "").toLowerCase() === lower);
    if (m.length === 0) m = queue.filter((r) => (r.employee?.name ?? "").toLowerCase().includes(lower));
    candidates = m;
  }
  if (candidates.length === 0) {
    const names = Array.from(new Set(queue.map((r) => r.employee?.name).filter(Boolean)));
    const hint = names.length > 0 ? ` 현재 결재 대기: ${names.join(", ")}` : " 현재 결재할 대기 건이 없습니다.";
    return NextResponse.json({ error: `결재할 대상을 찾지 못했습니다.${hint}` }, { status: 400 });
  }

  const results: Array<Record<string, unknown>> = [];
  for (const r of candidates) {
    const emp = await prisma.employee.findUnique({
      where: { id: r.employeeId },
      select: { department: { select: { approvalLine: { select: { autoDelegateHours: true } } } } },
    });
    const autoDelegateHours = emp?.department?.approvalLine?.autoDelegateHours ?? 24;

    const res = await processOne(
      {
        id: r.id, employeeId: r.employeeId, categoryId: r.categoryId,
        startDate: r.startDate, endDate: r.endDate,
        correctedCheckIn: r.correctedCheckIn, correctedCheckOut: r.correctedCheckOut,
        status: r.status, approverIds: r.approverIds, approvalMode: r.approvalMode,
        approvedByIds: r.approvedByIds, deputyApproverId: r.deputyApproverId,
        requestedAt: r.requestedAt, autoDelegateHours,
      },
      approverId, role, action, rejectReason
    );
    results.push({ requester: r.employee?.name ?? null, category: r.category?.name ?? null, ...res });
  }

  const processed = results.filter((x) => x.ok === true).length;
  const skipped = results.filter((x) => x.ok === false).length;
  return NextResponse.json({ ok: true, action, processed, skipped, results }, { status: 200 });
}

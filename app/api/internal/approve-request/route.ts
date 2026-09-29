import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireHrWriteAuth } from "@/lib/internal-write-auth";
import { resolveHrIdentity } from "@/lib/internal-identity";
import { pendingAttendanceWhere } from "@/lib/approval-inbox";
import { decideAttendanceApproval, type DecideFailureCode } from "@/lib/attendance-approval";

export const dynamic = "force-dynamic";

// 챗 결과 reason 문구 (결과 코드 → 기존 챗 문구)
const CHAT_REASON: Record<DecideFailureCode, string> = {
  not_found: "이미 처리된 건",
  not_pending: "이미 처리된 건",
  no_permission: "결재 권한 없음(대리 위임 시간 미경과 등)",
  self_request: "본인 신청은 결재 불가",
  already_approved: "이미 승인함",
  category_missing: "카테고리 없음",
  conflict: "다른 결재가 먼저 처리됨",
};

// POST /api/internal/approve-request — 챗 근태 결재(승인/반려).
// 결재자(권한)는 신원(x-acting-user-email→resolveHrIdentity)에서만. body로 위조 불가.
// target: 신청자 이름(영문) 또는 "전체". 웹 결재함 "결재 대기"와 같은 범위(대표는 전사 대기 건) 안에서만 처리.
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

  // 내 결재 대기 큐 — 웹 결재함·my-approvals와 같은 범위(lib/approval-inbox)
  const queue = await prisma.attendanceRequest.findMany({
    where: pendingAttendanceWhere({ approverId, role }),
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
    // 판정·저장·최종 확정·결과 알림은 웹 결재와 같은 lib/attendance-approval
    const res = await decideAttendanceApproval({
      requestId: r.id,
      approverId,
      role,
      action,
      rejectReason,
      source: "internal-approve",
    });
    const out = res.ok
      ? { ok: true, id: r.id, status: res.status, finalized: res.kind === "final" }
      : { ok: false, id: r.id, reason: CHAT_REASON[res.code] };
    results.push({ requester: r.employee?.name ?? null, category: r.category?.name ?? null, ...out });
  }

  const processed = results.filter((x) => x.ok === true).length;
  const skipped = results.filter((x) => x.ok === false).length;
  return NextResponse.json({ ok: true, action, processed, skipped, results }, { status: 200 });
}

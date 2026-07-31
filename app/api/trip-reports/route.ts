import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession, isAdminSession } from "@/lib/auth-helpers";

// 출장보고서 조회/저장. 참조는 tripParticipantId / attendanceRequestId 중 정확히 하나.
// external_source='trip'인 attendance_request는 그룹출장이 만든 자동 행이므로
// 보고서 대상이 될 수 없다 (그 출장은 participant 경로로 작성한다).

const MAX_EXPENSES = 20;

/** 참조 행을 찾아 소유자(employeeId)를 돌려준다. 존재하지 않으면 null. */
async function resolveRef(
  participantId: number | null,
  requestId: number | null
): Promise<{ ownerId: number; isAutoTripRequest: boolean } | null> {
  if (participantId != null) {
    const p = await prisma.tripParticipant.findUnique({
      where: { id: participantId },
      select: { employeeId: true },
    });
    return p ? { ownerId: p.employeeId, isAutoTripRequest: false } : null;
  }
  if (requestId != null) {
    const r = await prisma.attendanceRequest.findUnique({
      where: { id: requestId },
      select: { employeeId: true, externalSource: true },
    });
    return r
      ? { ownerId: r.employeeId, isAutoTripRequest: r.externalSource === "trip" }
      : null;
  }
  return null;
}

/** 쿼리/바디에서 참조 한 쌍을 읽고 "정확히 하나"인지 검증 */
function readRef(
  rawParticipant: unknown,
  rawRequest: unknown
): { participantId: number | null; requestId: number | null } | null {
  const p =
    rawParticipant == null || rawParticipant === "" ? null : Number(rawParticipant);
  const r = rawRequest == null || rawRequest === "" ? null : Number(rawRequest);
  if (p != null && !Number.isInteger(p)) return null;
  if (r != null && !Number.isInteger(r)) return null;
  if ((p == null) === (r == null)) return null; // 둘 다 있거나 둘 다 없음
  return { participantId: p, requestId: r };
}

// GET /api/trip-reports?participantId= | ?requestId=
export async function GET(request: NextRequest) {
  try {
    const sessionR = await requireSession();
    if (!sessionR.ok) return sessionR.response;
    const { session } = sessionR;

    const sp = new URL(request.url).searchParams;
    const ref = readRef(sp.get("participantId"), sp.get("requestId"));
    if (!ref) {
      return NextResponse.json(
        { error: "participantId 또는 requestId 중 하나만 지정해야 합니다." },
        { status: 400 }
      );
    }

    const target = await resolveRef(ref.participantId, ref.requestId);
    if (!target) {
      return NextResponse.json(
        { error: "대상 출장/신청을 찾을 수 없습니다." },
        { status: 404 }
      );
    }
    // 본인 또는 관리자만 열람
    if (
      target.ownerId !== session.user.employeeId &&
      !isAdminSession(session)
    ) {
      return NextResponse.json({ error: "조회 권한이 없습니다." }, { status: 403 });
    }

    const report = await prisma.tripReport.findFirst({
      where:
        ref.participantId != null
          ? { tripParticipantId: ref.participantId }
          : { attendanceRequestId: ref.requestId },
      include: { expenses: { orderBy: { seq: "asc" } } },
    });
    if (!report) return NextResponse.json({ report: null });

    return NextResponse.json({
      report: {
        id: report.id,
        workHours: report.workHours,
        region: report.region,
        destination: report.destination,
        detail: report.detail,
        followup: report.followup,
        status: report.status,
        submittedAt: report.submittedAt?.toISOString() ?? null,
        expenses: report.expenses.map((e) => ({
          method: e.method,
          item: e.item,
          amount: e.amount,
          projectName: e.projectName,
          note: e.note,
        })),
      },
    });
  } catch (error) {
    console.error("GET /api/trip-reports error:", error);
    return NextResponse.json({ error: "보고서 조회 실패" }, { status: 500 });
  }
}

interface ExpenseInput {
  method: string;
  item: string;
  amount: number;
  projectName: string | null;
  note: string | null;
}

/** 경비 행 검증 — 문제가 있으면 에러 메시지를 반환 */
function parseExpenses(
  raw: unknown
): { ok: true; rows: ExpenseInput[] } | { ok: false; error: string } {
  if (raw == null) return { ok: true, rows: [] };
  if (!Array.isArray(raw)) return { ok: false, error: "expenses 형식이 올바르지 않습니다." };
  if (raw.length > MAX_EXPENSES) {
    return { ok: false, error: `경비는 최대 ${MAX_EXPENSES}행까지 입력할 수 있습니다.` };
  }
  const rows: ExpenseInput[] = [];
  for (const [i, e] of raw.entries()) {
    const method = typeof e?.method === "string" ? e.method.trim() : "";
    const item = typeof e?.item === "string" ? e.item.trim() : "";
    const amount = Number(e?.amount);
    if (!method || !item) {
      return { ok: false, error: `경비 ${i + 1}행: 수단과 항목은 필수입니다.` };
    }
    if (!Number.isInteger(amount) || amount < 0) {
      return { ok: false, error: `경비 ${i + 1}행: 금액은 0 이상의 정수여야 합니다.` };
    }
    rows.push({
      method,
      item,
      amount,
      projectName:
        typeof e?.projectName === "string" && e.projectName.trim()
          ? e.projectName.trim()
          : null,
      note: typeof e?.note === "string" && e.note.trim() ? e.note.trim() : null,
    });
  }
  return { ok: true, rows };
}

const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v.trim() : null;

// PUT /api/trip-reports — 보고서 upsert (임시저장/제출/수정저장)
export async function PUT(request: NextRequest) {
  try {
    const sessionR = await requireSession();
    if (!sessionR.ok) return sessionR.response;
    const { session } = sessionR;
    const empId = session.user.employeeId;
    if (!Number.isInteger(empId)) {
      return NextResponse.json(
        { error: "본인 직원 정보가 매핑되어 있지 않습니다." },
        { status: 403 }
      );
    }

    const body = await request.json().catch(() => ({}));
    const ref = readRef(body?.tripParticipantId, body?.attendanceRequestId);
    if (!ref) {
      return NextResponse.json(
        { error: "tripParticipantId 또는 attendanceRequestId 중 하나만 지정해야 합니다." },
        { status: 400 }
      );
    }

    const target = await resolveRef(ref.participantId, ref.requestId);
    if (!target) {
      return NextResponse.json(
        { error: "대상 출장/신청을 찾을 수 없습니다." },
        { status: 404 }
      );
    }
    // 작성은 본인만 (관리자도 남의 보고서를 대신 쓰지 않는다)
    if (target.ownerId !== empId) {
      return NextResponse.json(
        { error: "본인 출장에만 보고서를 작성할 수 있습니다." },
        { status: 403 }
      );
    }
    // 그룹출장 자동 생성 신청은 participant 경로로만 작성한다
    if (target.isAutoTripRequest) {
      return NextResponse.json(
        { error: "그룹 출장은 출장 참가 항목에서 보고서를 작성해 주세요." },
        { status: 400 }
      );
    }

    const parsed = parseExpenses(body?.expenses);
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }

    const submit = body?.submit === true;
    const where =
      ref.participantId != null
        ? { tripParticipantId: ref.participantId }
        : { attendanceRequestId: ref.requestId };

    const existing = await prisma.tripReport.findFirst({
      where,
      select: { id: true, status: true, submittedAt: true },
    });

    // submit=false는 기존 제출 상태를 되돌리지 않는다 (제출 후 수정 저장)
    const nextStatus = submit
      ? "submitted"
      : existing?.status === "submitted"
      ? "submitted"
      : "draft";
    // submittedAt은 최초 제출 시에만 찍는다
    const submittedAt =
      nextStatus === "submitted" ? existing?.submittedAt ?? new Date() : null;

    const fields = {
      workHours: str(body?.workHours),
      region: str(body?.region),
      destination: str(body?.destination),
      detail: str(body?.detail),
      followup: str(body?.followup),
      status: nextStatus,
      submittedAt,
      updatedAt: new Date(),
    };

    const saved = await prisma.$transaction(async (tx) => {
      const report = existing
        ? await tx.tripReport.update({
            where: { id: existing.id },
            data: fields,
            select: { id: true, status: true, submittedAt: true },
          })
        : await tx.tripReport.create({
            data: {
              tripParticipantId: ref.participantId,
              attendanceRequestId: ref.requestId,
              employeeId: empId as number,
              ...fields,
            },
            select: { id: true, status: true, submittedAt: true },
          });

      // 경비는 전량 교체 (seq = 배열 순서)
      await tx.tripReportExpense.deleteMany({ where: { reportId: report.id } });
      if (parsed.rows.length > 0) {
        await tx.tripReportExpense.createMany({
          data: parsed.rows.map((e, i) => ({ reportId: report.id, seq: i, ...e })),
        });
      }
      return report;
    });

    return NextResponse.json({
      id: saved.id,
      status: saved.status,
      submittedAt: saved.submittedAt?.toISOString() ?? null,
    });
  } catch (error) {
    console.error("PUT /api/trip-reports error:", error);
    return NextResponse.json({ error: "보고서 저장 실패" }, { status: 500 });
  }
}

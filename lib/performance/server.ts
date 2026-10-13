// 분기 성과 API 공용 (서버 전용) — DB 행 ↔ 판정 규칙 연결.
import { NextResponse } from "next/server";
import type { Session } from "next-auth";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/app/generated/prisma/client";
import { kstTodayYmd } from "@/lib/kst-date";
import type { PerfInfo } from "@/lib/performance/form";
import {
  formatYmdDot,
  getCycleState,
  getDDay,
  parseYearQuarter,
  quarterEndYmd,
  quarterLabel,
  quarterStartYmd,
  type CycleDates,
  type CycleState,
  type YearQuarter,
} from "@/lib/performance/rules";

const DEFAULT_SUBMIT_DAYS = 7;

/** 오늘(KST 달력 날짜) — 분기·제출 기간 판정은 전부 이 값으로 */
export function perfTodayYmd(): string {
  return kstTodayYmd();
}

/** DATE 컬럼(UTC 자정) → "YYYY-MM-DD" */
export function dateToYmd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** "YYYY-MM-DD" → DATE 컬럼용 UTC 자정 */
export function ymdToDate(ymd: string): Date {
  return new Date(`${ymd}T00:00:00.000Z`);
}

export function cycleDates(c: { submitStart: Date; submitEnd: Date }): CycleDates {
  return { submitStart: dateToYmd(c.submitStart), submitEnd: dateToYmd(c.submitEnd) };
}

export function cycleView(
  c: { submitStart: Date; submitEnd: Date },
  todayYmd: string
): CycleDates & { state: CycleState; dDay: number } {
  const dates = cycleDates(c);
  return { ...dates, state: getCycleState(dates, todayYmd), dDay: getDDay(dates, todayYmd) };
}

/** policy_settings "perf_submit_default_days" (없거나 숫자가 아니면 7) */
export async function loadSubmitDefaultDays(): Promise<number> {
  const row = await prisma.policySetting.findUnique({
    where: { key: "perf_submit_default_days" },
    select: { value: true },
  });
  const n = row ? Number(row.value) : NaN;
  if (!Number.isInteger(n) || n < 1) {
    console.warn(
      `[performance] perf_submit_default_days 값이 없거나 숫자가 아닙니다(${row?.value ?? "없음"}) — ${DEFAULT_SUBMIT_DAYS}일 사용`
    );
    return DEFAULT_SUBMIT_DAYS;
  }
  return n;
}

/** 직원용 API — 세션에 연결된 직원 id. 없으면 403 응답 */
export function requireEmployeeId(
  session: Session
): { ok: true; employeeId: number } | { ok: false; response: NextResponse } {
  const id = session.user.employeeId;
  if (!Number.isInteger(id)) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "직원 정보가 연결되어 있지 않습니다." },
        { status: 403 }
      ),
    };
  }
  return { ok: true, employeeId: id as number };
}

/** 대상자 id 배열 검증 (정수·중복 제거). 형식이 틀리면 null */
export function parseEmployeeIds(raw: unknown): number[] | null {
  if (!Array.isArray(raw)) return null;
  const ids = raw.map(Number);
  if (ids.some((n) => !Number.isInteger(n) || n <= 0)) return null;
  return Array.from(new Set(ids));
}

/** 직원 정렬 — 직원 관리 화면과 같은 기준(사번 오름차순) */
export const EMPLOYEE_ORDER = [{ employeeNo: "asc" as const }];

// ── 기본 정보(info) ──

/** 성과표에 보여 줄 직원 프로필 — 제출 때 perf_sheets.profile_snapshot 에도 이 모양으로 저장 */
export interface PerfProfile {
  name: string;
  department: string;
  position: string;
}

/** 현재 직원 정보 (이름·부서명·직급명). 직원이 없으면 빈 값 */
export async function loadEmployeeProfile(employeeId: number): Promise<PerfProfile> {
  const e = await prisma.employee.findUnique({
    where: { id: employeeId },
    select: { name: true, department: { select: { name: true } }, position: { select: { name: true } } },
  });
  return {
    name: e?.name ?? "",
    department: e?.department?.name ?? "",
    position: e?.position?.name ?? "",
  };
}

/** profile_snapshot JSON → 프로필 (모양이 다르면 null) */
export function parseProfileSnapshot(raw: unknown): PerfProfile | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const s = (v: unknown) => (typeof v === "string" ? v : "");
  return { name: s(o.name), department: s(o.department), position: s(o.position) };
}

/** 보여 줄 프로필 — 제출 완료 상태이고 snapshot 이 있으면 snapshot, 아니면 현재 직원 정보 */
export function pickProfile(
  status: string | null | undefined,
  snapshot: unknown,
  current: PerfProfile
): PerfProfile {
  const snap = status === "submitted" ? parseProfileSnapshot(snapshot) : null;
  return snap ?? current;
}

/** 양식의 info 칸 값 — period "2026.10.01 ~ 2026.12.31", quarter "2026년 4분기" */
export function buildPerfInfo(profile: PerfProfile, yq: YearQuarter): PerfInfo {
  return {
    employeeName: profile.name,
    department: profile.department,
    position: profile.position,
    period: `${formatYmdDot(quarterStartYmd(yq))} ~ ${formatYmdDot(quarterEndYmd(yq))}`,
    quarter: quarterLabel(yq.year, yq.quarter),
  };
}

// ── 04 면담 및 평가 기록 (관리자 전용) ──

const REVIEW_FINALIZED = "평가가 확정된 기록입니다. 확정을 취소한 뒤 수정하세요.";
const REVIEW_CONFLICT = "다른 관리자가 먼저 저장했습니다. 다시 불러온 뒤 저장하세요.";

/** 관리자 세션의 직원 id (없으면 null) */
export function sessionEmployeeId(session: Session): number | null {
  const id = session.user.employeeId;
  return Number.isInteger(id) ? (id as number) : null;
}

/** 04 API 바디의 { employeeId, year, quarter } 검증 */
export function parseReviewTarget(body: unknown): { employeeId: number; yq: YearQuarter } | null {
  const b = (body ?? {}) as Record<string, unknown>;
  const employeeId = Number(b.employeeId);
  const yq = parseYearQuarter(b.year, b.quarter);
  if (!Number.isInteger(employeeId) || employeeId <= 0 || !yq) return null;
  return { employeeId, yq };
}

/** baseUpdatedAt — 처음 저장이면 null, 아니면 받은 시각. 형식이 틀리면 undefined */
export function parseBaseUpdatedAt(raw: unknown): Date | null | undefined {
  if (raw == null || raw === "") return null;
  if (typeof raw !== "string") return undefined;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export type ReviewWriteResult =
  | { ok: true; updatedAt: Date }
  | { ok: false; status: number; error: string; code?: "finalized" | "conflict" };

/**
 * 04 기록 저장 (finalize 면 확정까지 한 번에).
 * 제출 이력이 있고, 미확정이고, review_updated_at 이 baseUpdatedAt 과 같을 때만 쓰는 조건부 update —
 * 다른 관리자가 그 사이 저장했으면 덮어쓰지 않고 409.
 */
export async function writeReview(args: {
  employeeId: number;
  yq: YearQuarter;
  content: Prisma.InputJsonObject;
  baseUpdatedAt: Date | null;
  actorId: number | null;
  finalize: boolean;
}): Promise<ReviewWriteResult> {
  const { employeeId, yq, content, baseUpdatedAt, actorId, finalize } = args;
  return prisma.$transaction(async (tx) => {
    const sheet = await tx.perfSheet.findUnique({
      where: { employeeId_year_quarter: { employeeId, ...yq } },
      select: { id: true, submittedAt: true, reviewFinalizedAt: true },
    });
    if (!sheet || !sheet.submittedAt) {
      return { ok: false as const, status: 404, error: "아직 제출하지 않은 성과입니다." };
    }
    if (sheet.reviewFinalizedAt) {
      return { ok: false as const, status: 409, error: REVIEW_FINALIZED, code: "finalized" as const };
    }

    const now = new Date();
    const updated = await tx.perfSheet.updateMany({
      where: {
        id: sheet.id,
        submittedAt: { not: null },
        reviewFinalizedAt: null,
        reviewUpdatedAt: baseUpdatedAt,
      },
      data: {
        reviewContent: content,
        reviewUpdatedAt: now,
        reviewUpdatedById: actorId,
        ...(finalize ? { reviewFinalizedAt: now, reviewFinalizedById: actorId } : {}),
      },
    });
    if (updated.count === 0) {
      // 그 사이 확정됐는지, 다른 관리자가 저장했는지 구분해 알려 준다
      const cur = await tx.perfSheet.findUnique({
        where: { id: sheet.id },
        select: { reviewFinalizedAt: true },
      });
      return cur?.reviewFinalizedAt
        ? { ok: false as const, status: 409, error: REVIEW_FINALIZED, code: "finalized" as const }
        : { ok: false as const, status: 409, error: REVIEW_CONFLICT, code: "conflict" as const };
    }
    if (finalize) {
      await tx.perfSheetLog.create({
        data: { sheetId: sheet.id, action: "review_finalize", actorEmployeeId: actorId },
      });
    }
    return { ok: true as const, updatedAt: now };
  });
}

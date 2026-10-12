// 분기 실적 API 공용 (서버 전용) — DB 행 ↔ 판정 규칙 연결.
import { NextResponse } from "next/server";
import type { Session } from "next-auth";
import { prisma } from "@/lib/prisma";
import { kstTodayYmd } from "@/lib/kst-date";
import {
  getCycleState,
  getDDay,
  type CycleDates,
  type CycleState,
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

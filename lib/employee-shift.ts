// 직원·날짜 → 시프트 배정·포인트 조회 (서버 전용). 이 조회는 여기 한 곳에만 둔다.
// 쓰는 곳: lib/attendance-correction loadShiftTimes(정정·판정 시프트), lib/annual-leave loadWorkDayChecker(연차 근무일),
//          lib/half-day-info(반차 기본 시각).
// 배정 선택 규칙(aggregator get_employee_shift 와 같다): 그 날을 덮는 배정(start_date ≤ 날짜 ≤ end_date 또는 end_date 없음)
// 중 패턴이 활성인 것, start_date 가 가장 늦은 것. 포인트 계산은 lib/shift-schedule resolveShiftPoint.
import type { Prisma } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { resolveShiftPoint, type ShiftPoint } from "@/lib/shift-schedule";

type Db = Prisma.TransactionClient | typeof prisma;

export type ShiftAssignmentRow = {
  employee_id: number;
  start_date: Date;
  end_date: Date | null;
  cycle_days: number;
  schedule: unknown;
  /** 패턴별 반차 경계(시작 후 분). null 이면 정책 기본값 */
  half_day_split_minutes: number | null;
};

/** 직원별 배정 목록 (기간과 겹치는 것, start_date 늦은 순) */
export async function loadShiftAssignments(
  db: Db,
  employeeIds: number[],
  fromYmd: string,
  toYmd: string
): Promise<Map<number, ShiftAssignmentRow[]>> {
  const byEmployee = new Map<number, ShiftAssignmentRow[]>();
  if (employeeIds.length === 0) return byEmployee;
  const rows = await db.$queryRaw<ShiftAssignmentRow[]>`
    SELECT es.employee_id, es.start_date, es.end_date, sp.cycle_days, sp.schedule, sp.half_day_split_minutes
    FROM hr.employee_shifts es
    JOIN hr.shift_patterns sp ON sp.id = es.pattern_id
    WHERE es.employee_id = ANY(${employeeIds}::int[])
      AND es.start_date <= ${toYmd}::date
      AND (es.end_date IS NULL OR es.end_date >= ${fromYmd}::date)
      AND sp.is_active = true
    ORDER BY es.start_date DESC
  `;
  for (const r of rows) {
    const list = byEmployee.get(r.employee_id);
    if (list) list.push(r);
    else byEmployee.set(r.employee_id, [r]);
  }
  return byEmployee;
}

/** 그 날을 덮는 배정 (목록이 start_date DESC 라 첫 매칭 = start_date 가장 늦은 것) */
export function assignmentOn(rows: ShiftAssignmentRow[] | undefined, day: Date): ShiftAssignmentRow | null {
  return rows?.find((r) => r.start_date <= day && (r.end_date == null || r.end_date >= day)) ?? null;
}

/** 직원 한 명·하루의 배정과 시프트 포인트. 배정이 없으면 null */
export async function loadShiftPointOn(
  db: Db,
  employeeId: number,
  workDate: Date
): Promise<{ assignment: ShiftAssignmentRow; point: ShiftPoint | null } | null> {
  const ymd = workDate.toISOString().split("T")[0];
  const rows = await loadShiftAssignments(db, [employeeId], ymd, ymd);
  // SQL 이 날짜로 비교하던 것과 같게 — 시각이 붙은 Date 여도 그 날 UTC 자정으로 비교
  const assignment = assignmentOn(rows.get(employeeId), new Date(`${ymd}T00:00:00.000Z`));
  if (!assignment) return null;
  return {
    assignment,
    point: resolveShiftPoint(assignment.start_date, assignment.cycle_days, assignment.schedule, workDate),
  };
}

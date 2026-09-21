// 시프트 스케줄에서 특정 날짜의 포인트를 찾는다.
// aggregator(Python) get_employee_shift 와 동일 규칙: 배정 시작일이 속한 주의 월요일을 기준점으로
// (경과일 % cycle_days) 번째 dayIndex 를 찾는다. 이 규칙은 여기 한 곳에만 둔다.
export type ShiftPoint = {
  dayIndex?: number;
  type?: string;
  start?: string | null;
  end?: string | null;
};

export function resolveShiftPoint(
  startDate: Date,
  cycleDays: number,
  schedule: unknown,
  workDate: Date
): ShiftPoint | null {
  if (!Array.isArray(schedule) || cycleDays < 1) return null;
  // Python weekday(): 월=0..일=6. JS getUTCDay(): 일=0..토=6 → (d+6)%7 로 월=0 맞춤.
  const startWeekday = (startDate.getUTCDay() + 6) % 7;
  const anchor = new Date(startDate);
  anchor.setUTCDate(anchor.getUTCDate() - startWeekday);
  const dayOffset =
    Math.floor((workDate.getTime() - anchor.getTime()) / 86400000) % cycleDays;

  const point = (schedule as ShiftPoint[]).find((p) => p && p.dayIndex === dayOffset);
  return point ?? null;
}

// 근무일 여부 — aggregator is_work_shift 와 동일: type != off 이고 start·end 가 모두 있음.
export function isWorkPoint(p: ShiftPoint | null): boolean {
  return !!(p && p.type !== "off" && p.start && p.end);
}

// 직원·날짜의 반차 기본 시각 조회 (서버 전용) — GET /api/my-shift/half-day 와 관리자 반차 시각 수정 안내가 쓴다.
// 시프트 시각은 정정·판정과 같은 lib/attendance-correction loadShiftTimes(연구미팅 대체 포함),
// 근무일은 연차 근무일과 같은 규칙(배정 있으면 근무 포인트, 미배정이면 월~금, 공휴일 제외).
// 시각 계산은 lib/half-day halfDayDefaultsFor.
import type { Prisma } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { loadShiftTimes } from "@/lib/attendance-correction";
import { getHolidaySet } from "@/lib/annual-leave";
import {
  DEFAULT_HALF_DAY_SPLIT_MINUTES,
  HALF_DAY_SPLIT_POLICY_KEY,
  halfDayDefaultsFor,
  parseSplitMinutes,
  type HalfDayInfo,
} from "@/lib/half-day";

type Db = Prisma.TransactionClient | typeof prisma;

/** 정책 half_day_split_minutes — 행이 없거나 값이 틀리면 null(코드 기본 240) */
export async function loadHalfDaySplitPolicy(db: Db): Promise<number | null> {
  const row = await db.policySetting.findUnique({
    where: { key: HALF_DAY_SPLIT_POLICY_KEY },
    select: { value: true },
  });
  return parseSplitMinutes(row?.value);
}

export async function loadHalfDayInfo(db: Db, employeeId: number, ymd: string): Promise<HalfDayInfo> {
  const day = new Date(`${ymd}T00:00:00.000Z`);
  const [shift, policySplit, holidays] = await Promise.all([
    loadShiftTimes(db, employeeId, day),
    loadHalfDaySplitPolicy(db),
    getHolidaySet(ymd, ymd),
  ]);
  const isHoliday = holidays.has(ymd);
  const dow = day.getUTCDay();
  const isWorkDay = !isHoliday && (shift.assigned ? shift.isWorkPoint : dow !== 0 && dow !== 6);
  const patternSplit = parseSplitMinutes(shift.patternHalfDaySplitMinutes);
  const splitMinutes = patternSplit ?? policySplit ?? DEFAULT_HALF_DAY_SPLIT_MINUTES;
  return {
    date: ymd,
    employeeId,
    assigned: shift.assigned,
    isWorkDay,
    isHoliday,
    shiftStart: shift.shiftStartHHMM,
    shiftEnd: shift.shiftEndHHMM,
    splitMinutes,
    splitSource: patternSplit !== null ? "pattern" : policySplit !== null ? "policy" : "default",
    defaults: halfDayDefaultsFor(
      { assigned: shift.assigned, isWorkDay, start: shift.shiftStartHHMM, end: shift.shiftEndHHMM },
      splitMinutes
    ),
  };
}

// 근태 정정 반영·정정 계산. 판정은 lib/attendance-judge(aggregator/day_rules.py 와 같은 규칙) — 규칙을 바꾸면 npm run parity.
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/app/generated/prisma/client";
import { resolveShiftPoint, isWorkPoint } from "@/lib/shift-schedule";
import {
  isResearchMeetingDay,
  loadResearchMeetingPolicy,
} from "@/lib/researchMeeting";
import { findLiveLeaveWorkRequests } from "@/lib/attendance-live-requests";
import { loadAttendancePolicy } from "@/lib/attendance-policy";
import {
  buildJudgeCtx,
  judgeDay,
  judgeShift,
  type EffectiveWorkWindow,
} from "@/lib/attendance-judge";

// 정정 계산 — 판정은 lib/attendance-judge(aggregator/day_rules.py 와 같은 규칙)로 한다.
// 규칙을 바꾸면 npm run parity.
export { effectiveWorkWindow, shiftBoundsKst, type EffectiveWorkWindow } from "@/lib/attendance-judge";

// 분 단위 절삭 — 화면 표시(HH:MM)와 동일 기준으로 판정/계산
// (aggregator의 _floor_minute와 동일 정책. setSeconds는 초/밀리초만 조작하므로 TZ 무관)
function floorMinute(d: Date | null): Date | null {
  if (!d) return null;
  const c = new Date(d);
  c.setSeconds(0, 0);
  return c;
}

// 시프트·반차 구간 판정 (lib/attendance-judge judgeShift 래퍼 — 호환용).
// 판정 규칙은 aggregator(day_rules.judge_shift)와 웹이 같아야 한다 — 한쪽을 바꾸면 다른 쪽도.
// 조퇴 = (근무시간 < 필요시간) AND (퇴근 < 시프트 종료 − grace_out).
// 퇴근 전이면 지각이면 late, 아니면 working (aggregator 와 같게).
export function determineAutoStatus(
  checkIn: Date | null,
  checkOut: Date | null,
  startHHMM: string | null,
  endHHMM: string | null,
  graceIn: number,
  graceOut: number,
  isHoliday: boolean = false,
  window: EffectiveWorkWindow | null = null
): string | null {
  return judgeShift(checkIn, checkOut, { start: startHHMM, end: endHHMM }, graceIn, graceOut, {
    isHoliday,
    refWindow: window,
  })[0];
}

// 지각·조퇴 플래그 (judgeShift 래퍼). null 은 "판정 불가/모름", false 는 "판정했고 해당 없음".
export function determineAttendanceFlags(
  checkIn: Date | null,
  checkOut: Date | null,
  startHHMM: string | null,
  endHHMM: string | null,
  graceIn: number,
  graceOut: number,
  isHoliday: boolean = false,
  window: EffectiveWorkWindow | null = null
): { isLate: boolean | null; isEarlyLeave: boolean | null } {
  const [, isLate, isEarlyLeave] = judgeShift(
    checkIn, checkOut, { start: startHHMM, end: endHHMM }, graceIn, graceOut,
    { isHoliday, refWindow: window }
  );
  return { isLate, isEarlyLeave };
}

// 그 날 시프트 종료 시각의 Date. 자정을 넘는 시프트(end <= start)는 다음날로 계산한다.
// 근태정정 "출근 시각이 근무 종료 이후" 가드에 쓴다 (determineAutoStatus 와 같은 기준).
export function shiftEndBoundary(
  day: Date,
  startHHMM: string | null,
  endHHMM: string | null
): Date | null {
  if (!startHHMM || !endHHMM) return null;
  const [shH, shM] = startHHMM.split(":").map(Number);
  const [ehH, ehM] = endHHMM.split(":").map(Number);
  if ([shH, shM, ehH, ehM].some(isNaN)) return null;
  const end = new Date(day);
  end.setHours(ehH, ehM, 0, 0);
  if (ehH * 60 + ehM <= shH * 60 + shM) {
    end.setDate(end.getDate() + 1); // 자정 넘는 시프트
  }
  return end;
}

// 정정 날짜 기준 시프트(HH:MM) + grace 정책 로드.
// tx 안/밖 어디서든 호출 가능하도록 prisma(또는 tx)를 인자로 받는다.
// 연구미팅 대체는 aggregator get_employee_shift 와 같다: 참여 직원 + 미팅일 + 근무일 point 일 때만
// 시작·종료를 정책 시간으로 바꾼다(휴무·미배정은 그대로).
export async function loadShiftAndGrace(
  db: Prisma.TransactionClient | typeof prisma,
  employeeId: number,
  workDate: Date
): Promise<{
  shiftStartHHMM: string | null;
  shiftEndHHMM: string | null;
  graceInMinutes: number;
  graceOutMinutes: number;
}> {
  const workDateStr = workDate.toISOString().split("T")[0];

  // shift_patterns는 (cycle_days, schedule Json) 구조.
  // schedule = [{ dayIndex, type, start:"HH:MM"|null, end:"HH:MM"|null }, ...] (cycle_days개)
  // aggregator get_employee_shift와 동일 로직으로 해당 날짜의 point를 찾는다.
  const shiftRows = await db.$queryRaw<
    Array<{ start_date: Date; cycle_days: number; schedule: unknown }>
  >`
    SELECT es.start_date, sp.cycle_days, sp.schedule
    FROM hr.employee_shifts es
    JOIN hr.shift_patterns sp ON sp.id = es.pattern_id
    WHERE es.employee_id = ${employeeId}
      AND es.start_date <= ${workDateStr}::date
      AND (es.end_date IS NULL OR es.end_date >= ${workDateStr}::date)
      AND sp.is_active = true
    ORDER BY es.start_date DESC
    LIMIT 1
  `;

  let shiftStartHHMM: string | null = null;
  let shiftEndHHMM: string | null = null;

  if (shiftRows.length > 0) {
    const { start_date, cycle_days, schedule } = shiftRows[0];
    const point = resolveShiftPoint(start_date, cycle_days, schedule, workDate);

    if (point && point.type !== "off") {
      shiftStartHHMM = point.start ?? null;
      shiftEndHHMM = point.end ?? null;
    }

    if (isWorkPoint(point)) {
      const emp = await db.employee.findUnique({
        where: { id: employeeId },
        select: { attendsResearchMeeting: true },
      });
      if (emp?.attendsResearchMeeting) {
        const rm = await loadResearchMeetingPolicy(db);
        if (rm && isResearchMeetingDay(workDateStr, rm)) {
          shiftStartHHMM = rm.start;
          shiftEndHHMM = rm.end;
        }
      }
    }
  }
  // grace 정책 — lib/attendance-policy (aggregator 와 같은 키·기본값)
  const { graceInMinutes, graceOutMinutes } = await loadAttendancePolicy(db);
  return { shiftStartHHMM, shiftEndHHMM, graceInMinutes, graceOutMinutes };
}

// 정정된 시각으로 근무시간·상태·지각/조퇴 플래그를 계산한다 (정정 반영·정정 취소 공용).
// 판정은 lib/attendance-judge judgeDay — aggregator 의 judge_day 와 같은 결과.
export async function computeCorrectedDaily(
  tx: Prisma.TransactionClient,
  employeeId: number,
  workDate: Date,
  checkIn: Date | null,
  checkOut: Date | null,
  logRef: string = ""
): Promise<{
  workMinutes: number | null;
  autoStatus: string | null;
  isLate: boolean | null;
  isEarlyLeave: boolean | null;
}> {
  checkIn = floorMinute(checkIn);
  checkOut = floorMinute(checkOut);

  let workMinutes: number | null = null;
  if (checkIn && checkOut) {
    const diffMinutes = Math.floor(
      (checkOut.getTime() - checkIn.getTime()) / (60 * 1000)
    );
    if (diffMinutes < 0) {
      // 출근 > 퇴근인 정정 (2026-07-24 사례). 음수를 저장하면 화면·월간합계가
      // 오염되므로 null로 두고 로그만 남긴다. 시각 자체는 요청대로 저장한다.
      console.error(
        `[applyCorrectionToDaily] 음수 근무시간 차단 — ` +
          `employeeId=${employeeId}, workDate=${workDate.toISOString()}, ` +
          `checkIn=${checkIn.toISOString()}, checkOut=${checkOut.toISOString()}, ` +
          `diff=${diffMinutes}분, ${logRef}`
      );
    } else {
      workMinutes = diffMinutes;
    }
  }

  // 판정 — aggregator 와 같은 judgeDay (종일·반차 구간·시간형 근무 exempt/여유시간/진행 중 보류·
  // 공휴일·점심 공제). 정정한 시각은 사람이 넣은 값이므로 외근 시각과 합치지 않는다.
  const policy = await loadAttendancePolicy(tx);
  const { shiftStartHHMM, shiftEndHHMM } = await loadShiftAndGrace(tx, employeeId, workDate);
  const holidayRow = await tx.holiday.findUnique({
    where: { holidayDate: workDate },
  });
  const requests = await findLiveLeaveWorkRequests(tx, employeeId, workDate);
  const ctx = buildJudgeCtx(
    requests,
    shiftStartHHMM && shiftEndHHMM ? { start: shiftStartHHMM, end: shiftEndHHMM } : null,
    workDate,
    policy.cutoffHour,
    !!holidayRow,
    new Date(),
    policy
  );
  const j = judgeDay(checkIn, checkOut, ctx);
  return { workMinutes, autoStatus: j.status, isLate: j.isLate, isEarlyLeave: j.isEarlyLeave };
}

// 정정(correction)을 attendance_daily에 반영하는 공통 함수.
// - 트랜잭션 클라이언트(tx)를 받아 그 트랜잭션 안에서 upsert.
// - correctedCheckIn/Out 중 있는 쪽만 덮어쓰고, 없는 쪽은 기존값 유지.
// - is_overridden=true, override_source='manual'(보호), note, 첫 정정 시 원본 백업.
// approvals(일반 승인)와 attendance-requests(자동승인) 양쪽에서 호출.
export async function applyCorrectionToDaily(
  tx: Prisma.TransactionClient,
  params: {
    employeeId: number;
    workDate: Date; // 단일 날짜 (request.startDate)
    correctedCheckIn: Date | null;
    correctedCheckOut: Date | null;
    requestId: number | bigint; // note에 "#N" 표기용
  }
): Promise<void> {
  const { employeeId, workDate, correctedCheckIn, correctedCheckOut, requestId } =
    params;

  const existing = await tx.attendanceDaily.findUnique({
    where: { employeeId_workDate: { employeeId, workDate } },
  });

  const newCheckIn = floorMinute(correctedCheckIn ?? existing?.checkIn ?? null);
  const newCheckOut = floorMinute(correctedCheckOut ?? existing?.checkOut ?? null);

  const derived = await computeCorrectedDaily(
    tx,
    employeeId,
    workDate,
    newCheckIn,
    newCheckOut,
    `requestId=${requestId}`
  );
  const newWorkMinutes = derived.workMinutes;
  const newAutoStatus = derived.autoStatus;
  const newFlags = { isLate: derived.isLate, isEarlyLeave: derived.isEarlyLeave };

  // 실제로 정정한 항목만 original에 백업한다.
  // - 출근 정정(correctedCheckIn 있음) + 아직 originalCheckIn 백업 전 → 출근 원본 백업
  // - 퇴근 정정(correctedCheckOut 있음) + 아직 originalCheckOut 백업 전 → 퇴근 원본 백업
  // 정정하지 않은 항목은 백업하지 않아, 화면에 "변경됨(취소선)"으로 보이지 않게 한다.
  const backupFields: {
    originalCheckIn?: Date | null;
    originalCheckOut?: Date | null;
  } = {};
  if (correctedCheckIn && existing && existing.originalCheckIn === null) {
    backupFields.originalCheckIn = existing.checkIn;
  }
  if (correctedCheckOut && existing && existing.originalCheckOut === null) {
    backupFields.originalCheckOut = existing.checkOut;
  }

  await tx.attendanceDaily.upsert({
    where: { employeeId_workDate: { employeeId, workDate } },
    create: {
      employeeId,
      workDate,
      checkIn: newCheckIn,
      checkOut: newCheckOut,
      workMinutes: newWorkMinutes,
      autoStatus: newAutoStatus,
      // auto_status 와 같은 기준으로 판정해 함께 저장 (null = 판정 불가)
      isLate: newFlags.isLate,
      isEarlyLeave: newFlags.isEarlyLeave,
      isOverridden: true,
      overrideSource: "manual",
      note: `결재정정 #${requestId}`,
    },
    update: {
      checkIn: newCheckIn,
      checkOut: newCheckOut,
      workMinutes: newWorkMinutes,
      autoStatus: newAutoStatus,
      // auto_status 와 같은 기준으로 판정해 함께 저장 (null = 판정 불가)
      isLate: newFlags.isLate,
      isEarlyLeave: newFlags.isEarlyLeave,
      isOverridden: true,
      overrideSource: "manual",
      note: existing?.note ?? `결재정정 #${requestId}`,
      ...backupFields,
    },
  });
}

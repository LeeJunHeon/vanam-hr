import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/app/generated/prisma/client";

// 분 단위 절삭 — 화면 표시(HH:MM)와 동일 기준으로 판정/계산
// (aggregator의 _floor_minute와 동일 정책. setSeconds는 초/밀리초만 조작하므로 TZ 무관)
function floorMinute(d: Date | null): Date | null {
  if (!d) return null;
  const c = new Date(d);
  c.setSeconds(0, 0);
  return c;
}

// 정정/결재용 auto_status 재계산 (approvals/route.ts의 동일 로직을 이동).
// 시프트 시각(HH:MM)과 grace로 normal/late/early_leave/absent/null 판정.
// 공휴일은 지각/조퇴 판정 없음(aggregator와 동일 정책).
export function determineAutoStatus(
  checkIn: Date | null,
  checkOut: Date | null,
  startHHMM: string | null,
  endHHMM: string | null,
  graceIn: number,
  graceOut: number,
  isHoliday: boolean = false
): string | null {
  checkIn = floorMinute(checkIn);
  checkOut = floorMinute(checkOut);
  // 공휴일 → 시프트가 있어도 단순 판정 (지각/조퇴 판정 없음)
  // Python _determine_auto_status의 is_holiday 규칙 1과 동일
  if (isHoliday) {
    if (checkIn && checkOut) return "normal";
    if (checkIn && !checkOut) return "working";
    if (!checkIn && !checkOut) return "absent";
    return null;
  }
  // 시프트 없음 → 단순 판정
  if (!startHHMM || !endHHMM) {
    if (checkIn && checkOut) return "normal";
    if (!checkIn && !checkOut) return "absent";
    return null;
  }
  if (!checkIn && !checkOut) return "absent";
  if (!checkIn || !checkOut) return null;
  const [shH, shM] = startHHMM.split(":").map(Number);
  const [ehH, ehM] = endHHMM.split(":").map(Number);
  if ([shH, shM, ehH, ehM].some(isNaN)) return "normal";
  let shiftMinutes = ehH * 60 + ehM - (shH * 60 + shM);
  if (shiftMinutes <= 0) shiftMinutes += 24 * 60;
  const shiftStart = new Date(checkIn);
  shiftStart.setHours(shH, shM, 0, 0);
  const lateThreshold = new Date(shiftStart.getTime() + graceIn * 60 * 1000);
  if (checkIn > lateThreshold) return "late";
  const actualMinutes = Math.floor(
    (checkOut.getTime() - checkIn.getTime()) / (60 * 1000)
  );
  const requiredMinutes = shiftMinutes - graceOut;
  if (actualMinutes < requiredMinutes) return "early_leave";
  return "normal";
}

// 정정 날짜 기준 시프트(HH:MM) + grace 정책 로드.
// tx 안/밖 어디서든 호출 가능하도록 prisma(또는 tx)를 인자로 받는다.
async function loadShiftAndGrace(
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
    if (Array.isArray(schedule) && cycle_days >= 1) {
      // Python weekday(): 월=0..일=6. JS getUTCDay(): 일=0..토=6 → (d+6)%7 로 월=0 맞춤.
      const startWeekday = (start_date.getUTCDay() + 6) % 7;
      const anchor = new Date(start_date);
      anchor.setUTCDate(anchor.getUTCDate() - startWeekday);
      const dayOffset =
        Math.floor((workDate.getTime() - anchor.getTime()) / 86400000) % cycle_days;

      const point = (schedule as Array<{
        dayIndex?: number;
        type?: string;
        start?: string | null;
        end?: string | null;
      }>).find((p) => p && p.dayIndex === dayOffset);

      if (point && point.type !== "off") {
        shiftStartHHMM = point.start ?? null;
        shiftEndHHMM = point.end ?? null;
      }
    }
  }
  let graceInMinutes = 10;
  let graceOutMinutes = 0;
  const policies = await db.policySetting.findMany({
    where: { key: { in: ["grace_in_minutes", "grace_out_minutes"] } },
  });
  for (const p of policies) {
    const v = parseInt(p.value, 10);
    if (!isNaN(v)) {
      if (p.key === "grace_in_minutes") graceInMinutes = v;
      if (p.key === "grace_out_minutes") graceOutMinutes = v;
    }
  }
  return { shiftStartHHMM, shiftEndHHMM, graceInMinutes, graceOutMinutes };
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

  // 시프트/정책은 tx로 로드 (같은 트랜잭션 일관성)
  const { shiftStartHHMM, shiftEndHHMM, graceInMinutes, graceOutMinutes } =
    await loadShiftAndGrace(tx, employeeId, workDate);

  const existing = await tx.attendanceDaily.findUnique({
    where: { employeeId_workDate: { employeeId, workDate } },
  });

  const newCheckIn = floorMinute(correctedCheckIn ?? existing?.checkIn ?? null);
  const newCheckOut = floorMinute(correctedCheckOut ?? existing?.checkOut ?? null);

  let newWorkMinutes: number | null = null;
  if (newCheckIn && newCheckOut) {
    newWorkMinutes = Math.floor(
      (newCheckOut.getTime() - newCheckIn.getTime()) / (60 * 1000)
    );
  }

  // 공휴일이면 지각/조퇴 판정 없이 단순 판정 (aggregator와 동일 정책)
  const holidayRow = await tx.holiday.findUnique({
    where: { holidayDate: workDate },
  });

  const newAutoStatus = determineAutoStatus(
    newCheckIn,
    newCheckOut,
    shiftStartHHMM,
    shiftEndHHMM,
    graceInMinutes,
    graceOutMinutes,
    !!holidayRow
  );

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
      isOverridden: true,
      overrideSource: "manual",
      note: `결재정정 #${requestId}`,
    },
    update: {
      checkIn: newCheckIn,
      checkOut: newCheckOut,
      workMinutes: newWorkMinutes,
      autoStatus: newAutoStatus,
      isOverridden: true,
      overrideSource: "manual",
      note: existing?.note ?? `결재정정 #${requestId}`,
      ...backupFields,
    },
  });
}

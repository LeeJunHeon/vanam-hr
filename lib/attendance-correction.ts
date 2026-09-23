import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/app/generated/prisma/client";
import { resolveShiftPoint } from "@/lib/shift-schedule";

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
// 정정 승인 시 is_late / is_early_leave 플래그 판정.
// aggregator/aggregator.py _determine_auto_status 와 같은 임계값 식을 쓴다
// (floorMinute, shiftMinutes<=0 이면 +24h, lateThreshold, requiredMinutes) —
// 같은 입력에서 determineAutoStatus 의 결과와 모순되지 않아야 하기 때문이다.
// null 은 "판정 불가/모름", false 는 "판정했고 해당 없음"을 뜻한다.
// 주의: 점심 공제(lunch_deduct_enabled)는 aggregator 에만 있음
//       — 정책 활성화 시 양쪽 동기화 필요.
export function determineAttendanceFlags(
  checkIn: Date | null,
  checkOut: Date | null,
  startHHMM: string | null,
  endHHMM: string | null,
  graceIn: number,
  graceOut: number,
  isHoliday: boolean = false
): { isLate: boolean | null; isEarlyLeave: boolean | null } {
  checkIn = floorMinute(checkIn);
  checkOut = floorMinute(checkOut);
  // 공휴일·시프트 없음 → 지각/조퇴 판정 면제가 확정된 상태
  if (isHoliday || !startHHMM || !endHHMM) {
    return { isLate: false, isEarlyLeave: false };
  }
  // 출근이 없으면(결근·퇴근만 있는 이상 상태) 판정 불가
  if (!checkIn) return { isLate: null, isEarlyLeave: null };
  const [shH, shM] = startHHMM.split(":").map(Number);
  const [ehH, ehM] = endHHMM.split(":").map(Number);
  if ([shH, shM, ehH, ehM].some(isNaN)) return { isLate: null, isEarlyLeave: null };
  let shiftMinutes = ehH * 60 + ehM - (shH * 60 + shM);
  if (shiftMinutes <= 0) shiftMinutes += 24 * 60;
  const shiftStart = new Date(checkIn);
  shiftStart.setHours(shH, shM, 0, 0);
  const lateThreshold = new Date(shiftStart.getTime() + graceIn * 60 * 1000);
  const isLate = checkIn > lateThreshold;
  // 퇴근 전에는 조퇴를 판정할 수 없다
  if (!checkOut) return { isLate, isEarlyLeave: null };
  const actualMinutes = Math.floor(
    (checkOut.getTime() - checkIn.getTime()) / (60 * 1000)
  );
  const requiredMinutes = shiftMinutes - graceOut;
  return { isLate, isEarlyLeave: actualMinutes < requiredMinutes };
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
    const diffMinutes = Math.floor(
      (newCheckOut.getTime() - newCheckIn.getTime()) / (60 * 1000)
    );
    if (diffMinutes < 0) {
      // 출근 > 퇴근인 정정 (2026-07-24 사례). 음수를 저장하면 화면·월간합계가
      // 오염되므로 null로 두고 로그만 남긴다. 시각 자체는 요청대로 저장한다.
      console.error(
        `[applyCorrectionToDaily] 음수 근무시간 차단 — ` +
          `employeeId=${employeeId}, workDate=${workDate.toISOString()}, ` +
          `checkIn=${newCheckIn.toISOString()}, checkOut=${newCheckOut.toISOString()}, ` +
          `diff=${diffMinutes}분, requestId=${requestId}`
      );
      newWorkMinutes = null;
    } else {
      newWorkMinutes = diffMinutes;
    }
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

  // aggregator 의 백필은 "반대쪽 시각이 비어 있다가 채워질 때"만 돌아서, 퇴근이 찍힌 뒤
  // 정정하면 플래그가 NULL 로 남았다. 여기서 auto_status 와 같은 기준으로 함께 채운다.
  const newFlags = determineAttendanceFlags(
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

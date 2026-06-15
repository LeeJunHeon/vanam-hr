import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/app/generated/prisma/client";

// 정정/결재용 auto_status 재계산 (approvals/route.ts의 동일 로직을 이동).
// 시프트 시각(HH:MM)과 grace로 normal/late/early_leave/absent/null 판정.
export function determineAutoStatus(
  checkIn: Date | null,
  checkOut: Date | null,
  startHHMM: string | null,
  endHHMM: string | null,
  graceIn: number,
  graceOut: number
): string | null {
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
  const shiftRows = await db.$queryRaw<
    Array<{ start_time: string | null; end_time: string | null; type: string }>
  >`
    SELECT sp.start_time::text AS start_time, sp.end_time::text AS end_time, sp.type
    FROM hr.employee_shifts es
    JOIN hr.shift_patterns sp ON sp.id = es.pattern_id
    WHERE es.employee_id = ${employeeId}
      AND es.start_date <= ${workDateStr}::date
      AND (es.end_date IS NULL OR es.end_date >= ${workDateStr}::date)
      AND sp.is_active = true
    LIMIT 1
  `;
  let shiftStartHHMM: string | null = null;
  let shiftEndHHMM: string | null = null;
  if (shiftRows.length > 0 && shiftRows[0].type !== "off") {
    shiftStartHHMM = shiftRows[0].start_time;
    shiftEndHHMM = shiftRows[0].end_time;
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

  const newCheckIn = correctedCheckIn ?? existing?.checkIn ?? null;
  const newCheckOut = correctedCheckOut ?? existing?.checkOut ?? null;

  let newWorkMinutes: number | null = null;
  if (newCheckIn && newCheckOut) {
    newWorkMinutes = Math.floor(
      (newCheckOut.getTime() - newCheckIn.getTime()) / (60 * 1000)
    );
  }

  const newAutoStatus = determineAutoStatus(
    newCheckIn,
    newCheckOut,
    shiftStartHHMM,
    shiftEndHHMM,
    graceInMinutes,
    graceOutMinutes
  );

  const shouldBackupOriginal =
    existing &&
    existing.originalCheckIn === null &&
    existing.originalCheckOut === null;

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
      ...(shouldBackupOriginal && {
        originalCheckIn: existing.checkIn,
        originalCheckOut: existing.checkOut,
      }),
    },
  });
}

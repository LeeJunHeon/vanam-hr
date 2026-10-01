import type { Prisma } from "@/app/generated/prisma/client";
import type { prisma } from "@/lib/prisma";
import { parseCutoffHour } from "@/lib/kst-date";

// 근태 정책 값 읽기 — 키·기본값을 여기 한 곳에서 정한다(aggregator aggregate_today 와 같은 키·같은 기본값).
//   debounce_minutes(60), work_date_cutoff_hour(4), grace_in_minutes(10), grace_out_minutes(0),
//   lunch_deduct_enabled(false), lunch_start("12:00"), lunch_end("13:00"),
//   timed_trip_exempt(false), timed_event_margin_hours(0)

type Db = Prisma.TransactionClient | typeof prisma;

export const ATTENDANCE_POLICY_KEYS = [
  "debounce_minutes",
  "work_date_cutoff_hour",
  "grace_in_minutes",
  "grace_out_minutes",
  "lunch_deduct_enabled",
  "lunch_start",
  "lunch_end",
  "timed_trip_exempt",
  "timed_event_margin_hours",
] as const;

export interface AttendancePolicy {
  debounceMinutes: number;
  cutoffHour: number;
  graceInMinutes: number;
  graceOutMinutes: number;
  lunchDeductEnabled: boolean;
  lunchStart: string;
  lunchEnd: string;
  timedTripExempt: boolean;
  timedEventMarginHours: number;
}

// 숫자만(/^\d+$/) — realtime·attendance-rows 가 쓰던 debounce_minutes 해석과 같다
function strictInt(raw: string | undefined, def: number): number {
  return raw && /^\d+$/.test(raw) ? parseInt(raw, 10) : def;
}
// parseInt — 정정 계산(loadShiftAndGrace)이 쓰던 grace 해석과 같다
function looseInt(raw: string | undefined, def: number): number {
  if (raw === undefined) return def;
  const v = parseInt(raw, 10);
  return isNaN(v) ? def : v;
}
function bool(raw: string | undefined): boolean {
  return String(raw ?? "").trim().toLowerCase() === "true";
}
function float(raw: string | undefined, def: number): number {
  if (!raw) return def;
  const v = Number(raw);
  return Number.isFinite(v) ? v : def;
}

export function parseAttendancePolicy(values: Map<string, string>): AttendancePolicy {
  return {
    debounceMinutes: strictInt(values.get("debounce_minutes"), 60),
    cutoffHour: parseCutoffHour(values.get("work_date_cutoff_hour")),
    graceInMinutes: looseInt(values.get("grace_in_minutes"), 10),
    graceOutMinutes: looseInt(values.get("grace_out_minutes"), 0),
    lunchDeductEnabled: bool(values.get("lunch_deduct_enabled")),
    lunchStart: values.get("lunch_start") || "12:00",
    lunchEnd: values.get("lunch_end") || "13:00",
    timedTripExempt: bool(values.get("timed_trip_exempt")),
    timedEventMarginHours: float(values.get("timed_event_margin_hours"), 0),
  };
}

export async function loadAttendancePolicy(db: Db): Promise<AttendancePolicy> {
  const rows = await db.policySetting.findMany({
    where: { key: { in: [...ATTENDANCE_POLICY_KEYS] } },
    select: { key: true, value: true },
  });
  return parseAttendancePolicy(new Map(rows.map((r) => [r.key, r.value])));
}

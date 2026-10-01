// 실시간 연결 상태 공용 판정.
// realtime API(실시간 현황 카드)와 attendance-rows(overview/export/calendar의 오늘 행)가
// 같은 함수를 쓴다. 판정 기준이 바뀌면 여기 한 곳만 고친다.
//
// 규칙 (realtime/route.ts 의 원 로직을 그대로 옮김):
//   - 최신 presence_raw 가 online                      → working
//   - offline 이지만 grace(debounce_minutes) 이내      → working  (잠시 자리비움)
//   - offline 이고 grace 경과, 또는 기록 없음          → disconnected

import type { Prisma } from "@/app/generated/prisma/client";
import type { prisma } from "@/lib/prisma";

type Db = Prisma.TransactionClient | typeof prisma;

export type RealtimeStatus = "working" | "disconnected";

// ── 지금 연결 상태 (근무일 경계를 넘어 연결된 채인 직원 포함) ─────────────────
// 오늘 근무일 창 = [오늘 work_date + cutoff 시각(KST), +1일). aggregator 의 work_date 창과 같다.
export function workDayWindow(workDate: Date, cutoffHour: number): { start: Date; end: Date } {
  const start = new Date(
    Date.UTC(workDate.getUTCFullYear(), workDate.getUTCMonth(), workDate.getUTCDate(), cutoffHour) -
      9 * 60 * 60 * 1000
  );
  return { start, end: new Date(start.getTime() + 24 * 60 * 60 * 1000) };
}

export interface CurrentPresence {
  status: string;
  checkedAt: Date;
  location: string | null;
  // 오늘 창 시작 전 기록인데 online — 근무일 경계(04:00)를 넘어 연결된 채인 상태
  carriedOver: boolean;
}

/**
 * 직원별 "지금 연결 상태" — 가장 최근 presence_raw 1건 (idx_presence_raw_emp_time).
 * - 그 기록이 오늘 근무일 창 시작 이후면 그대로 쓴다.
 * - 창 시작 전 기록이면 online 일 때만 쓴다(carriedOver = true). offline 이면 오늘 기록 없음(맵에 없음).
 * todayWorkDate: 오늘 근무일(UTC 자정 date, lib/kst-date kstWorkDateMidnightUtc).
 */
export async function loadCurrentPresence(
  db: Db,
  employeeIds: number[],
  todayWorkDate: Date,
  cutoffHour: number
): Promise<Map<number, CurrentPresence>> {
  const out = new Map<number, CurrentPresence>();
  if (employeeIds.length === 0) return out;
  const { start } = workDayWindow(todayWorkDate, cutoffHour);
  const rows = await db.$queryRaw<
    { employee_id: number; status: string; checked_at: Date; location: string | null }[]
  >`
    SELECT e.id AS employee_id, p.status, p.checked_at, p.location
    FROM UNNEST(${employeeIds}::int[]) AS e(id)
    JOIN LATERAL (
      SELECT status, checked_at, location
      FROM hr.presence_raw
      WHERE employee_id = e.id
      ORDER BY checked_at DESC, id DESC
      LIMIT 1
    ) p ON true
  `;
  for (const r of rows) {
    if (r.checked_at >= start) {
      out.set(r.employee_id, { status: r.status, checkedAt: r.checked_at, location: r.location, carriedOver: false });
    } else if (r.status === "online") {
      out.set(r.employee_id, { status: r.status, checkedAt: r.checked_at, location: r.location, carriedOver: true });
    }
  }
  return out;
}

/**
 * 본인 오늘 연결 요약 — 대시보드 "오늘 나의 연결 상태"·포털 챗 "내 재실 상태" 공용.
 * currentStatus = loadCurrentPresence, 나머지는 오늘 근무일 창 기준.
 * lastOnlineAt = 오늘 창의 마지막 online (없고 이월 연결이면 그 기록 시각).
 */
export async function loadTodayPresenceSummary(
  db: Db,
  employeeId: number,
  todayWorkDate: Date,
  cutoffHour: number
): Promise<{
  currentStatus: string | null;
  lastOnlineAt: Date | null;
  lastOfflineAt: Date | null;
  todayRawCount: number;
}> {
  const { start, end } = workDayWindow(todayWorkDate, cutoffHour);
  const [current, agg] = await Promise.all([
    loadCurrentPresence(db, [employeeId], todayWorkDate, cutoffHour),
    db.$queryRaw<{ last_online_at: Date | null; last_offline_at: Date | null; cnt: bigint }[]>`
      SELECT
        MAX(checked_at) FILTER (WHERE status = 'online') AS last_online_at,
        MAX(checked_at) FILTER (WHERE status = 'offline') AS last_offline_at,
        COUNT(*)::bigint AS cnt
      FROM hr.presence_raw
      WHERE employee_id = ${employeeId}
        AND checked_at >= ${start}
        AND checked_at < ${end}
    `,
  ]);
  const cur = current.get(employeeId) ?? null;
  const row = agg[0];
  return {
    currentStatus: cur?.status ?? null,
    lastOnlineAt: row?.last_online_at ?? (cur?.carriedOver ? cur.checkedAt : null),
    lastOfflineAt: row?.last_offline_at ?? null,
    todayRawCount: row ? Number(row.cnt) : 0,
  };
}

export function computeRealtimeStatus(p: {
  latestStatus: string | null;
  latestCheckedAt: Date | null;
  graceMs: number;
  now: number;
}): RealtimeStatus {
  if (p.latestStatus === "online") return "working";
  if (p.latestStatus === "offline" && p.latestCheckedAt) {
    const elapsed = p.now - p.latestCheckedAt.getTime();
    if (elapsed < p.graceMs) return "working";
  }
  return "disconnected";
}

export type ProgressStatus =
  | "working"
  | "away"
  | "completed"
  | "absent_today"
  | "category_working"
  | "category_completed";

/**
 * 실시간 진행 상태 판정 — 실시간 현황 카드와 상세 모달 오늘 행이 공유한다.
 * (원래 app/api/attendance/realtime/route.ts 에 인라인으로 있던 로직을 옮긴 것)
 *
 * 표시 전용이다. attendance_daily.check_out 확정은 aggregator 가 따로 판단한다.
 */
export function computeProgressStatus(p: {
  latestStatus: string | null;
  latestCheckedAt: Date | null;
  todayCheckOut: Date | null;
  todayIsOverridden: boolean;
  todayCategoryId: number | null;
  todayCorrectedIn: Date | null;
  todayCorrectedOut: Date | null;
  graceMs: number;
  now: number;
}): ProgressStatus {
  const realtimeStatus = computeRealtimeStatus({
    latestStatus: p.latestStatus,
    latestCheckedAt: p.latestCheckedAt,
    graceMs: p.graceMs,
    now: p.now,
  });

  // progressStatus: 클라이언트 편의 분류
  // 캘린더 보정(is_overridden + category_id) 우선. 그 안에서:
  //  - 시간대 일정(corrected_check_in/out 둘 다 있음, 예 외근 09:00~12:00):
  //    * now < cal_in            → 일정 시작 전: 캘린더 분기 skip, 일반 WiFi 로직으로 흐름
  //    * cal_in <= now < cal_out → "category_working"
  //    * now >= cal_out:
  //        realtimeStatus='working'             → "working"  (복귀해 자리에 있음)
  //        elif check_out > cal_out             → "completed" (복귀 후 정상 퇴근)
  //        else                                  → "category_completed" (미복귀)
  //  - 종일 일정(corrected 없음, 예 휴가): check_out 유무로 working/completed (기존 동작)
  // 일반(WiFi) 분기:
  //  - latestStatus 없음 → absent_today
  //  - online → working
  //  - offline + grace 미경과 → away / 경과 → completed
  let progressStatus: ProgressStatus | null = null;

  if (p.todayIsOverridden && p.todayCategoryId !== null) {
    const calIn = p.todayCorrectedIn;
    const calOut = p.todayCorrectedOut;
    const isTimedCalendar = !!(calIn && calOut);
    if (isTimedCalendar) {
      const calInMs = calIn!.getTime();
      const calOutMs = calOut!.getTime();
      if (p.now < calInMs) {
        // 일정 시작 전 — 캘린더 분기 skip, 아래 WiFi 로직으로 흐른다.
        progressStatus = null;
      } else if (p.now < calOutMs) {
        progressStatus = "category_working";
      } else {
        // 종료 후
        if (realtimeStatus === "working") {
          progressStatus = "working";
        } else if (p.todayCheckOut && p.todayCheckOut.getTime() > calOutMs) {
          progressStatus = "completed";
        } else {
          progressStatus = "category_completed";
        }
      }
    } else {
      // 종일 일정 — 기존 동작 유지
      progressStatus = p.todayCheckOut ? "category_completed" : "category_working";
    }
  }

  if (progressStatus === null) {
    if (p.latestStatus === null) {
      progressStatus = "absent_today";
    } else if (p.latestStatus === "online") {
      progressStatus = "working";
    } else if (p.latestStatus === "offline" && p.latestCheckedAt) {
      const elapsed = p.now - p.latestCheckedAt.getTime();
      progressStatus = elapsed < p.graceMs ? "away" : "completed";
    } else {
      // offline인데 checked_at이 없는 비정상 케이스 → 미출근 취급
      progressStatus = "absent_today";
    }
  }

  return progressStatus;
}

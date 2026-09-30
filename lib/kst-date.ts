// KST 날짜 공용 유틸. trip-calendar 와 attendance-recalc 가 같이 쓴다
// (trip-calendar 가 attendance-recalc 를 import 하므로 둘 중 한쪽에 두면 순환 import 가 된다).

// 오늘 근무일 — work_date_cutoff_hour(기본 4) 이전이면 전날. realtime·attendance-rows·aggregator 의
// SQL(CASE WHEN EXTRACT(HOUR FROM KST NOW) < cutoff THEN 전날 ELSE 오늘)과 같은 결과.
// 반환: UTC 자정 Date (date 컬럼 비교용).
export function kstWorkDateMidnightUtc(cutoffHour: number, nowMs: number = Date.now()): Date {
  const kstNow = new Date(nowMs + 9 * 60 * 60 * 1000);
  const d = new Date(
    Date.UTC(kstNow.getUTCFullYear(), kstNow.getUTCMonth(), kstNow.getUTCDate(), 0, 0, 0, 0)
  );
  if (kstNow.getUTCHours() < cutoffHour) d.setUTCDate(d.getUTCDate() - 1);
  return d;
}

// policy_settings 'work_date_cutoff_hour' (없거나 숫자가 아니면 4).
export function parseCutoffHour(raw: string | null | undefined): number {
  return raw && /^\d+$/.test(raw) ? parseInt(raw, 10) : 4;
}

// 정책을 읽어 오늘 근무일을 구한다 (db 는 prisma 또는 트랜잭션 — 서버 전용 import 를 피하려고 인자로 받음).
export async function loadTodayWorkDate(db: {
  policySetting: {
    findUnique(args: { where: { key: string } }): Promise<{ value: string } | null>;
  };
}): Promise<{ date: Date; ymd: string; cutoffHour: number }> {
  const row = await db.policySetting.findUnique({ where: { key: "work_date_cutoff_hour" } });
  const cutoffHour = parseCutoffHour(row?.value);
  const date = kstWorkDateMidnightUtc(cutoffHour);
  return { date, ymd: date.toISOString().slice(0, 10), cutoffHour };
}

// KST 오늘 00:00 을 UTC 자정 Date 로 (날짜 컬럼 비교용). "지난 날짜" = 이보다 이전.
export function kstTodayMidnightUtc(): Date {
  const nowMs = Date.now();
  const kstNow = new Date(nowMs + 9 * 60 * 60 * 1000);
  return new Date(
    Date.UTC(
      kstNow.getUTCFullYear(),
      kstNow.getUTCMonth(),
      kstNow.getUTCDate(),
      0, 0, 0, 0
    )
  );
}

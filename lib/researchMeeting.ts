// 연구미팅 판정 단일 소스 — aggregator(db.py)의 판정과 반드시 동일해야 한다.
// 우선순위: 휴가/신청 > 시프트 휴무(off) > 연구미팅 > 일반 패턴.
// 이 모듈은 "달력상 미팅일인지"만 판정한다. off/미배정 제외는 호출자 책임.
export interface ResearchMeetingPolicy {
  weekday: number;        // ISO: 월=1 … 일=7
  intervalWeeks: number;  // N주 1회
  anchorDate: string;     // YYYY-MM-DD 기준일
  start: string;          // "09:00"
  end: string;            // "18:00"
}

// YYYY-MM-DD → epoch 일수 (UTC 고정 — 타임존 무관 순수 날짜 연산)
function ymdToDays(ymd: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return null;
  return Math.floor(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000);
}
// epoch 일수 → ISO 요일 (1970-01-01=목요일 검증 완료)
function isoWeekdayOf(days: number): number {
  return ((days + 3) % 7) + 1;
}
function mondayOf(days: number): number {
  return days - (isoWeekdayOf(days) - 1);
}

export function isResearchMeetingDay(ymd: string, p: ResearchMeetingPolicy): boolean {
  const d = ymdToDays(ymd);
  const a = ymdToDays(p.anchorDate);
  if (d == null || a == null || p.intervalWeeks < 1) return false;
  if (isoWeekdayOf(d) !== p.weekday) return false;
  const weekDiff = (mondayOf(d) - mondayOf(a)) / 7;
  return ((weekDiff % p.intervalWeeks) + p.intervalWeeks) % p.intervalWeeks === 0;
}

export function nextResearchMeetingDay(fromYmd: string, p: ResearchMeetingPolicy): string | null {
  const d0 = ymdToDays(fromYmd);
  if (d0 == null || p.intervalWeeks < 1) return null;
  for (let i = 0; i <= 7 * (p.intervalWeeks + 1); i++) {
    const ymd = new Date((d0 + i) * 86400000).toISOString().slice(0, 10);
    if (isResearchMeetingDay(ymd, p)) return ymd;
  }
  return null;
}

// ── 서버 전용 ────────────────────────────────────────────────
// policy_settings의 research_meeting_* 5키를 읽어 정책을 만든다.
// 키 누락·파싱 실패·anchorDate 형식 오류면 null = 기능 비활성.
type PolicyReader = {
  policySetting: {
    findMany(args: {
      where: { key: { startsWith: string } };
      select: { key: true; value: true };
    }): Promise<{ key: string; value: string }[]>;
  };
};

export async function loadResearchMeetingPolicy(
  db: PolicyReader
): Promise<ResearchMeetingPolicy | null> {
  try {
    const rows = await db.policySetting.findMany({
      where: { key: { startsWith: "research_meeting_" } },
      select: { key: true, value: true },
    });
    const map = new Map(rows.map((r) => [r.key, r.value]));

    const weekday = Number(map.get("research_meeting_weekday"));
    const intervalWeeks = Number(map.get("research_meeting_interval_weeks"));
    const anchorDate = map.get("research_meeting_anchor_date");
    const start = map.get("research_meeting_start");
    const end = map.get("research_meeting_end");

    if (!Number.isInteger(weekday) || weekday < 1 || weekday > 7) return null;
    if (!Number.isInteger(intervalWeeks) || intervalWeeks < 1) return null;
    if (!anchorDate || !/^\d{4}-\d{2}-\d{2}$/.test(anchorDate)) return null;
    if (!start || !end) return null;

    return { weekday, intervalWeeks, anchorDate, start, end };
  } catch {
    return null;
  }
}

const KST = 9 * 60 * 60 * 1000;

export type PeriodRange = { start: Date; end: Date; label: string };

// 챗 조회용 기간 범위 (KST 기준). 모두 선택적.
// yearMonth("YYYY-MM")가 있으면 그 달, 없으면 period로 분기, 둘 다 없으면 이번달.
// period 허용값: this_week | last_week | this_month | last_month | this_year
export function resolvePeriodRange(period?: string | null, yearMonth?: string | null): PeriodRange {
  const now = new Date(Date.now() + KST);
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const dd = now.getUTCDate();

  if (yearMonth && /^\d{4}-\d{2}$/.test(yearMonth)) {
    const [yy, mm] = yearMonth.split("-").map(Number);
    return {
      start: new Date(Date.UTC(yy, mm - 1, 1)),
      end: new Date(Date.UTC(yy, mm, 1)),
      label: `${yy}-${String(mm).padStart(2, "0")}`,
    };
  }

  switch (period) {
    case "this_week": {
      const dow = (now.getUTCDay() + 6) % 7; // 월요일=0
      return {
        start: new Date(Date.UTC(y, m, dd - dow)),
        end: new Date(Date.UTC(y, m, dd - dow + 7)),
        label: "이번 주",
      };
    }
    case "last_week": {
      const dow = (now.getUTCDay() + 6) % 7;
      return {
        start: new Date(Date.UTC(y, m, dd - dow - 7)),
        end: new Date(Date.UTC(y, m, dd - dow)),
        label: "지난 주",
      };
    }
    case "last_month": {
      const s = new Date(Date.UTC(y, m - 1, 1));
      return {
        start: s,
        end: new Date(Date.UTC(y, m, 1)),
        label: `${s.getUTCFullYear()}-${String(s.getUTCMonth() + 1).padStart(2, "0")}`,
      };
    }
    case "this_year": {
      return {
        start: new Date(Date.UTC(y, 0, 1)),
        end: new Date(Date.UTC(y + 1, 0, 1)),
        label: `${y}년`,
      };
    }
    case "this_month":
    default: {
      return {
        start: new Date(Date.UTC(y, m, 1)),
        end: new Date(Date.UTC(y, m + 1, 1)),
        label: `${y}-${String(m + 1).padStart(2, "0")}`,
      };
    }
  }
}

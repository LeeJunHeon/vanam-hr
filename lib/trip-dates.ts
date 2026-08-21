// 출장 참석 날짜의 "연속 구간" 묶기 — 클라이언트 안전(의존성 없음, prisma import 금지).
//
// ⚠ 그룹 판정 규칙은 lib/trip-calendar.ts::groupConsecutiveForAttendance와 동일 규칙 —
//   변경 시 양쪽을 함께 수정할 것.
//   그쪽 함수가 실제 attendance_request 생성 단위를 결정하므로, 화면 표시 단위가
//   어긋나면 "배지 1개인데 결재는 2건" 같은 불일치가 생긴다.
//   병합 조건: (startTime, endTime)이 직전 그룹과 동일 AND attendDate가 직전 endDate의 다음날.
//   시각이 다르면 날짜가 연속이어도 그룹을 나눈다.
//
// trip-calendar 쪽은 Date 객체(UTC 자정)를 다루지만 여기는 API가 내려준
// "YYYY-MM-DD" / "HH:MM" 문자열을 그대로 다룬다. 로컬 타임존 파싱
// (new Date("2026-08-22"))은 KST/UTC 시프트로 하루가 밀릴 수 있어 쓰지 않는다.

export type TripDateRow = {
  id: number;
  attendDate: string; // "YYYY-MM-DD"
  startTime: string | null; // "HH:MM" | null
  endTime: string | null; // "HH:MM" | null
};

export type TripDateGroup = {
  startDate: string;
  endDate: string;
  startTime: string | null;
  endTime: string | null;
  ids: number[];
};

// "YYYY-MM-DD" → UTC epoch(ms). 파싱 실패면 NaN.
// Date.UTC를 직접 쓰므로 실행 환경 타임존과 무관하다.
function ymdToUtcMs(ymd: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return NaN;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

// b가 a의 바로 다음날인가. trip-calendar::isNextDayUTC와 동일 판정.
function isNextDay(a: string, b: string): boolean {
  const ams = ymdToUtcMs(a);
  const bms = ymdToUtcMs(b);
  if (Number.isNaN(ams) || Number.isNaN(bms)) return false;
  return bms - ams === 86400000;
}

// trip-calendar::timeKey와 동일 — null과 ""를 같은 값으로 취급한다.
function timeKey(t: string | null): string {
  return t ?? "";
}

/**
 * 참석 날짜들을 연속 구간 단위로 묶는다.
 * - 입력 정렬은 보장하지 않는다고 가정하고 attendDate 오름차순으로 정렬한 뒤 그룹핑한다.
 * - 원본 배열은 변경하지 않는다.
 */
export function groupConsecutiveTripDates(
  rows: TripDateRow[]
): TripDateGroup[] {
  const sorted = [...rows].sort((a, b) =>
    a.attendDate.localeCompare(b.attendDate)
  );
  const groups: TripDateGroup[] = [];
  let cur: TripDateGroup | null = null;
  for (const r of sorted) {
    const sameTime =
      cur !== null &&
      timeKey(cur.startTime) === timeKey(r.startTime) &&
      timeKey(cur.endTime) === timeKey(r.endTime);
    const consecutive = cur !== null && isNextDay(cur.endDate, r.attendDate);
    if (cur && sameTime && consecutive) {
      cur.endDate = r.attendDate;
      cur.ids.push(r.id);
    } else {
      cur = {
        startDate: r.attendDate,
        endDate: r.attendDate,
        startTime: r.startTime,
        endTime: r.endTime,
        ids: [r.id],
      };
      groups.push(cur);
    }
  }
  return groups;
}

/**
 * 배지 문구. 단일 날짜 그룹은 기존 낱개 배지와 완전히 같은 문자열을 낸다.
 *   연속 2일 이상 → "2026-08-22 ~ 2026-08-29 종일"
 *   단일 1일      → "2026-08-25 종일"
 *   시간형        → "2026-08-25 12:00~15:00"
 */
export function tripDateGroupLabel(g: TripDateGroup): string {
  const datePart =
    g.startDate === g.endDate ? g.startDate : `${g.startDate} ~ ${g.endDate}`;
  const timePart =
    g.startTime || g.endTime
      ? ` ${g.startTime ?? "-"}~${g.endTime ?? "-"}`
      : " 종일";
  return `${datePart}${timePart}`;
}

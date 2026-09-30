// KST 날짜 공용 유틸. trip-calendar 와 attendance-recalc 가 같이 쓴다
// (trip-calendar 가 attendance-recalc 를 import 하므로 둘 중 한쪽에 두면 순환 import 가 된다).

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

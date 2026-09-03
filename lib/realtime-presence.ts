// 실시간 연결 상태 공용 판정.
// realtime API(실시간 현황 카드)와 attendance-rows(overview/export/calendar의 오늘 행)가
// 같은 함수를 쓴다. 판정 기준이 바뀌면 여기 한 곳만 고친다.
//
// 규칙 (realtime/route.ts 의 원 로직을 그대로 옮김):
//   - 최신 presence_raw 가 online                      → working
//   - offline 이지만 grace(debounce_minutes) 이내      → working  (잠시 자리비움)
//   - offline 이고 grace 경과, 또는 기록 없음          → disconnected

export type RealtimeStatus = "working" | "disconnected";

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

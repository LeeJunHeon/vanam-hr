// 확정(과거/오늘) 근태 행의 "진행" 라벨 공용 판정.
// 출근/퇴근 존재 여부 + 오늘 여부로만 결정한다 (auto_status 저장값은 바꾸지 않음).
//   - 출근O + 퇴근O        → "완료"
//   - 출근O + 퇴근X + 오늘  → "근무중"
//   - 출근O + 퇴근X + 과거  → "미퇴근"
//   - 출근X               → "미출근"

export type SettledProgress = "완료" | "근무중" | "미퇴근" | "미출근";

export function settledProgressLabel(p: {
  hasCheckIn: boolean;
  hasCheckOut: boolean;
  isToday: boolean;
}): SettledProgress {
  if (!p.hasCheckIn) return "미출근";
  if (p.hasCheckOut) return "완료";
  // 출근O + 퇴근X
  return p.isToday ? "근무중" : "미퇴근";
}

// 라벨별 색상 매핑 (재사용).
export const SETTLED_PROGRESS_STYLE: Record<
  SettledProgress,
  { text: string; dot: string }
> = {
  "완료": { text: "text-blue-700", dot: "bg-blue-500" },
  "근무중": { text: "text-emerald-700", dot: "bg-emerald-500" },
  "미퇴근": { text: "text-amber-700", dot: "bg-amber-500" },
  "미출근": { text: "text-gray-500", dot: "bg-gray-400" },
};

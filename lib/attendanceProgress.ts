import type { CSSProperties } from "react";
import type { ProgressStatus } from "@/lib/realtime-presence";

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

// 실시간 진행 상태(progressStatus) 표시 색상 — 실시간 현황 카드와 상세 모달이 공유한다.
// 값은 AttendanceOverviewPage 의 기존 progressDotColor / progressBadgeClass 를 그대로 옮긴 것.
// category_* 는 fallback purple 이며, categoryColor 가 있으면 호출부에서 inline style 로 덮는다.

export function progressDotColor(s: ProgressStatus): string {
  switch (s) {
    case "working":
      return "bg-emerald-500";
    case "away":
      return "bg-amber-500";
    case "completed":
      return "bg-blue-500";
    case "absent_today":
      return "bg-gray-400";
    case "category_working":
    case "category_completed":
      return "bg-purple-500"; // categoryColor 있으면 inline style로 덮어씀
  }
}

export function progressBadgeClass(s: ProgressStatus): string {
  const base =
    "inline-flex items-center text-xs px-2 py-0.5 rounded-md font-medium shrink-0";
  switch (s) {
    case "working":
      return `${base} bg-emerald-50 text-emerald-700`;
    case "away":
      return `${base} bg-amber-50 text-amber-700`;
    case "completed":
      return `${base} bg-blue-50 text-blue-700`;
    case "absent_today":
      return `${base} bg-gray-50 text-gray-600`;
    case "category_working":
    case "category_completed":
      return `${base} bg-purple-50 text-purple-700`;
  }
}

/** dot + 텍스트 형태(모달 진행 칸)용 글자색. 배지 배경 없이 쓸 때. */
export function progressTextColor(s: ProgressStatus): string {
  switch (s) {
    case "working":
      return "text-emerald-700";
    case "away":
      return "text-amber-700";
    case "completed":
      return "text-blue-700";
    case "absent_today":
      return "text-gray-600";
    case "category_working":
    case "category_completed":
      return "text-purple-700";
  }
}

/**
 * category_* 이고 categoryColor 가 있을 때 purple fallback 을 덮는 inline style.
 * 목록 배지: 배경+글자색 / 모달 dot+텍스트: 글자색만 (variant 로 구분)
 * 해당 없으면 undefined 를 반환해 className 색이 그대로 쓰이게 한다.
 */
export function progressCategoryStyle(
  s: ProgressStatus,
  categoryColor: string | null | undefined,
  variant: "badge" | "text" = "badge"
): CSSProperties | undefined {
  if (s !== "category_working" && s !== "category_completed") return undefined;
  if (!categoryColor) return undefined;
  return variant === "badge"
    ? { backgroundColor: `${categoryColor}20`, color: categoryColor }
    : { color: categoryColor };
}

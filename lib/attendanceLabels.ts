// 시간대 표시(정정 시각/외근 시간대) 라벨.
// 근태정정(CORRECTION)이면 "근태정정", 그 외는 카테고리명(없으면 "일정").
export function correctedRangeLabel(
  categoryCode: string | null | undefined,
  categoryName: string | null | undefined
): string {
  if (categoryCode === "CORRECTION") return "근태정정";
  return categoryName || "일정";
}

// HH:MM (없으면 fallback). 파일별 폴백("-"/"")을 인자로 흡수.
export function formatTime(iso: string | null, fallback = "-"): string {
  if (!iso) return fallback;
  const d = new Date(iso);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

// 근무시간 (분 → "N시간 M분")
export function formatWorkMinutes(min: number | null): string {
  if (min === null || min === undefined) return "-";
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h === 0) return `${m}분`;
  if (m === 0) return `${h}시간`;
  return `${h}시간 ${m}분`;
}

// 휴가성(vacation) 카테고리 여부 — 종일이라 "진행/완료" 구분 없이 카테고리명만 표시
export function isVacationCategory(code: string | null): boolean {
  if (!code) return false;
  return ["ANNUAL", "HALF_AM", "HALF_PM", "SICK", "FAMILY_EVENT"].includes(code);
}

// "진행/완료" 접미사를 붙이지 않고 카테고리명만 표시할 카테고리 = 휴가류 + 기타(ETC).
export function isLabelOnlyCategory(code: string | null): boolean {
  return isVacationCategory(code) || code === "ETC";
}

// auto_status 4종 공통 매핑 (라벨/텍스트색 — 세 화면 모두 동일 값 사용 중)
export const AUTO_STATUS_META: Record<
  "normal" | "late" | "early_leave" | "absent",
  { label: string; cls: string }
> = {
  normal: { label: "정상", cls: "text-emerald-600" },
  late: { label: "지각", cls: "text-amber-600" },
  early_leave: { label: "조퇴", cls: "text-orange-600" },
  absent: { label: "결근", cls: "text-rose-600" },
};

// 평가 라벨.
// - check_out이 없으면 평가 보류 ('–')
// - autoStatus가 NULL이지만 check_out 있으면 '정상' 추정 (옛날 데이터 보호)
export function evalLabel(autoStatus: string | null, hasCheckOut: boolean): string {
  if (!hasCheckOut) return "–";
  if (autoStatus === "normal") return "정상";
  if (autoStatus === "late") return "지각";
  if (autoStatus === "early_leave") return "조퇴";
  if (autoStatus === "absent") return "결근";
  // NULL이지만 check_out 있음 → autoStatus 도입 전 옛날 데이터로 추정, '정상'으로 표시
  return "정상";
}

// 평가 텍스트 색상 (evalLabel과 동일한 분기)
export function evalColor(autoStatus: string | null, hasCheckOut: boolean): string {
  if (!hasCheckOut) return "text-gray-400"; // 평가 보류 '–'
  if (autoStatus === "normal") return "text-emerald-600";
  if (autoStatus === "late") return "text-amber-600";
  if (autoStatus === "early_leave") return "text-orange-600";
  if (autoStatus === "absent") return "text-rose-600";
  // NULL이지만 check_out 있음 → 정상 색상으로
  return "text-emerald-600";
}

export type ProgressStatus =
  | "working"
  | "away"
  | "completed"
  | "absent_today"
  | "category_working"
  | "category_completed";

// 진행 상태 한글 라벨 — AttendanceOverviewPage progressLabel 규칙.
// (카테고리명 없을 때 category_working/category_completed 폴백은 "부재중" — 도달 불가 분기)
export function progressLabel(
  s: ProgressStatus,
  categoryName: string | null,
  categoryCode: string | null
): string {
  switch (s) {
    case "working":
      return "근무중";
    case "away":
      return "자리비움";
    case "completed":
      return "완료";
    case "absent_today":
      return "미출근";
    case "category_working":
      if (categoryName) {
        return isLabelOnlyCategory(categoryCode)
          ? categoryName // "연차"/"병가"/"기타" 등 (접미사 X)
          : `${categoryName}중`; // "외근중"
      }
      return "부재중";
    case "category_completed":
      if (categoryName) {
        return isLabelOnlyCategory(categoryCode)
          ? categoryName // "연차"/"기타" 등 (접미사 X)
          : `${categoryName}완료`; // "외근완료"
      }
      return "부재중";
  }
}

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

/**
 * 근무일(workDate) 기준으로 해당 시각이 며칠 뒤인지 반환한다.
 * 야간 근무가 자정을 넘겨 다음 날 퇴근한 경우 "+1" 표식을 붙이기 위한 것.
 * 반환: 0 = 같은 날, 1 = 다음 날, 2 = 이틀 뒤 … 계산 불가면 0.
 *
 * ※ formatTime이 브라우저 로컬(KST) 기준으로 시각을 뽑으므로
 *   날짜 비교도 반드시 같은 기준(getFullYear/getMonth/getDate)을 써야 한다.
 *   toISOString()을 쓰면 UTC로 밀려 9시간 어긋난다.
 */
export function dayOffsetFromWorkDate(
  workDate: string | null | undefined,
  iso: string | null | undefined
): number {
  if (!workDate || !iso) return 0;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return 0;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const actualYmd = `${y}-${m}-${dd}`;
  if (actualYmd === workDate) return 0;
  const a = Date.parse(`${actualYmd}T00:00:00`);
  const b = Date.parse(`${workDate}T00:00:00`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.round((a - b) / 86400000);
}

/**
 * 근무일과 다른 날의 시각이면 실제 날짜를 담은 title 문자열을 반환한다.
 * 같은 날이거나 값이 없으면 undefined (title 속성이 안 붙음).
 */
export function dayOffsetTitle(
  workDate: string | null | undefined,
  iso: string | null | undefined
): string | undefined {
  const off = dayOffsetFromWorkDate(workDate, iso);
  if (off <= 0 || !iso) return undefined;
  const d = new Date(iso);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd} (${off === 1 ? "익일" : `${off}일 뒤`} 퇴근)`;
}

// 근무시간 (분 → "N시간 M분")
export function formatWorkMinutes(min: number | null): string {
  if (min === null || min === undefined) return "-";
  // 음수 방어 — Math.floor / % 가 시·분 양쪽에 부호를 붙여 "-7시간 -24분" 같은
  // 깨진 문자열을 만든다. 정상 데이터가 아니므로 값이 아니라 표식을 보여준다.
  if (min < 0) return "오류";
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

// ── 상태 라벨 단일 소스 ────────────────────────────────────────────
// 라벨/이모지/색은 여기서만 정의한다. 다른 파일의 배지·아이콘 맵은
// 전부 이 값에서 파생시킬 것. 색을 바꾸려면 여기 한 줄만 고치면 된다.
//
// ⚠ Tailwind 주의: 빌드 시 소스를 문자열로 스캔하므로 `text-${x}-600` 같은
//   동적 조합은 클래스가 통째로 사라진다. 반드시 완성된 문자열로 적을 것.
export const EVAL_STATUS = {
  normal:      { label: "정상", icon: "🟢", cls: "text-emerald-600", hex: "#10b981" },
  late:        { label: "지각", icon: "🟡", cls: "text-amber-600",   hex: "#f59e0b" },
  early_leave: { label: "조퇴", icon: "🟠", cls: "text-orange-600",  hex: "#f97316" },
  absent:      { label: "결근", icon: "🔴", cls: "text-rose-600",    hex: "#ef4444" },
} as const;

export type EvalStatusKey = keyof typeof EVAL_STATUS;

// 진행 축 '근무중' — 평가는 아니지만 캘린더 아이콘 맵에서 함께 쓰인다.
export const PROGRESS_WORKING = {
  label: "근무중", icon: "🔵", cls: "text-blue-600", hex: "#3b82f6",
} as const;

// auto_status 4종 공통 매핑 — EVAL_STATUS에서 파생 (값은 기존과 동일)
export const AUTO_STATUS_META: Record<
  EvalStatusKey,
  { label: string; cls: string }
> = {
  normal:      { label: EVAL_STATUS.normal.label,      cls: EVAL_STATUS.normal.cls },
  late:        { label: EVAL_STATUS.late.label,        cls: EVAL_STATUS.late.cls },
  early_leave: { label: EVAL_STATUS.early_leave.label, cls: EVAL_STATUS.early_leave.cls },
  absent:      { label: EVAL_STATUS.absent.label,      cls: EVAL_STATUS.absent.cls },
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

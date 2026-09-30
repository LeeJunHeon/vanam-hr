// 근태 숫자 공통 기준 — 같은 사람·같은 날이면 웹·포털·챗·엑셀 어디서 봐도 같은 숫자가 나오게 한다.
// 이 파일은 클라이언트에서도 쓰이므로 서버 전용 모듈을 import 하지 않는다.
//
// - 평가 키: lib/attendanceLabels evalKeys (지각·조퇴 플래그 우선, 둘 다 NULL 인 옛 행은 auto_status).
//   지각·조퇴 둘 다면 양쪽에 1씩 센다.
// - 구분: lib/category-kind (휴가 = leave·long_leave, 근무 = work — 재택 포함).
import {
  evalKeys,
  type EvalStatusKey,
  type ProgressStatus,
} from "@/lib/attendanceLabels";
import {
  isLeaveCategoryType,
  isNonWorkDayLeave,
  isWorkCategoryType,
} from "@/lib/category-kind";

export interface SummaryRowInput {
  checkIn: string | Date | null;
  checkOut: string | Date | null;
  autoStatus: string | null;
  isLate?: boolean | null;
  isEarlyLeave?: boolean | null;
  categoryType?: string | null;
  // 이 직원의 근무일인가 (loadWorkDayChecker). 모르면 true 로 본다(기존처럼 센다).
  isWorkDay?: boolean;
}

// 한 줄의 평가 키 (빈 배열 = 평가 보류)
export function rowEvalKeys(r: SummaryRowInput): EvalStatusKey[] {
  return evalKeys(r.autoStatus, r.isLate ?? null, r.isEarlyLeave ?? null, !!r.checkOut);
}

export interface DaySummary {
  attended: number; // 출근 시각이 있는 날 (휴무일 줄 포함)
  normal: number;
  late: number;
  earlyLeave: number;
  absent: number;
  leave: number; // 휴가 type 인 날
  work: number; // 근무 type(출장·외근·재택) 인 날
}

/**
 * 기간 요약.
 * - 출근 = 출근 시각이 있는 날(휴무일 줄 포함).
 * - 나머지 칸(정상·지각·조퇴·결근·휴가·근무)은 휴무일 휴가 줄(isNonWorkDayLeave)을 뺀 뒤 센다.
 */
export function summarizeDays(rows: SummaryRowInput[]): DaySummary {
  const s: DaySummary = {
    attended: 0, normal: 0, late: 0, earlyLeave: 0, absent: 0, leave: 0, work: 0,
  };
  for (const r of rows) {
    if (r.checkIn) s.attended += 1;
    if (isNonWorkDayLeave(r.categoryType ?? null, r.isWorkDay ?? true)) continue;
    for (const k of rowEvalKeys(r)) {
      if (k === "normal") s.normal += 1;
      else if (k === "late") s.late += 1;
      else if (k === "early_leave") s.earlyLeave += 1;
      else if (k === "absent") s.absent += 1;
    }
    if (isLeaveCategoryType(r.categoryType)) s.leave += 1;
    else if (isWorkCategoryType(r.categoryType)) s.work += 1;
  }
  return s;
}

// 지각·조퇴 사유 대상 라벨 — "지각" / "조퇴" / "지각·조퇴", 대상이 아니면 null.
// 일별 모달(입력·첨부 표시)과 사유·첨부 API(허용 판정)가 같이 쓴다.
export function lateEarlyReasonLabel(r: SummaryRowInput): string | null {
  const keys = rowEvalKeys(r);
  const late = keys.includes("late");
  const early = keys.includes("early_leave");
  if (late && early) return "지각·조퇴";
  if (late) return "지각";
  if (early) return "조퇴";
  return null;
}

// 오늘 칸 — 한 사람은 칸 하나.
export type TodayBucket = "working" | "completed" | "work" | "leave_etc" | "absent_today";

export function todayBucket(
  progressStatus: ProgressStatus,
  categoryType: string | null | undefined
): TodayBucket {
  switch (progressStatus) {
    case "working":
    case "away":
      return "working";
    case "completed":
      return "completed";
    case "category_working":
    case "category_completed":
      return isWorkCategoryType(categoryType) ? "work" : "leave_etc";
    case "absent_today":
    default:
      return "absent_today";
  }
}

// 오늘 칸 이름 — 화면·챗이 같은 이름을 쓴다.
export const TODAY_BUCKET_LABEL: Record<TodayBucket, string> = {
  working: "근무 중",
  completed: "퇴근 완료",
  work: "출장·외근·재택",
  leave_etc: "휴가 및 기타",
  absent_today: "미출근",
};

// 근태 카테고리 "종류" 판정 — 휴가인지·근무(출장/외근/재택)인지는 여기서만 판정한다.
// 기준은 attendance_categories.type ('leave' | 'work' | 'correction').
// annual_leave_deduct(연차 차감값)는 "연차를 며칠 빼나"이지 "휴가인가"가 아니다.
// 차감값 0.00 인 재택근무(work)를 휴가로 세던 문제(2026-09)가 둘을 섞어서 생겼다.
// 이 파일은 클라이언트에서도 쓰이므로 서버 전용 모듈을 import 하지 않는다.

export function isLeaveCategoryType(type: string | null | undefined): boolean {
  return type === "leave";
}

export function isWorkCategoryType(type: string | null | undefined): boolean {
  return type === "work";
}

// 요약 숫자에서 뺄 줄 — 휴가 종류인데 그 직원의 근무일이 아닌 날.
// aggregator 는 캘린더 표시용으로 휴가 기간의 모든 날(주말·시프트 휴무일 포함)에 줄을 만든다.
// 목록·캘린더·엑셀 표시는 그대로 두고, 줄을 "세는" 곳에서만 이 함수로 거른다.
export function isNonWorkDayLeave(
  type: string | null | undefined,
  isWorkDay: boolean
): boolean {
  return isLeaveCategoryType(type) && !isWorkDay;
}

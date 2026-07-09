// 시간대 표시(정정 시각/외근 시간대) 라벨.
// 근태정정(CORRECTION)이면 "근태정정", 그 외는 카테고리명(없으면 "일정").
export function correctedRangeLabel(
  categoryCode: string | null | undefined,
  categoryName: string | null | undefined
): string {
  if (categoryCode === "CORRECTION") return "근태정정";
  return categoryName || "일정";
}

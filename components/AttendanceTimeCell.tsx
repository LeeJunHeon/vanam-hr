import {
  formatTime,
  dayOffsetFromWorkDate,
  dayOffsetTitle,
} from "@/lib/attendanceLabels";

// 출퇴근 셀 — 정정된 경우 원본(취소선) + 정정값(청록). 캘린더 일별 모달과 동일 규칙.
// workDate를 주면 자정을 넘긴 시각에 "+1" 윗첨자를 붙인다(야간 근무).
// 직원 상세 모달(EmployeeAttendanceDetailModal)·전체 근무시간 조회(WorkHoursPage)가 같이 쓴다.
export function renderTimeCell(
  original: string | null,
  actual: string | null,
  workDate?: string
) {
  const off = workDate ? dayOffsetFromWorkDate(workDate, actual) : 0;
  const mark =
    off > 0 ? (
      <sup
        className="ml-0.5 text-[10px] font-semibold text-amber-600"
        title={dayOffsetTitle(workDate, actual)}
      >
        +{off}
      </sup>
    ) : null;
  if (original) {
    return (
      <>
        <span className="line-through text-gray-400 mr-1">{formatTime(original)}</span>
        <span className="text-cyan-600 font-semibold">
          {formatTime(actual)}
          {mark}
        </span>
      </>
    );
  }
  if (!actual) return "-";
  return (
    <>
      {formatTime(actual)}
      {mark}
    </>
  );
}

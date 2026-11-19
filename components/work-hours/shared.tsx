// 전체 근무시간 조회 하위 컴포넌트 공용 — 타입·글자 색·표 칸 스타일·퇴사 배지·펼침 아이콘.
// 계산은 lib/work-hours, 표시 형식은 lib/attendanceLabels 를 그대로 쓴다.
import { ChevronDown, ChevronRight } from "lucide-react";
import { formatWorkMinutes, PROGRESS_WORKING } from "@/lib/attendanceLabels";
import type { DayState, WorkHoursColumn, WorkHoursView } from "@/lib/work-hours";
import type { WorkHoursDetailData } from "@/components/work-hours/WorkHoursDetail";

export interface WorkHoursEmployee {
  id: number;
  name: string;
  departmentName: string | null;
  isActive: boolean;
}

// 숫자 칸 글자 색 — "-"·"0분" 연한 회색, 근무중 파랑, 퇴근 없음·기록 오류 주황
export const ZERO = formatWorkMinutes(0);
export function tone(text: string, state?: DayState): string {
  if (text === "-" || text === ZERO) return "text-gray-300";
  if (state === "working") return PROGRESS_WORKING.cls;
  if (state === "no_checkout" || state === "invalid") return "text-orange-500";
  return "text-gray-700";
}

// 토·일 색 — AttendanceCalendarView 와 같다
export function weekdayTone(ymd: string): string {
  const dow = new Date(ymd + "T00:00:00.000Z").getUTCDay();
  return dow === 0 ? "text-rose-500" : dow === 6 ? "text-blue-500" : "text-gray-500";
}

// 표 칸 스타일 (직원 표·상세 표 공용)
export const thBase = "align-middle text-xs font-semibold text-gray-500 whitespace-nowrap";
export const tdBase = "h-11 text-sm whitespace-nowrap overflow-hidden text-ellipsis";
export const tdCls = `${tdBase} px-3`;
// 숫자 칸 — 상세 모달 근무 칸과 같은 font-mono, 오른쪽 정렬로 자릿수를 맞춘다
export const numCls = `${tdBase} px-2 font-mono tabular-nums text-right`;

export function RetiredBadge() {
  return (
    <span className="text-xs font-semibold text-rose-600 bg-rose-50 px-2 py-0.5 rounded-full shrink-0">
      퇴사
    </span>
  );
}

/** 직원 표(WorkHoursTable)·휴대폰 카드(WorkHoursMobileList) 공용 props */
export interface WorkHoursListProps {
  view: WorkHoursView;
  columns: WorkHoursColumn[];
  employees: WorkHoursEmployee[];
  today: string;
  totalLabel: string;
  cellOf: (empId: number, col: WorkHoursColumn) => { text: string; state?: DayState };
  totalOf: (empId: number) => { text: string; remark: string };
  /** 펼친 직원 */
  expandedId: number | null;
  /** 펼친 직원에서 눌러 둔 칸(열 key) — 없으면 null */
  activeColumnKey: string | null;
  onToggleEmployee: (id: number) => void;
  onSelectColumn: (id: number, col: WorkHoursColumn) => void;
  /** 펼친 직원 상세 (expandedId 가 표에 있을 때만) */
  detail: WorkHoursDetailData | null;
}

// 펼침 아이콘 — AnnualLeavePage 와 같은 아이콘·색
export function ExpandIcon({ expanded }: { expanded: boolean }) {
  return expanded ? (
    <ChevronDown size={16} className="text-gray-400 shrink-0" />
  ) : (
    <ChevronRight size={16} className="text-gray-400 shrink-0" />
  );
}

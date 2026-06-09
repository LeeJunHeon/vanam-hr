"use client";

import { useEffect } from "react";
import { X } from "lucide-react";

// ScheduleOverviewPage의 타입과 일치
export interface CategoryGroup {
  key: string;
  label: string;
  icon: string;
  codes: readonly string[];
  color: string;
}

export interface ScheduleRow {
  id: number;
  employeeId: number;
  employeeNo: string;
  employeeName: string;
  departmentName: string | null;
  positionName: string | null;
  categoryCode: string | null;
  categoryName: string | null;
  categoryColor: string | null;
  startDate: string;
  endDate: string;
  correctedCheckIn: string | null;
  correctedCheckOut: string | null;
  reason: string | null;
  isAllDay: boolean;
  isMultiDay: boolean;
}

// 사람 단위 묶음 (ScheduleOverviewPage와 동일 정의)
export interface PersonGroup {
  employeeId: number;
  employeeNo: string;
  employeeName: string;
  departmentName: string | null;
  positionName: string | null;
  rows: ScheduleRow[];
}

interface Props {
  group: CategoryGroup;
  items: PersonGroup[];
  onClose: () => void;
}

function formatTime(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// 시간 표시 ("종일" 또는 "13:00 ~ 15:00")
function timeLabel(row: ScheduleRow): string {
  if (row.correctedCheckIn && row.correctedCheckOut) {
    return `${formatTime(row.correctedCheckIn)} ~ ${formatTime(row.correctedCheckOut)}`;
  }
  return "종일";
}

// 기간 표시 ("2026-06-01" 또는 "2026-06-01 ~ 2026-06-03")
function periodLabel(row: ScheduleRow): string {
  if (row.startDate === row.endDate) return row.startDate;
  return `${row.startDate} ~ ${row.endDate}`;
}

export default function ScheduleCategoryModal({
  group,
  items,
  onClose,
}: Props) {
  // ESC 닫기 (AttendanceCalendarDayModal 패턴)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl border border-gray-100 shadow-xl max-w-2xl w-full max-h-[80vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 헤더 */}
        <div className="sticky top-0 bg-white border-b border-gray-100 px-4 sm:px-5 py-3 flex items-center justify-between z-10">
          <div className="flex items-center gap-2 min-w-0">
            {group.icon && <span className="text-xl">{group.icon}</span>}
            <h3 className="font-bold text-gray-900 text-base">
              {group.label}{" "}
              <span className="text-gray-400 font-normal">
                ({items.length}명)
              </span>
            </h3>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 hover:bg-gray-100 rounded-lg"
            aria-label="닫기"
          >
            <X size={18} />
          </button>
        </div>

        {/* 내용 — 사람으로 묶고, 한 사람 안에서 일정들을 나열 */}
        <div className="flex-1 overflow-y-auto">
          {items.length === 0 ? (
            <div className="px-5 py-12 text-center text-sm text-gray-400">
              오늘 {group.label} 일정이 없습니다.
            </div>
          ) : (
            <div className="divide-y divide-gray-100">
              {items.map((pg) => (
                <div key={pg.employeeId} className="p-3 sm:p-4 space-y-2">
                  {/* 사람 헤더 */}
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-semibold text-gray-900 text-sm truncate">
                        {pg.employeeName}
                        <span className="ml-1 text-xs text-gray-400 font-mono">
                          {pg.employeeNo}
                        </span>
                      </p>
                      <p className="text-xs text-gray-500 truncate">
                        {pg.departmentName ?? "-"} · {pg.positionName ?? "-"}
                      </p>
                    </div>
                    <span className="text-[11px] font-semibold bg-blue-50 text-blue-700 px-2 py-0.5 rounded-full shrink-0">
                      {pg.rows.length}건
                    </span>
                  </div>

                  {/* 그 사람의 일정들 */}
                  <ul className="space-y-1.5 pl-1 sm:pl-2">
                    {pg.rows.map((row) => (
                      <li
                        key={row.id}
                        className="text-xs sm:text-sm border-l-2 border-gray-200 pl-2 sm:pl-3"
                      >
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
                          <span className="font-mono text-gray-700">
                            {periodLabel(row)}
                          </span>
                          {/* 휴가 그룹: ANNUAL/HALF_AM/HALF_PM 구분 표시 */}
                          {group.key === "leave" && row.categoryName && (
                            <span className="text-purple-600">
                              ({row.categoryName})
                            </span>
                          )}
                          <span className="font-mono text-gray-500">
                            {timeLabel(row)}
                          </span>
                        </div>
                        {row.reason && (
                          <p
                            className="mt-0.5 text-gray-500 line-clamp-2"
                            title={row.reason}
                          >
                            <span className="text-gray-400">사유: </span>
                            {row.reason}
                          </p>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

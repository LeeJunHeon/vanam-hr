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

interface Props {
  group: CategoryGroup;
  items: ScheduleRow[];
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

        {/* 내용 */}
        <div className="flex-1 overflow-y-auto">
          {items.length === 0 ? (
            <div className="px-5 py-12 text-center text-sm text-gray-400">
              오늘 {group.label} 일정이 없습니다.
            </div>
          ) : (
            <>
              {/* 데스크탑 테이블 */}
              <table className="hidden sm:table w-full text-sm">
                <thead className="bg-gray-50 text-xs">
                  <tr>
                    <th className="px-3 py-2 text-left">직원</th>
                    <th className="px-3 py-2 text-left">부서/직급</th>
                    <th className="px-3 py-2 text-left">기간</th>
                    <th className="px-3 py-2 text-left">시간</th>
                    <th className="px-3 py-2 text-left">사유</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((row) => (
                    <tr
                      key={row.id}
                      className="border-t border-gray-50 hover:bg-blue-50/30"
                    >
                      <td className="px-3 py-2.5 font-medium text-gray-900">
                        {row.employeeName}
                        <span className="ml-1 text-xs text-gray-400 font-mono">
                          {row.employeeNo}
                        </span>
                      </td>
                      <td className="px-3 py-2.5 text-gray-600 text-xs">
                        {row.departmentName ?? "-"} ·{" "}
                        {row.positionName ?? "-"}
                      </td>
                      <td className="px-3 py-2.5 text-xs font-mono">
                        {periodLabel(row)}
                        {/* 휴가 그룹: ANNUAL/HALF_AM/HALF_PM 구분 표시 */}
                        {group.key === "leave" && row.categoryName && (
                          <span className="ml-1 text-purple-600 font-sans">
                            ({row.categoryName})
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2.5 font-mono text-xs">
                        {timeLabel(row)}
                      </td>
                      <td className="px-3 py-2.5 text-xs text-gray-500 max-w-xs">
                        <p
                          className="line-clamp-2"
                          title={row.reason ?? ""}
                        >
                          {row.reason || "-"}
                        </p>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {/* 모바일 카드 리스트 */}
              <div className="sm:hidden divide-y divide-gray-100">
                {items.map((row) => (
                  <div key={row.id} className="p-3 space-y-1.5">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="font-semibold text-gray-900 text-sm truncate">
                          {row.employeeName}
                        </p>
                        <p className="text-xs text-gray-500 truncate">
                          {row.departmentName ?? "-"} ·{" "}
                          {row.positionName ?? "-"}
                        </p>
                      </div>
                      {group.key === "leave" && row.categoryName && (
                        <span className="text-xs text-purple-600 shrink-0">
                          ({row.categoryName})
                        </span>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
                      <span>
                        <span className="text-gray-500">기간: </span>
                        <span className="font-mono">{periodLabel(row)}</span>
                      </span>
                      <span>
                        <span className="text-gray-500">시간: </span>
                        <span className="font-mono">{timeLabel(row)}</span>
                      </span>
                    </div>
                    {row.reason && (
                      <p className="text-xs text-gray-500">
                        <span className="text-gray-400">사유: </span>
                        {row.reason}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

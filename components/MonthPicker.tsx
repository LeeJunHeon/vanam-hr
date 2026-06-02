"use client";

import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

// Phase 6-2K: 년월 선택 다이얼로그 (DatePicker 디자인 패턴 모방, 모바일 대응)
// value/onChange 형식은 "YYYY-MM"

interface MonthPickerProps {
  value: string; // "YYYY-MM"
  onChange: (yearMonth: string) => void;
  onClose: () => void;
}

const KO_MONTHS = [
  "1월",
  "2월",
  "3월",
  "4월",
  "5월",
  "6월",
  "7월",
  "8월",
  "9월",
  "10월",
  "11월",
  "12월",
];

export default function MonthPicker({
  value,
  onChange,
  onClose,
}: MonthPickerProps) {
  // 현재 선택값 파싱
  const [yearStr, monthStr] = value.split("-");
  const selectedYear = parseInt(yearStr, 10);
  const selectedMonth = parseInt(monthStr, 10); // 1~12

  // 표시 중인 년도 (선택값 기준 시작, 좌우 화살표로 이동)
  const [viewYear, setViewYear] = useState(selectedYear);

  // ESC 닫기
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const handlePick = (m: number) => {
    onChange(`${viewYear}-${String(m).padStart(2, "0")}`);
    onClose();
  };

  return (
    <div
      className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl border border-gray-100 shadow-xl w-full max-w-sm"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 헤더: 년도 네비 */}
        <div className="flex items-center justify-between px-4 sm:px-5 py-3 border-b border-gray-100">
          <button
            type="button"
            onClick={() => setViewYear(viewYear - 1)}
            className="p-1.5 rounded-lg hover:bg-gray-100"
            aria-label="이전년도"
          >
            <ChevronLeft size={16} className="text-gray-600" />
          </button>
          <h3 className="font-bold text-gray-900 text-sm sm:text-base font-mono">
            {viewYear}년
          </h3>
          <button
            type="button"
            onClick={() => setViewYear(viewYear + 1)}
            className="p-1.5 rounded-lg hover:bg-gray-100"
            aria-label="다음년도"
          >
            <ChevronRight size={16} className="text-gray-600" />
          </button>
        </div>

        {/* 월 그리드 3x4 */}
        <div className="grid grid-cols-3 gap-2 p-4 sm:p-5">
          {KO_MONTHS.map((label, idx) => {
            const m = idx + 1;
            const isSelected =
              viewYear === selectedYear && m === selectedMonth;
            return (
              <button
                key={m}
                type="button"
                onClick={() => handlePick(m)}
                className={`py-3 rounded-xl text-sm font-semibold transition-colors ${
                  isSelected
                    ? "bg-blue-500 text-white"
                    : "bg-gray-50 text-gray-700 hover:bg-blue-50"
                }`}
              >
                {label}
              </button>
            );
          })}
        </div>

        {/* 닫기 버튼 (모바일 편의) */}
        <div className="px-4 sm:px-5 py-3 border-t border-gray-100 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-1.5 text-sm text-gray-600 hover:bg-gray-100 rounded-lg"
          >
            닫기
          </button>
        </div>
      </div>
    </div>
  );
}

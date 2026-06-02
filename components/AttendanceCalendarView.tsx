"use client";

import { useState, useEffect, useMemo } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Download,
  Calendar,
  Loader2,
} from "lucide-react";
import AttendanceCalendarDayModal, {
  type CalendarEmployee,
  type CalendarDaily,
  type CalendarRequest,
} from "@/components/AttendanceCalendarDayModal";
import MonthPicker from "@/components/MonthPicker";

// 카테고리 → 기호/색상/라벨
const CATEGORY_ICONS: Record<
  string,
  { icon: string; color: string; label: string }
> = {
  ANNUAL: { icon: "🏖️", color: "#3b82f6", label: "휴가" },
  HALF_AM: { icon: "🏖️", color: "#60a5fa", label: "오전반차" },
  HALF_PM: { icon: "🏖️", color: "#60a5fa", label: "오후반차" },
  SICK: { icon: "🏥", color: "#ef4444", label: "병가" },
  FAMILY_EVENT: { icon: "", color: "#a855f7", label: "경조사" },
  EXTERNAL_WORK: { icon: "🌐", color: "#f59e0b", label: "외근" },
  BUSINESS_TRIP: { icon: "✈️", color: "#f97316", label: "출장" },
  REMOTE_WORK: { icon: "🏠", color: "#10b981", label: "재택" },
  ETC: { icon: "📋", color: "#9ca3af", label: "기타" },
};

const STATUS_ICONS: Record<
  string,
  { icon: string; color: string; label: string }
> = {
  // Phase 6-2K: 근무중(working) 추가
  working: { icon: "🔵", color: "#3b82f6", label: "근무중" },
  normal: { icon: "🟢", color: "#10b981", label: "정상" },
  late: { icon: "🟡", color: "#f59e0b", label: "지각" },
  early_leave: { icon: "🟠", color: "#f97316", label: "조퇴" },
  absent: { icon: "🔴", color: "#ef4444", label: "결근" },
};

const CORRECTION_ICON = { icon: "✏️", color: "#06b6d4", label: "정정" };

interface CalendarResponse {
  yearMonth: string;
  employees: CalendarEmployee[];
  daily: CalendarDaily[];
  requests: CalendarRequest[];
}

function thisMonthYm(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function shiftMonth(ym: string, delta: number): string {
  const [yy, mm] = ym.split("-").map(Number);
  const d = new Date(yy, mm - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function formatTime(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export default function AttendanceCalendarView() {
  const [yearMonth, setYearMonth] = useState(thisMonthYm);
  const [data, setData] = useState<CalendarResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [monthPickerOpen, setMonthPickerOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/attendance/calendar?yearMonth=${yearMonth}`)
      .then(async (r) => {
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          throw new Error(j.error || `조회 실패 (${r.status})`);
        }
        return r.json();
      })
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e.message ?? e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [yearMonth]);

  // 셀별 집계 (날짜 → key → count)
  // key: "status_normal" / "ANNUAL" / "CORRECTION" 등
  const cellAggregates = useMemo(() => {
    const map = new Map<string, Record<string, number>>();
    if (!data) return map;

    // 1) attendance_requests 우선 — 다일 일정도 일별로 펼침
    for (const r of data.requests) {
      const code = r.categoryCode;
      if (!code) continue;
      const start = new Date(r.startDate + "T00:00:00Z");
      const end = new Date(r.endDate + "T00:00:00Z");
      const cursor = new Date(start);
      while (cursor <= end) {
        const ymd = cursor.toISOString().split("T")[0];
        const m = map.get(ymd) ?? {};
        m[code] = (m[code] ?? 0) + 1;
        map.set(ymd, m);
        cursor.setUTCDate(cursor.getUTCDate() + 1);
      }
    }

    // 2) attendance_daily의 autoStatus + 정정 표시
    for (const d of data.daily) {
      const ymd = d.workDate;
      const m = map.get(ymd) ?? {};

      // 카테고리가 위에서 카운트 안 됐고 출퇴근 상태가 있으면 카운트
      if (!d.categoryCode && d.autoStatus) {
        const key = `status_${d.autoStatus}`;
        m[key] = (m[key] ?? 0) + 1;
      }

      // 정정 마킹 (originalCheckIn/Out 중 하나라도 있으면)
      if (d.originalCheckIn || d.originalCheckOut) {
        m["CORRECTION"] = (m["CORRECTION"] ?? 0) + 1;
      }

      map.set(ymd, m);
    }
    return map;
  }, [data]);

  // 월 그리드 생성
  const grid = useMemo(() => {
    const [yy, mm] = yearMonth.split("-").map(Number);
    const firstDay = new Date(yy, mm - 1, 1);
    const lastDay = new Date(yy, mm, 0);
    const startDow = firstDay.getDay(); // 0=일
    const days: ({ day: number; ymd: string; dow: number } | null)[] = [];
    for (let i = 0; i < startDow; i++) days.push(null);
    for (let d = 1; d <= lastDay.getDate(); d++) {
      const ymd = `${yy}-${String(mm).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      days.push({ day: d, ymd, dow: new Date(yy, mm - 1, d).getDay() });
    }
    return days;
  }, [yearMonth]);

  const goPrev = () => setYearMonth(shiftMonth(yearMonth, -1));
  const goNext = () => setYearMonth(shiftMonth(yearMonth, 1));
  const goThisMonth = () => setYearMonth(thisMonthYm());

  // 월 CSV (wide format: 행=직원, 열=날짜)
  const downloadMonthCSV = () => {
    if (!data) return;
    const [yy, mm] = yearMonth.split("-").map(Number);
    const lastDay = new Date(yy, mm, 0).getDate();
    const dateCols = Array.from(
      { length: lastDay },
      (_, i) =>
        `${yy}-${String(mm).padStart(2, "0")}-${String(i + 1).padStart(2, "0")}`
    );

    const escape = (s: string) =>
      s.includes(",") || s.includes('"') || s.includes("\n")
        ? `"${s.replace(/"/g, '""')}"`
        : s;

    const headerCols = [
      "직원번호",
      "이름",
      "부서",
      "직급",
      ...dateCols,
    ].map(escape);
    const header = headerCols.join(",");

    const rows = data.employees.map((emp) => {
      const cells = dateCols.map((ymd) => {
        const d = data.daily.find(
          (x) => x.employeeId === emp.id && x.workDate === ymd
        );
        const req = data.requests.find(
          (r) =>
            r.employeeId === emp.id &&
            r.startDate <= ymd &&
            r.endDate >= ymd
        );

        // Phase 6-2K: 출퇴근 시간이 있으면 시간 + 카테고리 함께 (출장/외근도 시간 표시)
        if (d?.checkIn && d?.checkOut) {
          const inT = formatTime(d.checkIn);
          const outT = formatTime(d.checkOut);
          const mark = d.originalCheckIn || d.originalCheckOut ? "*" : "";
          if (req) return `${inT}-${outT}${mark} (${req.categoryName ?? ""})`;
          return `${inT}-${outT}${mark}`;
        }
        // 시간 없고 카테고리만 있으면 카테고리명
        if (req) return req.categoryName ?? "";
        if (d?.autoStatus === "absent") return "결근";
        if (d?.autoStatus === "working") return "근무중";
        return "";
      });

      const cols = [
        emp.employeeNo,
        emp.name,
        emp.department?.name ?? "",
        emp.position?.name ?? "",
        ...cells,
      ].map(escape);
      return cols.join(",");
    });

    const csv = "﻿" + [header, ...rows].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `근태_${yearMonth}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // 헤더용: "YYYY-MM" → "YYYY년 M월"
  const [hYearStr, hMonthStr] = yearMonth.split("-");
  const headerLabel = `${hYearStr}년 ${Number(hMonthStr)}월`;

  return (
    <div className="bg-white rounded-2xl border border-gray-100 p-4 sm:p-5 space-y-4">
      {/* Phase 6-2K: 헤더 — 모바일에서 2줄로 */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div className="flex items-center gap-2">
          <Calendar size={18} className="text-blue-600" />
          <h3 className="text-base sm:text-lg font-bold text-gray-900">
            근태 캘린더
          </h3>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={goPrev}
            className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-500"
            aria-label="이전 달"
          >
            <ChevronLeft size={16} />
          </button>
          {/* Phase 6-2K: 년월 클릭 시 MonthPicker (이번달 더블클릭 단축은 아래 별도 버튼) */}
          <button
            onClick={() => setMonthPickerOpen(true)}
            className="font-semibold text-sm sm:text-base px-3 py-1.5 hover:bg-gray-100 rounded-lg min-w-[110px] text-center text-gray-900"
            title="년월 선택"
          >
            {headerLabel}
          </button>
          <button
            onClick={goNext}
            className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-500"
            aria-label="다음 달"
          >
            <ChevronRight size={16} />
          </button>
          <button
            onClick={goThisMonth}
            className="text-xs text-blue-600 hover:text-blue-700 px-2 py-1 rounded hover:bg-blue-50"
            title="이번 달로 이동"
          >
            오늘
          </button>
          {/* Phase 6-2K: CSV 버튼 — RequestPage 패턴으로 통일 */}
          <button
            onClick={downloadMonthCSV}
            disabled={!data || loading}
            className="ml-2 inline-flex items-center gap-1.5 px-3 py-1.5 text-sm border border-gray-200 bg-white text-gray-700 rounded-xl hover:bg-gray-50 disabled:opacity-50"
          >
            <Download size={14} />
            CSV
          </button>
        </div>
      </div>

      {/* Phase 6-2K: 범례 — 글자 키움 + flex-wrap 강화 */}
      <div className="bg-gray-50 rounded-lg p-2 sm:p-3 text-xs sm:text-sm flex flex-wrap gap-x-3 gap-y-1.5 text-gray-700">
        {Object.entries(STATUS_ICONS).map(([k, v]) => (
          <span key={k} className="inline-flex items-center gap-0.5">
            <span>{v.icon}</span>
            <span>{v.label}</span>
          </span>
        ))}
        {Object.entries(CATEGORY_ICONS)
          .filter(([k]) => k !== "HALF_AM" && k !== "HALF_PM")
          .map(([k, v]) => (
            <span key={k} className="inline-flex items-center gap-0.5">
              {v.icon && <span>{v.icon}</span>}
              <span>{v.label}</span>
            </span>
          ))}
        <span className="inline-flex items-center gap-0.5">
          <span>{CORRECTION_ICON.icon}</span>
          <span>{CORRECTION_ICON.label}</span>
        </span>
      </div>

      {/* 캘린더 그리드 또는 로딩/에러 */}
      {loading ? (
        <div className="flex items-center justify-center h-64">
          <Loader2 className="animate-spin text-blue-500" size={28} />
          <span className="ml-2 text-sm text-gray-500">불러오는 중...</span>
        </div>
      ) : error ? (
        <div className="bg-rose-50 text-rose-700 px-4 py-3 rounded-xl text-sm">
          {error}
        </div>
      ) : (
        // Phase 6-2K: 셀 높이 + 글자 크기 키움
        <div className="grid grid-cols-7 gap-1 text-xs sm:text-sm">
          {["일", "월", "화", "수", "목", "금", "토"].map((d, i) => (
            <div
              key={d}
              className={`text-center font-semibold py-1 text-xs sm:text-sm ${
                i === 0
                  ? "text-rose-500"
                  : i === 6
                    ? "text-blue-500"
                    : "text-gray-600"
              }`}
            >
              {d}
            </div>
          ))}
          {grid.map((cell, i) => {
            if (!cell) {
              return (
                <div
                  key={`empty-${i}`}
                  className="bg-gray-50 rounded h-24 sm:h-28"
                />
              );
            }
            const counts = cellAggregates.get(cell.ymd) ?? {};
            const hasData = Object.keys(counts).length > 0;
            const entries = Object.entries(counts).slice(0, 4);
            return (
              <button
                key={cell.ymd}
                onClick={() => hasData && setSelectedDate(cell.ymd)}
                disabled={!hasData}
                className={`h-24 sm:h-28 p-1.5 rounded border text-left transition-colors ${
                  hasData
                    ? "bg-white border-gray-200 hover:border-blue-400 cursor-pointer"
                    : "bg-gray-50 border-transparent cursor-default"
                }`}
              >
                <div
                  className={`text-sm sm:text-base font-semibold ${
                    cell.dow === 0
                      ? "text-rose-500"
                      : cell.dow === 6
                        ? "text-blue-500"
                        : "text-gray-700"
                  }`}
                >
                  {cell.day}
                </div>
                <div className="mt-1 space-y-0.5 text-xs sm:text-sm text-gray-700">
                  {entries.map(([key, cnt]) => {
                    let icon = "";
                    let label = "";
                    if (key.startsWith("status_")) {
                      const s = key.replace(
                        "status_",
                        ""
                      ) as keyof typeof STATUS_ICONS;
                      const info = STATUS_ICONS[s];
                      if (!info) return null;
                      icon = info.icon;
                      label = String(cnt);
                    } else if (key === "CORRECTION") {
                      icon = CORRECTION_ICON.icon;
                      label = String(cnt);
                    } else {
                      const info = CATEGORY_ICONS[key];
                      if (!info) return null;
                      icon = info.icon || info.label;
                      label = String(cnt);
                    }
                    return (
                      <div key={key} className="truncate">
                        {icon} {label}
                      </div>
                    );
                  })}
                </div>
              </button>
            );
          })}
        </div>
      )}

      {/* 셀 클릭 팝업 */}
      {selectedDate && data && (
        <AttendanceCalendarDayModal
          date={selectedDate}
          employees={data.employees}
          daily={data.daily}
          requests={data.requests}
          onClose={() => setSelectedDate(null)}
        />
      )}

      {/* Phase 6-2K: 년월 선택 다이얼로그 */}
      {monthPickerOpen && (
        <MonthPicker
          value={yearMonth}
          onChange={(yM) => setYearMonth(yM)}
          onClose={() => setMonthPickerOpen(false)}
        />
      )}
    </div>
  );
}

"use client";

import { X, Download } from "lucide-react";

// 응답 row 타입 (AttendanceCalendarView와 공유)
export interface CalendarEmployee {
  id: number;
  employeeNo: string;
  name: string;
  department: { id: number; name: string } | null;
  position: { name: string } | null;
}

export interface CalendarDaily {
  id: number;
  employeeId: number;
  workDate: string;
  checkIn: string | null;
  checkOut: string | null;
  originalCheckIn: string | null;
  originalCheckOut: string | null;
  autoStatus: string | null;
  categoryId: number | null;
  categoryCode: string | null;
  categoryName: string | null;
  isOverridden: boolean;
  workMinutes: number | null;
  note: string | null;
}

export interface CalendarRequest {
  id: number;
  employeeId: number;
  startDate: string;
  endDate: string;
  correctedCheckIn: string | null;
  correctedCheckOut: string | null;
  categoryCode: string | null;
  categoryName: string | null;
  reason: string | null;
}

interface ModalProps {
  date: string; // "YYYY-MM-DD"
  employees: CalendarEmployee[];
  daily: CalendarDaily[];
  requests: CalendarRequest[];
  onClose: () => void;
}

function formatTime(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function autoStatusLabel(s: string | null): string {
  switch (s) {
    case "normal":
      return "정상";
    case "late":
      return "지각";
    case "early_leave":
      return "조퇴";
    case "absent":
      return "결근";
    case "working":
      return "근무중";
    default:
      return "-";
  }
}

function autoStatusColor(s: string | null): string {
  switch (s) {
    case "normal":
      return "text-emerald-600";
    case "late":
      return "text-amber-600";
    case "early_leave":
      return "text-orange-600";
    case "absent":
      return "text-rose-600";
    case "working":
      return "text-emerald-600";
    default:
      return "text-gray-400";
  }
}

export default function AttendanceCalendarDayModal({
  date,
  employees,
  daily,
  requests,
  onClose,
}: ModalProps) {
  // 해당 날짜 직원별 데이터 추출
  const dayData = employees.map((emp) => {
    const d = daily.find(
      (x) => x.employeeId === emp.id && x.workDate === date
    );
    const req = requests.find(
      (r) =>
        r.employeeId === emp.id && r.startDate <= date && r.endDate >= date
    );
    return { emp, d, req };
  });

  const downloadDayCSV = () => {
    const header = [
      "직원번호",
      "이름",
      "부서",
      "출근(원본)",
      "출근(정정후)",
      "퇴근(원본)",
      "퇴근(정정후)",
      "상태/카테고리",
      "비고",
    ].join(",");
    const rows = dayData.map(({ emp, d, req }) => {
      let inOrig = "";
      let inFinal = "";
      let outOrig = "";
      let outFinal = "";
      let statusCell = "";
      let note = "";

      if (req) {
        statusCell = req.categoryName ?? "";
        note = req.reason ?? "";
      } else if (d) {
        inFinal = formatTime(d.checkIn);
        outFinal = formatTime(d.checkOut);
        if (d.originalCheckIn) inOrig = formatTime(d.originalCheckIn);
        if (d.originalCheckOut) outOrig = formatTime(d.originalCheckOut);
        statusCell = autoStatusLabel(d.autoStatus);
        if (d.originalCheckIn || d.originalCheckOut) statusCell += " (정정)";
        note = d.note ?? "";
      }

      const escape = (s: string) =>
        s.includes(",") || s.includes('"') || s.includes("\n")
          ? `"${s.replace(/"/g, '""')}"`
          : s;

      return [
        emp.employeeNo,
        emp.name,
        emp.department?.name ?? "",
        inOrig,
        inFinal,
        outOrig,
        outFinal,
        statusCell,
        note,
      ]
        .map(escape)
        .join(",");
    });

    const csv = "﻿" + [header, ...rows].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `근태_${date}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div
      className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl max-w-4xl w-full max-h-[85vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 bg-white border-b border-gray-100 px-5 py-3 flex items-center justify-between z-10">
          <h3 className="font-bold text-gray-900">{date} · 직원별 상세</h3>
          <button
            onClick={onClose}
            className="p-1 hover:bg-gray-100 rounded"
            aria-label="닫기"
          >
            <X size={18} />
          </button>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs">
              <tr>
                <th className="px-3 py-2 text-left">직원</th>
                <th className="px-3 py-2 text-left">부서</th>
                <th className="px-3 py-2 text-left">출근</th>
                <th className="px-3 py-2 text-left">퇴근</th>
                <th className="px-3 py-2 text-left">상태/카테고리</th>
                <th className="px-3 py-2 text-left">비고</th>
              </tr>
            </thead>
            <tbody>
              {dayData.map(({ emp, d, req }) => (
                <tr
                  key={emp.id}
                  className="border-t border-gray-50 hover:bg-blue-50/30"
                >
                  <td className="px-3 py-2 font-medium text-gray-900">
                    {emp.name}
                    <span className="ml-1 text-xs text-gray-400 font-mono">
                      {emp.employeeNo}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-gray-600">
                    {emp.department?.name ?? "-"}
                  </td>
                  <td className="px-3 py-2 font-mono">
                    {req ? (
                      "-"
                    ) : d?.originalCheckIn ? (
                      <>
                        <span className="line-through text-gray-400 mr-1">
                          {formatTime(d.originalCheckIn)}
                        </span>
                        <span className="text-cyan-600 font-semibold">
                          {formatTime(d.checkIn)}
                        </span>
                      </>
                    ) : (
                      formatTime(d?.checkIn ?? null) || "-"
                    )}
                  </td>
                  <td className="px-3 py-2 font-mono">
                    {req ? (
                      "-"
                    ) : d?.originalCheckOut ? (
                      <>
                        <span className="line-through text-gray-400 mr-1">
                          {formatTime(d.originalCheckOut)}
                        </span>
                        <span className="text-cyan-600 font-semibold">
                          {formatTime(d.checkOut)}
                        </span>
                      </>
                    ) : (
                      formatTime(d?.checkOut ?? null) || "-"
                    )}
                  </td>
                  <td className="px-3 py-2">
                    {req ? (
                      <span className="text-purple-600 font-medium">
                        {req.categoryName}
                      </span>
                    ) : (
                      <span className={autoStatusColor(d?.autoStatus ?? null)}>
                        {autoStatusLabel(d?.autoStatus ?? null)}
                        {(d?.originalCheckIn || d?.originalCheckOut) && (
                          <span className="ml-1 text-xs bg-cyan-100 text-cyan-700 px-1.5 py-0.5 rounded-full font-medium">
                            정정
                          </span>
                        )}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs text-gray-500 max-w-xs truncate">
                    {req?.reason ?? d?.note ?? ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="sticky bottom-0 bg-white border-t border-gray-100 px-5 py-3 flex justify-end">
          <button
            onClick={downloadDayCSV}
            className="flex items-center gap-1 px-3 py-1.5 text-xs bg-blue-50 text-blue-700 rounded hover:bg-blue-100"
          >
            <Download size={12} />
            이 날짜 CSV
          </button>
        </div>
      </div>
    </div>
  );
}

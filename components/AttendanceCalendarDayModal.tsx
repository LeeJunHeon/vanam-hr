"use client";

import { useState } from "react";
import { X, Download } from "lucide-react";
import { correctedRangeLabel } from "@/lib/attendanceLabels";
import { todayYmd } from "@/lib/dateUtils";

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
  statusReason?: string | null;
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
  holidayName?: string | null; // Phase 6-2L+ B-4: 공휴일이면 이름
  editableEmployeeId?: number; // 이 직원 행이면 본인 사유 입력 가능 (내 근태에서 전달)
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
      return "text-blue-600";
    default:
      return "text-gray-400";
  }
}

// Phase 6-2K: 한국어 날짜 라벨 ("2026년 6월 1일 (월)")
function formatDateKorean(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  const dow = ["일", "월", "화", "수", "목", "금", "토"][dt.getDay()];
  return `${y}년 ${m}월 ${d}일 (${dow})`;
}

// Phase 6-2K: 🔵 근무중 포함 상태 배지
function StatusBadge({
  autoStatus,
  checkIn,
  checkOut,
  isToday,
}: {
  autoStatus: string | null | undefined;
  checkIn: string | null;
  checkOut: string | null;
  isToday: boolean;
}) {
  // 출근O·퇴근X — 오늘이면 근무중, 과거면 미퇴근 (30일 모달과 동일 규칙)
  if (checkIn && !checkOut) {
    return isToday ? (
      <span className="text-xs font-medium text-blue-600">🔵 근무중</span>
    ) : (
      <span className="text-xs font-medium text-amber-600">🟠 미퇴근</span>
    );
  }
  const map: Record<string, { label: string; cls: string }> = {
    working: { label: "🔵 근무중", cls: "text-blue-600" },
    normal: { label: "🟢 정상", cls: "text-emerald-600" },
    late: { label: "🟡 지각", cls: "text-amber-600" },
    early_leave: { label: "🟠 조퇴", cls: "text-orange-600" },
    absent: { label: "🔴 결근", cls: "text-rose-600" },
  };
  const k = autoStatus ?? "";
  if (!k || !map[k]) return <span className="text-gray-400">-</span>;
  return (
    <span className={`${map[k].cls} font-medium`}>{map[k].label}</span>
  );
}

// 근태정정이면 "근태정정:", 그 외(외근/출장 등 시간 일정)면 "캘린더:"
function calendarTimeNote(req: CalendarRequest | undefined): string | null {
  if (!req || !req.correctedCheckIn || !req.correctedCheckOut) return null;
  const label = correctedRangeLabel(req.categoryCode, req.categoryName);
  return `${label}: ${formatTime(req.correctedCheckIn)}-${formatTime(req.correctedCheckOut)}`;
}

export default function AttendanceCalendarDayModal({
  date,
  employees,
  daily,
  requests,
  holidayName,
  editableEmployeeId,
  onClose,
}: ModalProps) {
  const [reasonEdits, setReasonEdits] = useState<Record<number, string>>({});
  const [savingId, setSavingId] = useState<number | null>(null);
  const [savedToast, setSavedToast] = useState("");
  // 저장 후 즉시 반영용 로컬 사유 오버라이드 (dailyId → reason)
  const [localReasons, setLocalReasons] = useState<Record<number, string | null>>({});

  // 사유 저장 함수
  const saveReason = async (dailyId: number, value: string) => {
    setSavingId(dailyId);
    try {
      const res = await fetch(`/api/attendance-daily/${dailyId}/reason`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: value }),
      });
      if (res.ok) {
        setLocalReasons((p) => ({ ...p, [dailyId]: value.trim() || null }));
        setSavedToast("사유가 저장되었습니다.");
        setTimeout(() => setSavedToast(""), 2000);
      } else {
        const err = await res.json().catch(() => ({}));
        setSavedToast(err.error ?? "저장 실패");
        setTimeout(() => setSavedToast(""), 2500);
      }
    } catch {
      setSavedToast("네트워크 오류");
      setTimeout(() => setSavedToast(""), 2500);
    } finally {
      setSavingId(null);
    }
  };

  // 지각/조퇴 사유 영역 렌더 (데스크탑/모바일 공용)
  const renderReason = (d: CalendarDaily | undefined, empId: number) => {
    const isLateOrEarly =
      d?.autoStatus === "late" || d?.autoStatus === "early_leave";
    if (!isLateOrEarly || d == null) return null;
    const canEdit = editableEmployeeId != null && empId === editableEmployeeId;
    const currentReason =
      d.id in localReasons ? localReasons[d.id] ?? "" : d.statusReason ?? "";
    const label = d.autoStatus === "late" ? "지각" : "조퇴";

    if (canEdit) {
      return (
        <div className="mt-1.5">
          <label className="block text-[11px] font-medium text-gray-500 mb-0.5">
            {label} 사유
          </label>
          <div className="flex items-center gap-1.5">
            <input
              type="text"
              defaultValue={currentReason}
              onChange={(e) =>
                setReasonEdits((p) => ({ ...p, [d.id]: e.target.value }))
              }
              placeholder="사유를 입력하세요 (예: 병원 방문)"
              className="flex-1 border border-gray-200 rounded-lg px-2.5 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-blue-200"
            />
            <button
              onClick={() => saveReason(d.id, reasonEdits[d.id] ?? currentReason)}
              disabled={savingId === d.id}
              className="px-2.5 py-1.5 text-xs font-semibold text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50 shrink-0"
            >
              {savingId === d.id ? "저장중" : "저장"}
            </button>
          </div>
        </div>
      );
    }
    // 타인(관리자 조회) — 표시만
    return currentReason ? (
      <div className="mt-1.5 text-xs text-gray-600">
        <span className="font-medium text-gray-500">{label} 사유:</span>{" "}
        {currentReason}
      </div>
    ) : (
      <div className="mt-1.5 text-xs text-gray-400">{label} 사유 미작성</div>
    );
  };

  // 모달 대상 날짜가 오늘(KST)인지 — 미퇴근/근무중 판정용
  const isToday = date === todayYmd();

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
    // Phase 6-2K: 출장/외근도 출퇴근 시간 함께 표시. 비고에 캘린더 시간 포함.
    const header = [
      "직원번호",
      "이름",
      "부서",
      "출근",
      "퇴근",
      "상태/카테고리",
      "비고",
    ].join(",");
    const rows = dayData.map(({ emp, d, req }) => {
      let inCell = "";
      let outCell = "";

      // 시간 — 카테고리 유무와 무관하게 attendance_daily에 시간이 있으면 표시
      if (d?.checkIn) {
        inCell = d.originalCheckIn
          ? `(${formatTime(d.originalCheckIn)}→)${formatTime(d.checkIn)}`
          : formatTime(d.checkIn);
      }
      if (d?.checkOut) {
        outCell = d.originalCheckOut
          ? `(${formatTime(d.originalCheckOut)}→)${formatTime(d.checkOut)}`
          : formatTime(d.checkOut);
      }

      // 상태/카테고리 — 카테고리 우선, 없으면 autoStatus
      let statusCell = "";
      if (req) {
        statusCell = req.categoryName ?? "";
      } else if (d?.checkIn && !d?.checkOut) {
        statusCell = isToday ? "근무중" : "미퇴근";
      } else if (d?.autoStatus) {
        statusCell = autoStatusLabel(d.autoStatus);
      }
      if (d?.originalCheckIn || d?.originalCheckOut) statusCell += " (정정)";

      // 비고 — 캘린더 시간 + 사유 + note
      const noteParts: string[] = [];
      const calNote = calendarTimeNote(req);
      if (calNote) noteParts.push(calNote);
      if (req?.reason) noteParts.push(req.reason);
      if (!req && d?.note) noteParts.push(d.note);
      const note = noteParts.join(" · ");

      const escape = (s: string) =>
        s.includes(",") || s.includes('"') || s.includes("\n")
          ? `"${s.replace(/"/g, '""')}"`
          : s;

      return [
        emp.employeeNo,
        emp.name,
        emp.department?.name ?? "",
        inCell,
        outCell,
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
      {savedToast && (
        <div className="fixed bottom-6 right-6 z-[60] bg-gray-900 text-white text-sm font-medium px-5 py-3 rounded-xl shadow-lg">
          {savedToast}
        </div>
      )}
      <div
        className="bg-white rounded-2xl max-w-4xl w-full max-h-[85vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 bg-white border-b border-gray-100 px-4 sm:px-5 py-3 flex items-center justify-between z-10">
          {/* Phase 6-2K: 한국어 날짜 헤더 ("2026년 6월 1일 (월)") */}
          <h3 className="font-bold text-gray-900 text-base flex items-center gap-2">
            {formatDateKorean(date)}
            {/* Phase 6-2L+ B-4: 공휴일 라벨 (있을 때만) */}
            {holidayName && (
              <span className="text-xs font-semibold bg-rose-100 text-rose-700 px-2 py-0.5 rounded-full">
                🎌 {holidayName}
              </span>
            )}
          </h3>
          <button
            onClick={onClose}
            className="p-1 hover:bg-gray-100 rounded"
            aria-label="닫기"
          >
            <X size={18} />
          </button>
        </div>

        {/* Phase 6-2K: 데스크탑 테이블 (sm 이상) */}
        <div className="hidden sm:block overflow-x-auto">
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
              {dayData.map(({ emp, d, req }) => {
                const calNote = calendarTimeNote(req);
                return (
                  <tr
                    key={emp.id}
                    className="border-t border-gray-50 hover:bg-blue-50/30"
                  >
                    <td className="px-3 py-2.5 font-medium text-gray-900">
                      {emp.name}
                      <span className="ml-1 text-xs text-gray-400 font-mono">
                        {emp.employeeNo}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-gray-600">
                      {emp.department?.name ?? "-"}
                    </td>
                    {/* Phase 6-2K: 출장/외근도 시간 표시 */}
                    <td className="px-3 py-2.5 font-mono">
                      {d?.originalCheckIn ? (
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
                    <td className="px-3 py-2.5 font-mono">
                      {d?.originalCheckOut ? (
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
                    <td className="px-3 py-2.5">
                      {req ? (
                        <span className="text-purple-600 font-medium">
                          {req.categoryName}
                        </span>
                      ) : (
                        <StatusBadge autoStatus={d?.autoStatus ?? null} checkIn={d?.checkIn ?? null} checkOut={d?.checkOut ?? null} isToday={isToday} />
                      )}
                      {(d?.originalCheckIn || d?.originalCheckOut) && (
                        <span className="ml-1 text-xs bg-cyan-100 text-cyan-700 px-1.5 py-0.5 rounded-full font-medium">
                          정정
                        </span>
                      )}
                    </td>
                    {/* Phase 6-2K: 비고에 캘린더 시간 포함 */}
                    <td className="px-3 py-2.5 text-xs text-gray-500 max-w-xs">
                      {calNote && (
                        <span className="text-amber-600">{calNote}</span>
                      )}
                      {calNote && (req?.reason || d?.note) && " · "}
                      <span>{req?.reason ?? d?.note ?? ""}</span>
                      {renderReason(d, emp.id)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Phase 6-2K: 모바일 카드 리스트 (sm 미만) */}
        <div className="sm:hidden space-y-2 p-3">
          {dayData.map(({ emp, d, req }) => {
            const calNote = calendarTimeNote(req);
            const hasTimes = d?.checkIn || d?.checkOut;
            return (
              <div
                key={emp.id}
                className="bg-gray-50 rounded-lg p-3 space-y-1.5"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-semibold text-gray-900 text-sm truncate">
                      {emp.name}
                    </p>
                    <p className="text-xs text-gray-500">
                      {emp.department?.name ?? "-"}
                    </p>
                  </div>
                  <div className="shrink-0">
                    {req ? (
                      <span className="text-xs bg-purple-100 text-purple-700 px-2 py-0.5 rounded-full font-medium">
                        {req.categoryName}
                      </span>
                    ) : (
                      <StatusBadge autoStatus={d?.autoStatus ?? null} checkIn={d?.checkIn ?? null} checkOut={d?.checkOut ?? null} isToday={isToday} />
                    )}
                  </div>
                </div>

                {hasTimes && (
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs font-mono">
                    <span>
                      출근:{" "}
                      {d?.originalCheckIn ? (
                        <>
                          <span className="line-through text-gray-400">
                            {formatTime(d.originalCheckIn)}
                          </span>{" "}
                          <span className="text-cyan-600">
                            {formatTime(d.checkIn)}
                          </span>
                        </>
                      ) : (
                        formatTime(d?.checkIn ?? null) || "-"
                      )}
                    </span>
                    <span>
                      퇴근:{" "}
                      {d?.originalCheckOut ? (
                        <>
                          <span className="line-through text-gray-400">
                            {formatTime(d.originalCheckOut)}
                          </span>{" "}
                          <span className="text-cyan-600">
                            {formatTime(d.checkOut)}
                          </span>
                        </>
                      ) : (
                        formatTime(d?.checkOut ?? null) || "-"
                      )}
                    </span>
                  </div>
                )}

                {calNote && (
                  <p className="text-xs text-amber-600">{calNote}</p>
                )}
                {(req?.reason || d?.note) && (
                  <p className="text-xs text-gray-500">
                    {req?.reason ?? d?.note}
                  </p>
                )}
                {renderReason(d, emp.id)}
              </div>
            );
          })}
        </div>

        <div className="sticky bottom-0 bg-white border-t border-gray-100 px-4 sm:px-5 py-3 flex justify-end">
          {/* Phase 6-2K: CSV 버튼 RequestPage 패턴으로 통일 */}
          <button
            onClick={downloadDayCSV}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm border border-gray-200 bg-white text-gray-700 rounded-xl hover:bg-gray-50"
          >
            <Download size={14} />
            CSV
          </button>
        </div>
      </div>
    </div>
  );
}

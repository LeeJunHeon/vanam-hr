"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import { X, CheckCircle, AlertCircle, XCircle, Loader2 } from "lucide-react";
import { todayYmd, ymdFromDate } from "@/lib/dateUtils";

// 직원 카드 클릭 시 열리는 최근 30일 출퇴근 상세 모달.
// /api/attendance/overview?employeeId=X&startDate=30일전&endDate=오늘 를 호출한다.
// (overview API는 이미 employeeId 필터 + 권한 체크를 지원하므로 호출만 다르게 함)

interface EmployeeAttendanceDetailModalProps {
  employeeId: number;
  employeeName: string;
  departmentName: string | null;
  positionName: string | null;
  onClose: () => void;
}

// overview API 응답의 row 형태 (autoStatus 기반)
interface DetailRow {
  employeeId: number;
  employeeNo: string;
  name: string;
  departmentName: string | null;
  positionName: string | null;
  workDate: string;
  checkIn: string | null;
  checkOut: string | null;
  workMinutes: number | null;
  autoStatus: string | null;
  isOverridden: boolean;
}

// HH:MM (없으면 '-')
function formatTime(iso: string | null): string {
  if (!iso) return "-";
  const d = new Date(iso);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

// 근무시간 (분 → "N시간 M분")
function formatWorkMinutes(min: number | null): string {
  if (min === null || min === undefined) return "-";
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h === 0) return `${m}분`;
  if (m === 0) return `${h}시간`;
  return `${h}시간 ${m}분`;
}

// YYYY-MM-DD → "MM-DD (요일)"
const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];
function formatDateLabel(ymd: string): string {
  const d = new Date(`${ymd}T00:00:00`);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const w = WEEKDAYS[d.getDay()];
  return `${mm}-${dd} (${w})`;
}

// 진행 컬럼 (autoStatus 기준): 근무중 / 완료 / 미출근
function renderProgress(autoStatus: string | null) {
  if (autoStatus === "working") {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700">
        <span className="w-2 h-2 rounded-full bg-emerald-500" />
        근무중
      </span>
    );
  }
  if (
    autoStatus === "normal" ||
    autoStatus === "late" ||
    autoStatus === "early_leave"
  ) {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium text-blue-700">
        <span className="w-2 h-2 rounded-full bg-blue-500" />
        완료
      </span>
    );
  }
  // absent 또는 데이터 없음
  return (
    <span className="inline-flex items-center gap-1 text-xs font-medium text-gray-500">
      <span className="w-2 h-2 rounded-full bg-gray-400" />
      미출근
    </span>
  );
}

// 평가 컬럼 (autoStatus 기준): 정상/지각/조퇴/결근/보류
function renderEval(autoStatus: string | null) {
  const config: Record<string, { label: string; cls: string }> = {
    normal: { label: "정상", cls: "text-emerald-600" },
    late: { label: "지각", cls: "text-amber-600" },
    early_leave: { label: "조퇴", cls: "text-orange-600" },
    absent: { label: "결근", cls: "text-rose-600" },
  };
  // working 또는 null → 평가 보류
  const c = autoStatus ? config[autoStatus] : undefined;
  if (!c) {
    return <span className="text-xs text-gray-400">–</span>;
  }
  return <span className={`text-xs font-medium ${c.cls}`}>{c.label}</span>;
}

export default function EmployeeAttendanceDetailModal({
  employeeId,
  employeeName,
  departmentName,
  positionName,
  onClose,
}: EmployeeAttendanceDetailModalProps) {
  const [rows, setRows] = useState<DetailRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // 최근 30일 범위 (오늘 포함 30일)
  const { startDate, endDate } = useMemo(() => {
    const end = todayYmd();
    const past = new Date();
    past.setDate(past.getDate() - 29);
    return { startDate: ymdFromDate(past), endDate: end };
  }, []);

  // 데이터 fetch
  const fetchDetail = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({
        employeeId: String(employeeId),
        startDate,
        endDate,
      });
      const res = await fetch(`/api/attendance/overview?${params}`);
      if (!res.ok) {
        const j = await res.json().catch(() => null);
        setError(j?.error || `조회 실패 (${res.status})`);
        setRows([]);
        return;
      }
      const data = await res.json();
      setRows(data.rows ?? []);
    } catch (e) {
      console.error("modal detail fetch error:", e);
      setError("네트워크 오류");
    } finally {
      setLoading(false);
    }
  }, [employeeId, startDate, endDate]);

  useEffect(() => {
    fetchDetail();
  }, [fetchDetail]);

  // ESC 키로 닫기
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  // 통계 (autoStatus 기준 집계)
  const stats = useMemo(() => {
    return rows.reduce(
      (acc, r) => {
        if (r.checkIn) acc.attended += 1;
        if (r.autoStatus === "normal") acc.normal += 1;
        else if (r.autoStatus === "late") acc.late += 1;
        else if (r.autoStatus === "absent") acc.absent += 1;
        return acc;
      },
      { attended: 0, normal: 0, late: 0, absent: 0 }
    );
  }, [rows]);

  // 최신 날짜가 위로
  const sortedRows = useMemo(
    () => [...rows].sort((a, b) => b.workDate.localeCompare(a.workDate)),
    [rows]
  );

  return (
    <div
      className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl shadow-xl max-w-3xl w-full max-h-[85vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 헤더 */}
        <div className="sticky top-0 bg-white border-b border-gray-100 px-5 py-4 flex items-start justify-between z-10">
          <div className="min-w-0">
            <h2 className="text-lg font-bold text-gray-900 truncate">
              {employeeName}
            </h2>
            <p className="text-xs text-gray-500 mt-0.5">
              {departmentName ?? "(부서 없음)"}
              {positionName ? ` · ${positionName}` : ""}
              <span className="text-gray-300"> · 최근 30일</span>
            </p>
          </div>
          <button
            onClick={onClose}
            className="shrink-0 ml-3 p-1.5 rounded-lg text-gray-400 hover:bg-gray-100 hover:text-gray-600"
            aria-label="닫기"
          >
            <X size={18} />
          </button>
        </div>

        {/* 본문 */}
        <div className="p-5 space-y-4">
          {loading ? (
            <div className="flex items-center justify-center h-40">
              <Loader2 size={22} className="animate-spin text-blue-500" />
              <span className="ml-2 text-sm text-gray-500">불러오는 중...</span>
            </div>
          ) : error ? (
            <div className="px-4 py-4 text-sm text-rose-600 bg-rose-50 rounded-xl">
              {error}
            </div>
          ) : (
            <>
              {/* 통계 카드 4개 */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 sm:gap-3">
                <div className="bg-gray-50 rounded-xl p-3">
                  <p className="text-xs font-semibold text-gray-500">출근일수</p>
                  <p className="mt-1 text-xl font-bold text-gray-900 font-mono">
                    {stats.attended}
                  </p>
                </div>
                <div className="bg-emerald-50 rounded-xl p-3">
                  <div className="flex items-center gap-1">
                    <CheckCircle size={13} className="text-emerald-600" />
                    <p className="text-xs font-semibold text-emerald-700">정상</p>
                  </div>
                  <p className="mt-1 text-xl font-bold text-emerald-700 font-mono">
                    {stats.normal}
                  </p>
                </div>
                <div className="bg-amber-50 rounded-xl p-3">
                  <div className="flex items-center gap-1">
                    <AlertCircle size={13} className="text-amber-600" />
                    <p className="text-xs font-semibold text-amber-700">지각</p>
                  </div>
                  <p className="mt-1 text-xl font-bold text-amber-700 font-mono">
                    {stats.late}
                  </p>
                </div>
                <div className="bg-rose-50 rounded-xl p-3">
                  <div className="flex items-center gap-1">
                    <XCircle size={13} className="text-rose-600" />
                    <p className="text-xs font-semibold text-rose-700">결근</p>
                  </div>
                  <p className="mt-1 text-xl font-bold text-rose-700 font-mono">
                    {stats.absent}
                  </p>
                </div>
              </div>

              {sortedRows.length === 0 ? (
                <div className="px-4 py-10 text-center text-sm text-gray-400">
                  최근 30일 출퇴근 기록이 없습니다
                </div>
              ) : (
                <>
                  {/* 데스크탑 표 */}
                  <div className="hidden md:block overflow-x-auto border border-gray-100 rounded-xl">
                    <table className="w-full">
                      <thead>
                        <tr className="bg-gray-50 border-b border-gray-100">
                          <th className="text-left text-xs font-semibold text-gray-500 px-4 py-2.5">
                            날짜
                          </th>
                          <th className="text-left text-xs font-semibold text-gray-500 px-4 py-2.5">
                            출근
                          </th>
                          <th className="text-left text-xs font-semibold text-gray-500 px-4 py-2.5">
                            퇴근
                          </th>
                          <th className="text-right text-xs font-semibold text-gray-500 px-4 py-2.5">
                            근무
                          </th>
                          <th className="text-center text-xs font-semibold text-gray-500 px-4 py-2.5">
                            진행
                          </th>
                          <th className="text-center text-xs font-semibold text-gray-500 px-4 py-2.5">
                            평가
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {sortedRows.map((r) => (
                          <tr
                            key={r.workDate}
                            className="border-b border-gray-50 last:border-0 hover:bg-blue-50/30"
                          >
                            <td className="px-4 py-2.5 text-sm text-gray-700 font-mono">
                              {formatDateLabel(r.workDate)}
                            </td>
                            <td className="px-4 py-2.5 text-sm text-gray-900 font-mono">
                              {formatTime(r.checkIn)}
                            </td>
                            <td className="px-4 py-2.5 text-sm text-gray-900 font-mono">
                              {formatTime(r.checkOut)}
                            </td>
                            <td className="px-4 py-2.5 text-sm text-gray-900 font-mono text-right">
                              {formatWorkMinutes(r.workMinutes)}
                            </td>
                            <td className="px-4 py-2.5 text-center">
                              {renderProgress(r.autoStatus)}
                            </td>
                            <td className="px-4 py-2.5 text-center">
                              {renderEval(r.autoStatus)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  {/* 모바일 카드 */}
                  <div className="md:hidden divide-y divide-gray-50 border border-gray-100 rounded-xl overflow-hidden">
                    {sortedRows.map((r) => (
                      <div key={r.workDate} className="px-4 py-3 space-y-1.5">
                        <div className="flex items-center justify-between">
                          <span className="text-sm font-semibold text-gray-900 font-mono">
                            {formatDateLabel(r.workDate)}
                          </span>
                          <div className="flex items-center gap-2">
                            {renderProgress(r.autoStatus)}
                            {renderEval(r.autoStatus)}
                          </div>
                        </div>
                        <div className="flex items-center justify-between text-xs">
                          <span className="text-gray-900 font-mono">
                            {formatTime(r.checkIn)} ~ {formatTime(r.checkOut)}
                          </span>
                          <span className="text-gray-700 font-mono font-semibold">
                            {formatWorkMinutes(r.workMinutes)}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import {
  X,
  CheckCircle,
  AlertCircle,
  XCircle,
  Loader2,
  Briefcase,
} from "lucide-react";
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

// overview API 응답의 row 형태 (Phase 6-2B 카테고리 보정 필드 포함)
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
  categoryId: number | null;
  categoryCode: string | null;
  categoryName: string | null;
  categoryColor: string | null;
  reason: string | null;
  // 외근/출장 등 시간대 일정의 시간대(예 09:00~12:00) — 출퇴근 시각과 별개로 노출.
  // 시간대 없는 종일 일정은 둘 다 null.
  correctedCheckIn: string | null;
  correctedCheckOut: string | null;
}

// 휴가성(vacation) 카테고리 여부
function isVacationCategory(code: string | null): boolean {
  if (!code) return false;
  return ["ANNUAL", "HALF_AM", "HALF_PM", "SICK", "FAMILY_EVENT"].includes(code);
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

// 진행 컬럼. Phase 6-2B 캘린더 보정 우선 (Q-A): 카테고리 라벨 표시.
function renderProgress(row: DetailRow) {
  // 캘린더 보정 우선
  if (row.isOverridden && row.categoryId && row.categoryName) {
    const label = isVacationCategory(row.categoryCode)
      ? row.categoryName // "연차"
      : row.checkOut
        ? `${row.categoryName}완료` // "외근완료"
        : `${row.categoryName}중`; // "외근중"
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium text-purple-700">
        <span
          className="w-2 h-2 rounded-full"
          style={{ backgroundColor: row.categoryColor ?? "#a855f7" }}
        />
        {label}
      </span>
    );
  }
  if (row.autoStatus === "working") {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700">
        <span className="w-2 h-2 rounded-full bg-emerald-500" />
        근무중
      </span>
    );
  }
  if (
    row.autoStatus === "normal" ||
    row.autoStatus === "late" ||
    row.autoStatus === "early_leave"
  ) {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium text-blue-700">
        <span className="w-2 h-2 rounded-full bg-blue-500" />
        완료
      </span>
    );
  }
  // autoStatus가 NULL이지만 check_in+check_out 있으면 옛날 데이터 → '완료'
  if (row.checkIn && row.checkOut) {
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

// 평가 컬럼. Phase 6-2B: 캘린더 보정 시 카테고리명 표시 (Q5c).
function renderEval(row: DetailRow) {
  const config: Record<string, { label: string; cls: string }> = {
    normal: { label: "정상", cls: "text-emerald-600" },
    late: { label: "지각", cls: "text-amber-600" },
    early_leave: { label: "조퇴", cls: "text-orange-600" },
    absent: { label: "결근", cls: "text-rose-600" },
  };
  const c = row.autoStatus ? config[row.autoStatus] : undefined;
  if (c) {
    return <span className={`text-xs font-medium ${c.cls}`}>{c.label}</span>;
  }
  // autoStatus NULL이지만 check_in+check_out 있으면 '정상' 추정 (옛날 데이터 보호)
  if (row.checkIn && row.checkOut) {
    return <span className="text-xs font-medium text-emerald-600">정상</span>;
  }
  return <span className="text-xs text-gray-400">–</span>;
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

  // 통계 (autoStatus + 카테고리 보정 기준 집계)
  const stats = useMemo(() => {
    return rows.reduce(
      (acc, r) => {
        if (r.checkIn) acc.attended += 1;
        if (r.autoStatus === "normal") acc.normal += 1;
        else if (r.autoStatus === "late") acc.late += 1;
        else if (r.autoStatus === "absent") acc.absent += 1;
        // Phase 6-2B: 캘린더 보정 카운트
        if (r.isOverridden && r.categoryId) acc.category += 1;
        return acc;
      },
      { attended: 0, normal: 0, late: 0, absent: 0, category: 0 }
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
              {/* 통계 카드 5개 (Phase 6-2B: 외근/휴가 신규) */}
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 sm:gap-3">
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
                <div className="bg-purple-50 rounded-xl p-3">
                  <div className="flex items-center gap-1">
                    <Briefcase size={13} className="text-purple-600" />
                    <p className="text-xs font-semibold text-purple-700">
                      외근/휴가
                    </p>
                  </div>
                  <p className="mt-1 text-xl font-bold text-purple-700 font-mono">
                    {stats.category}
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
                          <th className="text-left text-xs font-semibold text-gray-500 px-4 py-2.5">
                            사유
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
                              {renderProgress(r)}
                            </td>
                            <td className="px-4 py-2.5 text-center">
                              {renderEval(r)}
                            </td>
                            <td
                              className="px-4 py-2.5 text-sm text-gray-600 max-w-xs"
                              title={r.reason ?? ""}
                            >
                              {/* 외근/출장 등 시간대 일정 — 출퇴근 시각과 별개로 일정 시간대 표시 */}
                              {r.isOverridden &&
                                r.correctedCheckIn &&
                                r.correctedCheckOut && (
                                  <div className="text-[11px] text-purple-700 font-mono">
                                    {(r.categoryName ?? "외근")}{" "}
                                    {formatTime(r.correctedCheckIn)}~
                                    {formatTime(r.correctedCheckOut)}
                                  </div>
                                )}
                              <div className="truncate">
                                {r.reason || (
                                  <span className="text-gray-300">-</span>
                                )}
                              </div>
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
                            {renderProgress(r)}
                            {renderEval(r)}
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
                        {/* 외근/출장 등 시간대 일정 — 출퇴근 시각과 별개로 일정 시간대 표시 */}
                        {r.isOverridden &&
                          r.correctedCheckIn &&
                          r.correctedCheckOut && (
                            <div className="text-[11px] text-purple-700 font-mono">
                              {(r.categoryName ?? "외근")}{" "}
                              {formatTime(r.correctedCheckIn)}~
                              {formatTime(r.correctedCheckOut)}
                            </div>
                          )}
                        {r.reason && (
                          <div className="text-xs text-gray-600 truncate">
                            사유: {r.reason}
                          </div>
                        )}
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

"use client";

import { useEffect, useMemo, useState } from "react";
import { X, Loader2, Calendar } from "lucide-react";
import MonthPicker from "@/components/MonthPicker";
import { downloadFile } from "@/lib/download";

// 근태 Excel 기간 선택 모달.
// - 프리셋 5종 + 시작/종료 월(MonthPicker) + (선택) 직원 셀렉터
// - 실행: GET /api/attendance/export?startDate&endDate[&employeeId]
//   · endDate 는 서버가 오늘(KST)로 clamp / startDate 생략 시 서버가 MIN(work_date) 사용
interface Props {
  defaultStartYm: string | null; // "2026-05" | null(=전체 기간)
  defaultEndYm: string; // "2026-07"
  employeeId?: number; // 지정 시 직원 셀렉터 숨기고 이 직원으로 고정
  showEmployeeSelect?: boolean; // 캘린더 전체 조회에서만 true
  onClose: () => void;
}

interface EmployeeOption {
  id: number;
  name: string;
  isActive: boolean;
}

// "YYYY-MM" 계산 헬퍼 (순수 달력 연산 — TZ 무관)
function shiftYm(ym: string, delta: number): string {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

// "YYYY-MM" → 그 달 말일 "YYYY-MM-DD"
function endYmdOf(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${ym}-${String(last).padStart(2, "0")}`;
}

// "YYYY-MM" → "YYYY년 M월"
function labelYm(ym: string): string {
  const [y, m] = ym.split("-");
  return `${y}년 ${Number(m)}월`;
}

export default function AttendanceExportModal({
  defaultStartYm,
  defaultEndYm,
  employeeId,
  showEmployeeSelect = false,
  onClose,
}: Props) {
  // KST 이번 달 "YYYY-MM"
  const thisYm = useMemo(
    () =>
      new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" })
        .format(new Date())
        .slice(0, 7),
    []
  );

  const [startYm, setStartYm] = useState<string | null>(defaultStartYm);
  const [endYm, setEndYm] = useState<string>(defaultEndYm);
  const [selectedEmployeeId, setSelectedEmployeeId] = useState<number | null>(
    null
  );
  const [startPickerOpen, setStartPickerOpen] = useState(false);
  const [endPickerOpen, setEndPickerOpen] = useState(false);
  const [employees, setEmployees] = useState<EmployeeOption[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 프리셋 (start: null = 전체 기간)
  const presets: { key: string; label: string; start: string | null; end: string }[] =
    useMemo(
      () => [
        { key: "thisMonth", label: "이번 달", start: thisYm, end: thisYm },
        {
          key: "lastMonth",
          label: "지난 달",
          start: shiftYm(thisYm, -1),
          end: shiftYm(thisYm, -1),
        },
        {
          key: "recent3",
          label: "최근 3개월",
          start: shiftYm(thisYm, -2),
          end: thisYm,
        },
        {
          key: "thisYear",
          label: "올해",
          start: `${thisYm.slice(0, 4)}-01`,
          end: thisYm,
        },
        { key: "all", label: "전체 기간", start: null, end: thisYm },
      ],
      [thisYm]
    );

  // ESC 닫기 — MonthPicker 가 열려 있으면 그쪽이 먼저 닫혀야 하므로 무시
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (startPickerOpen || endPickerOpen) return; // 하위 피커 우선
      onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, startPickerOpen, endPickerOpen]);

  // 직원 목록 (셀렉터 노출 시에만) — 퇴사자 정산 대비 includeInactive=true
  useEffect(() => {
    if (!showEmployeeSelect) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/employees?includeInactive=true");
        if (res.ok) {
          const data = await res.json();
          if (!cancelled) setEmployees(Array.isArray(data) ? data : []);
        }
      } catch {
        // 목록 실패해도 "전체 직원" 은 선택 가능하므로 무시
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [showEmployeeSelect]);

  // 종료가 미래 월이면 서버 clamp 로 결과가 하루로 눌리므로 아예 막는다.
  const futureEnd = endYm > thisYm;
  const reversedRange = startYm != null && startYm > endYm;
  const invalidRange = futureEnd || reversedRange;

  const isPresetActive = (p: { start: string | null; end: string }) =>
    p.start === startYm && p.end === endYm;

  const handleDownload = async () => {
    if (invalidRange || busy) return;
    setError(null);
    setBusy(true);
    try {
      const params = new URLSearchParams();
      if (startYm) params.set("startDate", `${startYm}-01`);
      params.set("endDate", endYmdOf(endYm)); // 오늘 clamp 는 서버가 처리
      const empId = employeeId ?? selectedEmployeeId;
      if (empId != null) params.set("employeeId", String(empId));
      await downloadFile(`/api/attendance/export?${params.toString()}`);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black/40 flex items-center justify-center z-[60] p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl shadow-xl w-full max-w-md"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 헤더 */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-100">
          <h3 className="font-bold text-gray-900 text-base flex items-center gap-2">
            <Calendar size={16} className="text-blue-600" />
            근태 Excel 기간 선택
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded-lg text-gray-400 hover:bg-gray-100 hover:text-gray-600"
            aria-label="닫기"
          >
            <X size={18} />
          </button>
        </div>

        <div className="p-5 space-y-4">
          {/* 프리셋 */}
          <div>
            <p className="text-xs font-semibold text-gray-500 mb-1.5">빠른 선택</p>
            <div className="flex flex-wrap gap-1.5">
              {presets.map((p) => {
                const active = isPresetActive(p);
                return (
                  <button
                    key={p.key}
                    type="button"
                    onClick={() => {
                      setStartYm(p.start);
                      setEndYm(p.end);
                    }}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                      active
                        ? "bg-blue-500 text-white border-blue-500"
                        : "bg-white text-gray-600 border-gray-200 hover:bg-gray-50"
                    }`}
                  >
                    {p.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* 시작 / 종료 월 */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <p className="text-xs font-semibold text-gray-500 mb-1.5">시작</p>
              <button
                type="button"
                onClick={() => setStartPickerOpen(true)}
                className="w-full px-3 py-2 text-sm text-left border border-gray-200 rounded-lg hover:bg-gray-50 text-gray-800"
              >
                {startYm ? labelYm(startYm) : "전체 기간(첫 기록부터)"}
              </button>
            </div>
            <div>
              <p className="text-xs font-semibold text-gray-500 mb-1.5">종료</p>
              <button
                type="button"
                onClick={() => setEndPickerOpen(true)}
                className="w-full px-3 py-2 text-sm text-left border border-gray-200 rounded-lg hover:bg-gray-50 text-gray-800"
              >
                {labelYm(endYm)}
              </button>
            </div>
          </div>

          {futureEnd && (
            <p className="text-xs text-rose-600">
              종료는 이번 달({labelYm(thisYm)})까지만 선택할 수 있습니다.
            </p>
          )}
          {!futureEnd && reversedRange && (
            <p className="text-xs text-rose-600">시작이 종료보다 뒤입니다.</p>
          )}

          {/* 대상 직원 (전체 조회 진입 시에만) */}
          {showEmployeeSelect && (
            <div>
              <p className="text-xs font-semibold text-gray-500 mb-1.5">
                대상 직원
              </p>
              <select
                value={selectedEmployeeId ?? ""}
                onChange={(e) =>
                  setSelectedEmployeeId(
                    e.target.value ? Number(e.target.value) : null
                  )
                }
                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg bg-white text-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-200"
              >
                <option value="">전체 직원</option>
                {employees.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}
                    {e.isActive ? "" : " (비활성)"}
                  </option>
                ))}
              </select>
            </div>
          )}

          {error && (
            <div className="text-xs text-rose-600 bg-rose-50 rounded-lg px-3 py-2">
              {error}
            </div>
          )}
        </div>

        {/* 푸터 */}
        <div className="px-5 py-3 border-t border-gray-100 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg"
          >
            취소
          </button>
          <button
            type="button"
            onClick={handleDownload}
            disabled={busy || invalidRange}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-semibold text-white bg-blue-500 rounded-lg hover:bg-blue-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {busy ? (
              <Loader2 size={15} className="animate-spin" />
            ) : (
              <Calendar size={15} />
            )}
            {busy ? "생성 중" : "다운로드"}
          </button>
        </div>
      </div>

      {/* MonthPicker(z-50)는 이 모달(z-[60])보다 낮으므로 z-[70] 래퍼로 위에 올린다.
          래퍼에서 stopPropagation 해 피커 배경 클릭이 이 모달 배경(onClose)까지 번지지 않게 한다. */}
      {startPickerOpen && (
        <div className="relative z-[70]" onClick={(e) => e.stopPropagation()}>
          <MonthPicker
            value={startYm ?? endYm}
            onChange={(v) => setStartYm(v)}
            onClose={() => setStartPickerOpen(false)}
          />
        </div>
      )}
      {endPickerOpen && (
        <div className="relative z-[70]" onClick={(e) => e.stopPropagation()}>
          <MonthPicker
            value={endYm}
            onChange={(v) => setEndYm(v)}
            onClose={() => setEndPickerOpen(false)}
          />
        </div>
      )}
    </div>
  );
}

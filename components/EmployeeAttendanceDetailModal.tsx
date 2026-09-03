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
import {
  settledProgressLabel,
  SETTLED_PROGRESS_STYLE,
  progressDotColor,
  progressTextColor,
  progressCategoryStyle,
} from "@/lib/attendanceProgress";
import {
  correctedRangeLabel,
  formatTime,
  formatWorkMinutes,
  isVacationCategory,
  AUTO_STATUS_META,
  dayOffsetFromWorkDate,
  dayOffsetTitle,
  evalKeys,
  showCorrectionBadge,
  progressLabel,
} from "@/lib/attendanceLabels";
import type { RealtimeStatus, ProgressStatus } from "@/lib/realtime-presence";
import ExcelButton from "@/components/ExcelButton";
import AttendanceExportModal from "@/components/AttendanceExportModal";

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
  originalCheckIn: string | null;
  originalCheckOut: string | null;
  // overview API는 wifi 필드를 계속 반환하지만, 표시 통일(3단계)로 모달은 daily 값을 사용
  workMinutes: number | null;
  autoStatus: string | null;
  isLate: boolean | null;
  isEarlyLeave: boolean | null;
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
  reqCategoryCode: string | null;
  reqCategoryName: string | null;
  // 오늘 행 전용 실시간 연결 상태 (overview API 가 realtime API 와 동일 판정으로 채움). 과거 행은 null.
  realtimeStatus: RealtimeStatus | null;
  latestCheckedAt: string | null;
  latestLocation: string | null;
  /** 오늘 행 전용 실시간 진행 상태 (목록의 실시간 현황 카드와 동일 판정). 과거 행은 null. */
  progressStatus: ProgressStatus | null;
}

// isVacationCategory / formatTime / formatWorkMinutes 는 lib/attendanceLabels로 이동(3단계 dedupe).

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
  // 캘린더 보정 우선 — 단, 시간형 일정이 "아직 시작 전"이면 일반 판정으로 흐른다.
  if (row.isOverridden && row.categoryId && row.categoryName) {
    const isTimed = !!(row.correctedCheckIn && row.correctedCheckOut);
    const now = Date.now();
    const calIn = row.correctedCheckIn
      ? new Date(row.correctedCheckIn).getTime()
      : null;
    const calOut = row.correctedCheckOut
      ? new Date(row.correctedCheckOut).getTime()
      : null;
    const notStartedYet = isTimed && calIn !== null && now < calIn;

    if (!notStartedYet) {
      let label: string;
      if (isVacationCategory(row.categoryCode)) {
        label = row.categoryName; // "연차" 등 종일 휴가류는 그대로
      } else if (isTimed && calOut !== null) {
        const ended = now >= calOut;
        label = ended ? `${row.categoryName}완료` : `${row.categoryName}중`;
      } else {
        const ended = !!row.checkOut; // 종일/시각없음 → 폴백
        label = ended ? `${row.categoryName}완료` : `${row.categoryName}중`;
      }
      return (
        <span className="inline-flex items-center gap-1 text-xs font-medium text-purple-700 whitespace-nowrap">
          <span
            className="w-2 h-2 rounded-full"
            style={{ backgroundColor: row.categoryColor ?? "#a855f7" }}
          />
          {label}
        </span>
      );
    }
    // notStartedYet === true → 여기서 return 안 하고 아래 공용 판정으로 흐른다.
  }
  // 출근/퇴근 존재 + 오늘 여부로만 판정 (완료/근무중/미퇴근/미출근)
  const label = settledProgressLabel({
    hasCheckIn: !!row.checkIn,
    hasCheckOut: !!row.checkOut,
    isToday: row.workDate === todayYmd(),
  });
  const style = SETTLED_PROGRESS_STYLE[label];
  const labelEl = (
    <span
      className={`inline-flex items-center gap-1 text-xs font-medium whitespace-nowrap ${style.text}`}
    >
      <span className={`w-2 h-2 rounded-full ${style.dot}`} />
      {label}
    </span>
  );
  // 오늘 행은 실시간 진행 상태를 그대로 쓴다 — 목록(실시간 현황 카드)과 같은 판정/문구/색.
  // "근무중"(attendance_daily 기준: 출근O·퇴근X)만으로는 지금 자리에 있는지 알 수 없다.
  if (row.progressStatus) {
    return renderRealtimeProgress(
      row.progressStatus,
      row.categoryName,
      row.categoryCode,
      row.categoryColor
    );
  }
  return labelEl;
}

// 실시간 진행 상태 렌더 — 실시간 현황 카드와 문구·색을 공유한다(lib/attendanceProgress).
// category_* 이고 categoryColor 가 있으면 purple fallback 을 덮는 것까지 목록과 동일.
function renderRealtimeProgress(
  s: ProgressStatus,
  categoryName: string | null,
  categoryCode: string | null,
  categoryColor: string | null
) {
  const catStyle = progressCategoryStyle(s, categoryColor, "text");
  return (
    <span
      className={`inline-flex items-center gap-1 text-xs font-medium whitespace-nowrap ${progressTextColor(s)}`}
      style={catStyle}
    >
      <span
        className={`w-2 h-2 rounded-full ${progressDotColor(s)}`}
        style={catStyle ? { backgroundColor: categoryColor ?? undefined } : undefined}
      />
      {progressLabel(s, categoryName, categoryCode)}
    </span>
  );
}

// 평가 컬럼. Phase 6-2B: 캘린더 보정 시 카테고리명 표시 (Q5c).
// 출퇴근 셀 — 정정된 경우 원본(취소선) + 정정값(청록). 캘린더 일별 모달과 동일 규칙.
// workDate를 주면 자정을 넘긴 시각에 "+1" 윗첨자를 붙인다(야간 근무).
function renderTimeCell(
  original: string | null,
  actual: string | null,
  workDate?: string
) {
  const off = workDate ? dayOffsetFromWorkDate(workDate, actual) : 0;
  const mark =
    off > 0 ? (
      <sup
        className="ml-0.5 text-[10px] font-semibold text-amber-600"
        title={dayOffsetTitle(workDate, actual)}
      >
        +{off}
      </sup>
    ) : null;
  if (original) {
    return (
      <>
        <span className="line-through text-gray-400 mr-1">{formatTime(original)}</span>
        <span className="text-cyan-600 font-semibold">
          {formatTime(actual)}
          {mark}
        </span>
      </>
    );
  }
  if (!actual) return "-";
  return (
    <>
      {formatTime(actual)}
      {mark}
    </>
  );
}

// 평가 칸 — 3축 분리 규칙.
//  [평가] 항상 표시(플래그 있으면 지각·조퇴 병기, 없으면 autoStatus 단독 폴백)
//  [카테고리] 근태정정만. 부재 카테고리(연차/출장 등)는 '진행' 칸이 이미 표시하므로
//             여기서 또 붙이지 않는다(화면당 1회 원칙).
//  [정정배지] 근태정정 카테고리가 보이면 중복이므로 생략.
function renderEval(row: DetailRow) {
  // 4번째 인자는 기존 renderEval의 '정상' 추정 조건(check_in+check_out 둘 다)과
  // 동일하게 맞춘다 — 플래그 없는 과거 행의 표시가 바뀌지 않도록.
  const keys = evalKeys(
    row.autoStatus,
    row.isLate,
    row.isEarlyLeave,
    !!row.checkIn && !!row.checkOut
  );
  const showCat = row.categoryCode === "CORRECTION" && !!row.categoryName;
  const showCorr = showCorrectionBadge(
    row.originalCheckIn,
    row.originalCheckOut,
    row.categoryCode
  );

  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap">
      {keys.length > 0 ? (
        <span className="text-xs font-medium whitespace-nowrap">
          {keys.map((k, i) => (
            <span key={k} className={AUTO_STATUS_META[k].cls}>
              {i > 0 && <span className="text-gray-400">·</span>}
              {AUTO_STATUS_META[k].label}
            </span>
          ))}
        </span>
      ) : (
        <span className="text-xs text-gray-400 whitespace-nowrap">–</span>
      )}
      {showCat && (
        <span className="text-xs bg-purple-100 text-purple-700 px-1.5 py-0.5 rounded-full font-medium whitespace-nowrap">
          {row.categoryName}
        </span>
      )}
      {showCorr && (
        <span className="text-xs bg-cyan-100 text-cyan-700 px-1.5 py-0.5 rounded-full font-medium whitespace-nowrap">
          정정
        </span>
      )}
    </span>
  );
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
  const [exportOpen, setExportOpen] = useState(false);

  // KST 이번 달 "YYYY-MM" (Excel 기간 모달 종료 기본값)
  const thisYm = useMemo(
    () =>
      new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" })
        .format(new Date())
        .slice(0, 7),
    []
  );

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

  // ESC 키로 닫기 — 기간 선택 모달이 열려 있으면 그쪽이 먼저 닫혀야 하므로 무시
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (exportOpen) return; // 하위 모달 우선
      onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose, exportOpen]);

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
    <>
    <div
      className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl shadow-xl max-w-5xl w-full max-h-[85vh] overflow-y-auto"
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
          <div className="shrink-0 ml-3 flex items-center gap-2">
            <ExcelButton
              onClick={() => setExportOpen(true)}
              size="sm"
              title="근태 Excel 다운로드 (기간 선택)"
            />
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg text-gray-400 hover:bg-gray-100 hover:text-gray-600"
              aria-label="닫기"
            >
              <X size={18} />
            </button>
          </div>
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
                    <table className="w-full min-w-[860px]">
                      <thead>
                        <tr className="bg-gray-50 border-b border-gray-100">
                          <th className="text-left text-xs font-semibold text-gray-500 px-4 py-2.5 whitespace-nowrap">
                            날짜
                          </th>
                          <th className="text-left text-xs font-semibold text-gray-500 px-4 py-2.5 whitespace-nowrap">
                            출근
                          </th>
                          <th className="text-left text-xs font-semibold text-gray-500 px-4 py-2.5 whitespace-nowrap">
                            퇴근
                          </th>
                          <th className="text-right text-xs font-semibold text-gray-500 px-4 py-2.5 whitespace-nowrap">
                            근무
                          </th>
                          <th className="text-center text-xs font-semibold text-gray-500 px-4 py-2.5 whitespace-nowrap">
                            진행
                          </th>
                          <th className="text-center text-xs font-semibold text-gray-500 px-4 py-2.5 whitespace-nowrap">
                            평가
                          </th>
                          <th className="text-left text-xs font-semibold text-gray-500 px-4 py-2.5 whitespace-nowrap">
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
                            <td className="px-4 py-2.5 text-sm text-gray-700 font-mono whitespace-nowrap">
                              {formatDateLabel(r.workDate)}
                            </td>
                            <td className="px-4 py-2.5 text-sm text-gray-900 font-mono whitespace-nowrap">
                              {renderTimeCell(r.originalCheckIn, r.checkIn)}
                            </td>
                            <td className="px-4 py-2.5 text-sm text-gray-900 font-mono whitespace-nowrap">
                              {renderTimeCell(r.originalCheckOut, r.checkOut, r.workDate)}
                            </td>
                            <td className="px-4 py-2.5 text-sm text-gray-900 font-mono text-right whitespace-nowrap">
                              {formatWorkMinutes(r.workMinutes)}
                            </td>
                            <td className="px-4 py-2.5 text-center">
                              {renderProgress(r)}
                            </td>
                            <td className="px-4 py-2.5 text-center whitespace-nowrap">
                              {renderEval(r)}
                            </td>
                            <td
                              className="px-4 py-2.5 text-sm text-gray-600 w-full max-w-0"
                              title={r.reason ?? ""}
                            >
                              {/* 외근/출장 등 시간대 일정 — 출퇴근 시각과 별개로 일정 시간대 표시 */}
                              {r.isOverridden &&
                                r.correctedCheckIn &&
                                r.correctedCheckOut && (
                                  <div className="text-[11px] text-purple-700 font-mono truncate">
                                    {correctedRangeLabel(r.reqCategoryCode, r.reqCategoryName)}{" "}
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
                            {renderTimeCell(r.originalCheckIn, r.checkIn)} ~ {renderTimeCell(r.originalCheckOut, r.checkOut, r.workDate)}
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
                              {correctedRangeLabel(r.reqCategoryCode, r.reqCategoryName)}{" "}
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

    {/* 근태 Excel 기간 선택 모달 — 상세 모달(z-50) 위에 뜨도록 형제로 렌더 (z-[60]) */}
    {exportOpen && (
      <AttendanceExportModal
        defaultStartYm={null}
        defaultEndYm={thisYm}
        employeeId={employeeId}
        showEmployeeSelect={false}
        onClose={() => setExportOpen(false)}
      />
    )}
    </>
  );
}

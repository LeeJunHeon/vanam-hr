"use client";

import { useState, useEffect, useCallback, useMemo, type ReactNode } from "react";
import {
  Loader2,
  RefreshCw,
  CheckCircle,
  AlertCircle,
  Users,
  Wifi,
  WifiOff,
  Check,
  Minus,
  Briefcase,
} from "lucide-react";
import EmployeeAttendanceDetailModal from "@/components/EmployeeAttendanceDetailModal";
import AttendanceCalendarView from "@/components/AttendanceCalendarView";

// ───────────────────────── 타입 ─────────────────────────

interface AttendanceRow {
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
}

interface OverviewResponse {
  range: { startDate: string; endDate: string };
  scope: "all" | "department";
  departmentId: number | null;
  employeeId: number | null;
  rows: AttendanceRow[];
}

interface DeptOption {
  id: number;
  name: string;
}

interface EmployeeOption {
  id: number;
  employeeNo: string | null;
  name: string;
  departmentId: number | null;
  departmentName: string | null;
}

type ProgressStatus =
  | "working"
  | "away"
  | "completed"
  | "absent_today"
  | "category_working"
  | "category_completed";

interface RealtimeRow {
  employeeId: number;
  employeeNo: string;
  name: string;
  departmentName: string | null;
  positionName: string | null;
  realtimeStatus: "working" | "disconnected";
  latestStatus: string | null;
  latestCheckedAt: string | null;
  latestLocation: string | null;
  todayCheckIn: string | null;
  todayCheckOut: string | null;
  todayWorkMinutes: number | null;
  todayAutoStatus: string | null;
  todayCategoryId: number | null;
  todayCategoryCode: string | null;
  todayCategoryName: string | null;
  todayCategoryColor: string | null;
  todayIsOverridden: boolean;
  todayReason: string | null;
  progressStatus: ProgressStatus;
}

interface RealtimeResponse {
  scope: "all" | "department";
  departmentId: number | null;
  asOf: string;
  graceMinutes: number;
  rows: RealtimeRow[];
}

interface EmpSummary {
  employeeId: number;
  employeeNo: string;
  name: string;
  departmentName: string | null;
  positionName: string | null;
  attendedDays: number;
  totalMinutes: number;
  normalDays: number;
  lateDays: number;
  earlyLeaveDays: number;
  absentDays: number;
}

interface SelectedEmployee {
  id: number;
  name: string;
  departmentName: string | null;
  positionName: string | null;
}

// ───────────────────────── 유틸 함수 ─────────────────────────

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

// 상대 시각 ("9분 전")
function formatRelativeTime(iso: string | null): string {
  if (!iso) return "-";
  const d = new Date(iso);
  const now = new Date();
  const diffMin = Math.floor((now.getTime() - d.getTime()) / 60000);
  if (diffMin < 1) return "방금 전";
  if (diffMin < 60) return `${diffMin}분 전`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour}시간 전`;
  return `${Math.floor(diffHour / 24)}일 전`;
}

// 카테고리 아이콘 (Phase 6-2B 캘린더 보정 시). FAMILY_EVENT는 아이콘 없음(사용자 결정).
function categoryIcon(code: string | null): string {
  if (!code) return "";
  switch (code) {
    case "ANNUAL":
    case "HALF_AM":
    case "HALF_PM":
      return "🏖️";
    case "SICK":
      return "🏥";
    case "EXTERNAL_WORK":
    case "BUSINESS_TRIP":
      return "🌐";
    case "REMOTE_WORK":
      return "🏠";
    case "ETC":
      return "📋";
    case "FAMILY_EVENT":
      return ""; // 경조사는 아이콘 없음
    default:
      return "";
  }
}

// 휴가성(vacation) 카테고리 여부 — 종일이라 "진행/완료" 구분 없이 카테고리명만 표시
function isVacationCategory(code: string | null): boolean {
  if (!code) return false;
  return ["ANNUAL", "HALF_AM", "HALF_PM", "SICK", "FAMILY_EVENT"].includes(code);
}

// "진행/완료" 접미사를 붙이지 않고 카테고리명만 표시할 카테고리.
// = 휴가류 + 기타(ETC). ETC는 "기타중/기타완료" 어색해서 "기타"로만 노출.
function isLabelOnlyCategory(code: string | null): boolean {
  return isVacationCategory(code) || code === "ETC";
}

// 진행 상태 라벨. 카테고리 분기에서는 row를 통해 categoryName/CategoryCode 사용.
function progressLabel(s: ProgressStatus, row?: RealtimeRow): string {
  switch (s) {
    case "working":
      return "근무중";
    case "away":
      return "자리비움";
    case "completed":
      return "완료";
    case "absent_today":
      return "미출근";
    case "category_working":
      if (row?.todayCategoryName) {
        return isLabelOnlyCategory(row.todayCategoryCode)
          ? row.todayCategoryName // "연차"/"병가"/"기타" 등 (접미사 X)
          : `${row.todayCategoryName}중`; // "외근중"
      }
      return "부재중";
    case "category_completed":
      if (row?.todayCategoryName) {
        return isLabelOnlyCategory(row.todayCategoryCode)
          ? row.todayCategoryName // "연차"/"기타" 등 (접미사 X)
          : `${row.todayCategoryName}완료`; // "외근완료"
      }
      return "부재중";
  }
}

// 진행 상태 점 색상 (category 분기는 categoryColor 없을 때 fallback purple)
function progressDotColor(s: ProgressStatus): string {
  switch (s) {
    case "working":
      return "bg-emerald-500";
    case "away":
      return "bg-amber-500";
    case "completed":
      return "bg-blue-500";
    case "absent_today":
      return "bg-gray-400";
    case "category_working":
    case "category_completed":
      return "bg-purple-500"; // categoryColor 있으면 inline style로 덮어씀
  }
}

// 진행 상태 배지 클래스 (category 분기는 categoryColor 있으면 inline style 덮어씀)
function progressBadgeClass(s: ProgressStatus): string {
  const base =
    "inline-flex items-center text-xs px-2 py-0.5 rounded-md font-medium shrink-0";
  switch (s) {
    case "working":
      return `${base} bg-emerald-50 text-emerald-700`;
    case "away":
      return `${base} bg-amber-50 text-amber-700`;
    case "completed":
      return `${base} bg-blue-50 text-blue-700`;
    case "absent_today":
      return `${base} bg-gray-50 text-gray-600`;
    case "category_working":
    case "category_completed":
      return `${base} bg-purple-50 text-purple-700`;
  }
}

// 평가 라벨.
// - check_out이 없으면 평가 보류 ('–')
// - autoStatus가 NULL이지만 check_out 있으면 '정상' 추정 (옛날 데이터 보호)
function evalLabel(autoStatus: string | null, hasCheckOut: boolean): string {
  if (!hasCheckOut) return "–";
  if (autoStatus === "normal") return "정상";
  if (autoStatus === "late") return "지각";
  if (autoStatus === "early_leave") return "조퇴";
  if (autoStatus === "absent") return "결근";
  // NULL이지만 check_out 있음 → autoStatus 도입 전 옛날 데이터로 추정, '정상'으로 표시
  return "정상";
}

// 평가 텍스트 색상 (evalLabel과 동일한 분기)
function evalColor(autoStatus: string | null, hasCheckOut: boolean): string {
  if (!hasCheckOut) return "text-gray-400"; // 평가 보류 '–'
  if (autoStatus === "normal") return "text-emerald-600";
  if (autoStatus === "late") return "text-amber-600";
  if (autoStatus === "early_leave") return "text-orange-600";
  if (autoStatus === "absent") return "text-rose-600";
  // NULL이지만 check_out 있음 → 정상 색상으로
  return "text-emerald-600";
}

// 진행 라벨 (autoStatus 기준) — 기간별/CSV용
function progressFromAutoStatus(autoStatus: string | null): string {
  if (autoStatus === "working") return "근무중";
  if (
    autoStatus === "normal" ||
    autoStatus === "late" ||
    autoStatus === "early_leave"
  )
    return "완료";
  return "미출근"; // absent 또는 null
}

/**
 * 진행 상태 판정 — Phase 6-2B 캘린더 보정 우선, 그 외엔 autoStatus + checkIn/Out.
 * - 캘린더 보정(isOverridden + categoryName) → 카테고리 라벨 ("연차" / "외근중" / "외근완료")
 * - autoStatus='working' → '근무중'
 * - check_in + check_out 다 있음 → '완료' (autoStatus 무관, 옛날 데이터 보호)
 * - check_in만 있음 → '근무중'
 * - autoStatus='absent' 또는 데이터 없음 → '미출근'
 */
function progressFromRow(row: {
  checkIn: string | null;
  checkOut: string | null;
  autoStatus: string | null;
  categoryId?: number | null;
  categoryCode?: string | null;
  categoryName?: string | null;
  isOverridden?: boolean;
  correctedCheckIn?: string | null;
  correctedCheckOut?: string | null;
}): string {
  // 캘린더 보정 우선 (Q-A) — 단, 시간형이 아직 시작 전이면 일반 판정으로 흐른다.
  if (row.isOverridden && row.categoryId && row.categoryName) {
    if (isVacationCategory(row.categoryCode ?? null)) return row.categoryName;
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
      let ended: boolean;
      if (isTimed && calOut !== null) {
        ended = now >= calOut;
      } else {
        ended = !!row.checkOut;
      }
      return ended ? `${row.categoryName}완료` : `${row.categoryName}중`;
    }
    // notStartedYet이면 아래 일반 로직으로 흐른다.
  }
  // 기존 로직
  if (row.autoStatus === "working") return "근무중";
  if (row.checkIn && row.checkOut) return "완료";
  if (row.checkIn) return "근무중";
  if (row.autoStatus === "absent") return "미출근";
  return "미출근";
}

// 직원 카드/표의 "마지막 활동" 한 줄 (아이콘 + 정보)
// Phase 6-2B: 캘린더 보정 우선 표시 → 아이콘 + 카테고리명 + 사유 + 시간/종일
function renderActivityInfo(r: RealtimeRow): ReactNode {
  // 지금 회사 WiFi에 연결 중(working)이면 실제 위치(본사/공덕)를 우선 표시.
  // (출장/외근 일정이 있어도, 복귀해 연결됐으면 위치가 더 정확하다.)
  // 단 category_working(출장/외근 시간대 진행 중)일 때는 일정 표시를 유지한다.
  if (r.progressStatus === "working") {
    return (
      <span className="inline-flex items-center gap-1 flex-wrap">
        <Wifi size={12} className="text-emerald-500 shrink-0" />
        {r.latestLocation ?? "위치 미상"} ·{" "}
        {formatRelativeTime(r.latestCheckedAt)} 연결
        {r.todayCheckIn ? ` · 첫 출근 ${formatTime(r.todayCheckIn)}` : ""}
      </span>
    );
  }

  // 캘린더 보정 우선 (Q-A)
  if (r.todayIsOverridden && r.todayCategoryCode && r.todayCategoryName) {
    const icon = categoryIcon(r.todayCategoryCode);
    let timeInfo: string;
    if (!r.todayCheckIn && !r.todayCheckOut) {
      timeInfo = "종일";
    } else {
      const start = r.todayCheckIn ? formatTime(r.todayCheckIn) : "";
      const end = r.todayCheckOut ? formatTime(r.todayCheckOut) : "(진행 중)";
      timeInfo = `${start} ~ ${end}`;
    }
    return (
      <span className="inline-flex items-center gap-1 flex-wrap">
        {icon && <span className="shrink-0">{icon}</span>}
        <span
          className="font-medium"
          style={{ color: r.todayCategoryColor ?? "#a855f7" }}
        >
          {r.todayCategoryName}
        </span>
        {r.todayReason && (
          <>
            <span className="text-gray-300">·</span>
            <span className="text-gray-600 truncate">{r.todayReason}</span>
          </>
        )}
        <span className="text-gray-300">·</span>
        <span className="text-gray-700 font-mono">{timeInfo}</span>
      </span>
    );
  }

  switch (r.progressStatus) {
    // 'working'은 위 early-return에서 이미 처리됨.
    case "away":
      return (
        <span className="inline-flex items-center gap-1 flex-wrap">
          <WifiOff size={12} className="text-amber-500 shrink-0" />
          {formatTime(r.latestCheckedAt)} 끊김
          {r.todayCheckIn ? ` · 첫 출근 ${formatTime(r.todayCheckIn)}` : ""} ·
          잠시 자리비움
        </span>
      );
    case "completed":
      return (
        <span className="inline-flex items-center gap-1 flex-wrap">
          <Check size={12} className="text-blue-500 shrink-0" />
          {formatTime(r.todayCheckIn)} ~{" "}
          {formatTime(r.todayCheckOut ?? r.latestCheckedAt)}
          {r.todayWorkMinutes != null
            ? ` (${formatWorkMinutes(r.todayWorkMinutes)})`
            : ""}
          {r.todayAutoStatus && r.todayAutoStatus !== "working"
            ? ` · ${evalLabel(r.todayAutoStatus, !!r.todayCheckOut)}`
            : ""}
        </span>
      );
    case "absent_today":
      return (
        <span className="inline-flex items-center gap-1 text-gray-400">
          <Minus size={12} className="shrink-0" />
          오늘 출근 기록 없음
        </span>
      );
    case "category_working":
    case "category_completed":
      // 위 early-return에서 이미 처리됨. 카테고리 정보 없는 비정상 케이스 안전망.
      return (
        <span className="inline-flex items-center gap-1 text-gray-400">
          <Minus size={12} className="shrink-0" />
          캘린더 보정 (카테고리 정보 없음)
        </span>
      );
  }
}

// 섹션 3 "마지막 활동" 짧은 텍스트 (모바일)
function renderActivityShort(r: RealtimeRow): string {
  // 연결 중이면 위치/연결 우선 (renderActivityInfo와 동일 정책)
  if (r.progressStatus === "working") {
    return `${formatTime(r.latestCheckedAt)} 연결`;
  }
  // 캘린더 보정 우선
  if (r.todayIsOverridden && r.todayCategoryName) {
    if (!r.todayCheckIn && !r.todayCheckOut) return "종일";
    const start = r.todayCheckIn ? formatTime(r.todayCheckIn) : "";
    const end = r.todayCheckOut ? formatTime(r.todayCheckOut) : "(진행 중)";
    return `${start} ~ ${end}`;
  }
  switch (r.progressStatus) {
    // 'working'은 위 early-return에서 이미 처리됨.
    case "away":
      return `${formatTime(r.latestCheckedAt)} 끊김`;
    case "completed":
      return `${formatTime(r.todayCheckOut ?? r.latestCheckedAt)} 퇴근`;
    case "absent_today":
      return "-";
    case "category_working":
    case "category_completed":
      return "-"; // 위 if에서 이미 처리됨, 안전망
  }
}

// ───────────────────────── 메인 페이지 ─────────────────────────

export default function AttendanceOverviewPage() {
  // 실시간 현황 (섹션 1, 2 공용)
  // Phase 6-2I: 섹션 3/4 제거 (월 캘린더 뷰로 통합) → 관련 state/effect/helper 제거
  const [realtimeData, setRealtimeData] = useState<RealtimeResponse | null>(
    null
  );
  const [realtimeLoading, setRealtimeLoading] = useState(true);

  // 직원 클릭 모달
  const [selectedEmployee, setSelectedEmployee] =
    useState<SelectedEmployee | null>(null);

  // 실시간 현황 fetch (섹션 1, 2)
  const fetchRealtime = useCallback(async (silent = false) => {
    if (!silent) setRealtimeLoading(true);
    try {
      const res = await fetch("/api/attendance/realtime");
      if (res.ok) {
        const data = await res.json();
        // Phase 6-2L: silent 모드(30초 폴링/탭 복귀)에서는 스크롤 위치 보존.
        // setState 직전 scrollY 저장 → 리렌더 완료 후 다시 복원.
        // requestAnimationFrame 2번 중첩: 첫 RAF에서 React 리렌더 commit, 두 번째에서 paint 직전 scroll 복원.
        if (silent) {
          const scrollY = window.scrollY;
          setRealtimeData(data);
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              window.scrollTo({ top: scrollY, behavior: "instant" });
            });
          });
        } else {
          setRealtimeData(data);
        }
      }
    } catch (e) {
      console.error("realtime fetch error:", e);
    } finally {
      if (!silent) setRealtimeLoading(false);
    }
  }, []);

  // 첫 진입: 실시간 자동 조회
  useEffect(() => {
    fetchRealtime();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 실시간 현황 30초 폴링 (탭이 보일 때만)
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") {
        fetchRealtime(true);
      }
    }, 30000);
    // 탭 복귀 시 즉시 갱신
    const onVisible = () => {
      if (document.visibilityState === "visible") fetchRealtime(true);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [fetchRealtime]);

  // 섹션 1 요약 카운트 (progressStatus + autoStatus 기준)
  const counts = useMemo(() => {
    const rows = realtimeData?.rows ?? [];
    return {
      working: rows.filter((r) => r.progressStatus === "working").length,
      away: rows.filter((r) => r.progressStatus === "away").length,
      completed: rows.filter((r) => r.progressStatus === "completed").length,
      absentToday: rows.filter((r) => r.progressStatus === "absent_today")
        .length,
      normal: rows.filter((r) => r.todayAutoStatus === "normal").length,
      late: rows.filter((r) => r.todayAutoStatus === "late").length,
      earlyLeave: rows.filter((r) => r.todayAutoStatus === "early_leave")
        .length,
      categoryWorking: rows.filter(
        (r) => r.progressStatus === "category_working"
      ).length,
      categoryCompleted: rows.filter(
        (r) => r.progressStatus === "category_completed"
      ).length,
      categoryCount: rows.filter(
        (r) =>
          r.progressStatus === "category_working" ||
          r.progressStatus === "category_completed"
      ).length,
    };
  }, [realtimeData]);

  const workingTotal = counts.working + counts.away;
  const abnormalTotal = counts.late + counts.earlyLeave;

  const realtimeRows = realtimeData?.rows ?? [];

  // 헤더 "기준 시각" 표시
  const asOfLabel = realtimeData
    ? new Date(realtimeData.asOf).toLocaleString("ko-KR", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      })
    : null;

  return (
    <div className="p-4 sm:p-6 space-y-5">
      {/* ───── 헤더 ───── */}
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-3">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold text-gray-900">
            전체 근태 조회
          </h1>
          <p className="text-sm text-gray-500 mt-0.5">
            {asOfLabel ? `${asOfLabel} 기준 · 30초마다 자동 갱신` : "실시간 현황을 불러오는 중..."}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => fetchRealtime()}
            disabled={realtimeLoading}
            className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium bg-white border border-gray-200 text-gray-600 rounded-xl hover:bg-gray-50 disabled:opacity-40"
          >
            <RefreshCw
              size={14}
              className={realtimeLoading ? "animate-spin" : ""}
            />
            새로고침
          </button>
        </div>
      </div>

      {/* ───── 섹션 1: 지금 (요약 카드 5개) ───── */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 sm:gap-4">
        {/* 근무 중 */}
        <div className="bg-emerald-50 rounded-2xl border border-emerald-100 p-4 sm:p-5">
          <div className="flex items-center gap-2 mb-2">
            <Wifi size={16} className="text-emerald-600" />
            <p className="text-xs font-semibold text-emerald-700 uppercase tracking-wide">
              근무 중
            </p>
          </div>
          <p className="text-2xl sm:text-3xl font-bold text-emerald-700 font-mono">
            {workingTotal}
            <span className="text-base font-medium text-emerald-600">명</span>
          </p>
          <p className="text-xs text-emerald-600/80 mt-1">
            연결 {counts.working} · 자리비움 {counts.away}
          </p>
        </div>

        {/* 퇴근 완료 */}
        <div className="bg-blue-50 rounded-2xl border border-blue-100 p-4 sm:p-5">
          <div className="flex items-center gap-2 mb-2">
            <CheckCircle size={16} className="text-blue-600" />
            <p className="text-xs font-semibold text-blue-700 uppercase tracking-wide">
              퇴근 완료
            </p>
          </div>
          <p className="text-2xl sm:text-3xl font-bold text-blue-700 font-mono">
            {counts.completed}
            <span className="text-base font-medium text-blue-600">명</span>
          </p>
          <p className="text-xs text-blue-600/80 mt-1">
            정상 {counts.normal} · 지각 {counts.late} · 조퇴 {counts.earlyLeave}
          </p>
        </div>

        {/* 외근/휴가 (Phase 6-2B 신규) */}
        <div className="bg-purple-50 rounded-2xl border border-purple-100 p-4 sm:p-5">
          <div className="flex items-center gap-2 mb-2">
            <Briefcase size={16} className="text-purple-600" />
            <p className="text-xs font-semibold text-purple-700 uppercase tracking-wide">
              외근/휴가
            </p>
          </div>
          <p className="text-2xl sm:text-3xl font-bold text-purple-700 font-mono">
            {counts.categoryCount}
            <span className="text-base font-medium text-purple-600">명</span>
          </p>
          <p className="text-xs text-purple-600/80 mt-1">
            진행중 {counts.categoryWorking} · 완료 {counts.categoryCompleted}
          </p>
        </div>

        {/* 미출근 */}
        <div className="bg-gray-50 rounded-2xl border border-gray-100 p-4 sm:p-5">
          <div className="flex items-center gap-2 mb-2">
            <Minus size={16} className="text-gray-500" />
            <p className="text-xs font-semibold text-gray-600 uppercase tracking-wide">
              미출근
            </p>
          </div>
          <p className="text-2xl sm:text-3xl font-bold text-gray-700 font-mono">
            {counts.absentToday}
            <span className="text-base font-medium text-gray-500">명</span>
          </p>
          <p className="text-xs text-gray-500 mt-1">아직 기록 없음</p>
        </div>

        {/* 이상 */}
        <div className="bg-amber-50 rounded-2xl border border-amber-100 p-4 sm:p-5">
          <div className="flex items-center gap-2 mb-2">
            <AlertCircle size={16} className="text-amber-600" />
            <p className="text-xs font-semibold text-amber-700 uppercase tracking-wide">
              이상
            </p>
          </div>
          <p className="text-2xl sm:text-3xl font-bold text-amber-700 font-mono">
            {abnormalTotal}
            <span className="text-base font-medium text-amber-600">명</span>
          </p>
          <p className="text-xs text-amber-600/80 mt-1">
            지각 {counts.late} · 조퇴 {counts.earlyLeave}
          </p>
        </div>
      </div>

      {/* ───── 섹션 2: 직원별 현황 (실시간 카드 그리드) ───── */}
      <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
        <div className="px-5 py-3 border-b border-gray-100 bg-gray-50 flex items-center justify-between">
          <h3 className="text-sm font-bold text-gray-900">직원별 현황 (실시간)</h3>
          <span className="text-xs text-gray-400">
            {realtimeRows.length}명 · 카드 클릭 시 최근 30일 보기
          </span>
        </div>

        {realtimeLoading && !realtimeData ? (
          <div className="flex items-center justify-center h-32">
            <Loader2 size={20} className="animate-spin text-blue-500" />
            <span className="ml-2 text-sm text-gray-500">
              실시간 현황 로딩 중...
            </span>
          </div>
        ) : realtimeRows.length === 0 ? (
          <div className="px-5 py-12 text-center">
            <Users size={32} className="mx-auto mb-2 text-gray-300" />
            <p className="text-sm text-gray-400">활성 직원이 없습니다</p>
          </div>
        ) : (
          <div className="p-3 grid grid-cols-1 lg:grid-cols-2 gap-2">
            {realtimeRows.map((r) => (
              <button
                key={r.employeeId}
                onClick={() =>
                  setSelectedEmployee({
                    id: r.employeeId,
                    name: r.name,
                    departmentName: r.departmentName,
                    positionName: r.positionName,
                  })
                }
                className="w-full text-left bg-white border border-gray-100 rounded-lg px-3 sm:px-4 py-3 flex items-center gap-3 hover:bg-blue-50/40 hover:border-blue-100 transition-colors"
              >
                {/* 상태 점 (카테고리 보정 시 categoryColor 우선 적용) */}
                <span
                  className={`w-2.5 h-2.5 rounded-full shrink-0 ${
                    (r.progressStatus === "category_working" ||
                      r.progressStatus === "category_completed") &&
                    r.todayCategoryColor
                      ? ""
                      : progressDotColor(r.progressStatus)
                  } ${r.progressStatus === "working" ? "animate-pulse" : ""}`}
                  style={
                    (r.progressStatus === "category_working" ||
                      r.progressStatus === "category_completed") &&
                    r.todayCategoryColor
                      ? { backgroundColor: r.todayCategoryColor }
                      : undefined
                  }
                />

                {/* 본문 */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline gap-2">
                    <span className="font-medium text-gray-900 truncate">
                      {r.name}
                    </span>
                    <span className="text-xs text-gray-400 truncate">
                      {r.employeeNo || "-"} · {r.departmentName ?? "-"}
                    </span>
                  </div>
                  <div className="text-xs text-gray-500 mt-0.5">
                    {renderActivityInfo(r)}
                  </div>
                </div>

                {/* 상태 배지 (카테고리 보정 시 categoryColor 우선) */}
                <span
                  className={progressBadgeClass(r.progressStatus)}
                  style={
                    (r.progressStatus === "category_working" ||
                      r.progressStatus === "category_completed") &&
                    r.todayCategoryColor
                      ? {
                          backgroundColor: `${r.todayCategoryColor}20`,
                          color: r.todayCategoryColor,
                        }
                      : undefined
                  }
                >
                  {progressLabel(r.progressStatus, r)}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* ───── 섹션 3: 월 캘린더 뷰 (Phase 6-2I — 오늘 출퇴근/기간별 조회 통합) ───── */}
      <AttendanceCalendarView />


      {/* ───── 직원 상세 모달 ───── */}
      {selectedEmployee && (
        <EmployeeAttendanceDetailModal
          employeeId={selectedEmployee.id}
          employeeName={selectedEmployee.name}
          departmentName={selectedEmployee.departmentName}
          positionName={selectedEmployee.positionName}
          onClose={() => setSelectedEmployee(null)}
        />
      )}
    </div>
  );
}

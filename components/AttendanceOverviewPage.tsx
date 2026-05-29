"use client";

import { useState, useEffect, useCallback, useMemo, type ReactNode } from "react";
import {
  Calendar,
  Download,
  Loader2,
  RefreshCw,
  Filter,
  CheckCircle,
  AlertCircle,
  XCircle,
  Users,
  Wifi,
  WifiOff,
  Check,
  Minus,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { exportCSV } from "@/lib/csvUtils";
import { useCurrentEmployee } from "@/lib/useCurrentEmployee";
import DatePicker from "@/components/DatePicker";
import { todayYmd, firstOfMonthYmd } from "@/lib/dateUtils";
import EmployeeAttendanceDetailModal from "@/components/EmployeeAttendanceDetailModal";

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

type ProgressStatus = "working" | "away" | "completed" | "absent_today";

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

// 진행 상태 라벨
function progressLabel(s: ProgressStatus): string {
  switch (s) {
    case "working":
      return "근무중";
    case "away":
      return "자리비움";
    case "completed":
      return "완료";
    case "absent_today":
      return "미출근";
  }
}

// 진행 상태 점 색상
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
  }
}

// 진행 상태 배지 클래스
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
 * 진행 상태 판정 — autoStatus가 NULL인 옛날 데이터 보호.
 * - autoStatus='working' → '근무중' (실시간 사이클에서 채워지는 값)
 * - check_in + check_out 다 있으면 → '완료' (autoStatus 무관, 옛날 데이터 보호)
 * - check_in만 있으면 → '근무중' (퇴근 미확정)
 * - autoStatus='absent'면 → '미출근'
 * - 그 외 (데이터 없음) → '미출근'
 */
function progressFromRow(row: {
  checkIn: string | null;
  checkOut: string | null;
  autoStatus: string | null;
}): string {
  if (row.autoStatus === "working") return "근무중";
  if (row.checkIn && row.checkOut) return "완료";
  if (row.checkIn) return "근무중";
  if (row.autoStatus === "absent") return "미출근";
  return "미출근";
}

// 직원 카드/표의 "마지막 활동" 한 줄 (아이콘 + 정보)
function renderActivityInfo(r: RealtimeRow): ReactNode {
  switch (r.progressStatus) {
    case "working":
      return (
        <span className="inline-flex items-center gap-1 flex-wrap">
          <Wifi size={12} className="text-emerald-500 shrink-0" />
          {r.latestLocation ?? "위치 미상"} ·{" "}
          {formatRelativeTime(r.latestCheckedAt)} 연결
          {r.todayCheckIn ? ` · 첫 출근 ${formatTime(r.todayCheckIn)}` : ""}
        </span>
      );
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
  }
}

// 섹션 3 "마지막 활동" 짧은 텍스트 (모바일)
function renderActivityShort(r: RealtimeRow): string {
  switch (r.progressStatus) {
    case "working":
      return `${formatTime(r.latestCheckedAt)} 연결`;
    case "away":
      return `${formatTime(r.latestCheckedAt)} 끊김`;
    case "completed":
      return `${formatTime(r.todayCheckOut ?? r.latestCheckedAt)} 퇴근`;
    case "absent_today":
      return "-";
  }
}

// ───────────────────────── 메인 페이지 ─────────────────────────

export default function AttendanceOverviewPage() {
  const { me, isCeo } = useCurrentEmployee();

  // 기간별 조회 상태
  const [startDate, setStartDate] = useState(firstOfMonthYmd());
  const [endDate, setEndDate] = useState(todayYmd());
  const [departmentFilter, setDepartmentFilter] = useState<string>("all");
  const [employeeFilter, setEmployeeFilter] = useState<string>("all");

  const [data, setData] = useState<OverviewResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const [departments, setDepartments] = useState<DeptOption[]>([]);
  const [employees, setEmployees] = useState<EmployeeOption[]>([]);

  // 실시간 현황 (섹션 1, 2, 3 공용)
  const [realtimeData, setRealtimeData] = useState<RealtimeResponse | null>(
    null
  );
  const [realtimeLoading, setRealtimeLoading] = useState(true);

  // 직원별 요약 펼치기/접기 (기본 접힘)
  const [summaryOpen, setSummaryOpen] = useState(false);

  // 직원 클릭 모달
  const [selectedEmployee, setSelectedEmployee] =
    useState<SelectedEmployee | null>(null);

  // 부서 선택 가능 여부: CEO/ADMIN(전체)만. ADMIN(부서지정)은 서버 강제 → UI 숨김
  const canChooseDepartment =
    isCeo || (me?.role === "admin" && me?.departmentId == null);

  // 부서 옵션 로드
  useEffect(() => {
    if (!canChooseDepartment) return;
    (async () => {
      try {
        const res = await fetch("/api/departments?includeInactive=false");
        if (res.ok) setDepartments(await res.json());
      } catch (e) {
        console.error("departments fetch error:", e);
      }
    })();
  }, [canChooseDepartment]);

  // 직원 마스터 로드 (셀렉트 옵션용)
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/employees?includeInactive=false");
        if (res.ok) {
          const list = await res.json();
          setEmployees(
            list.map(
              (e: {
                id: number;
                employeeNo: string | null;
                name: string;
                departmentId: number | null;
                departmentName: string | null;
              }) => ({
                id: e.id,
                employeeNo: e.employeeNo,
                name: e.name,
                departmentId: e.departmentId,
                departmentName: e.departmentName,
              })
            )
          );
        }
      } catch (e) {
        console.error("employees fetch error:", e);
      }
    })();
  }, []);

  // 기간별 조회 fetch (섹션 4)
  const fetchData = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({ startDate, endDate });
      if (canChooseDepartment && departmentFilter !== "all") {
        params.set("departmentId", departmentFilter);
      }
      if (employeeFilter !== "all") {
        params.set("employeeId", employeeFilter);
      }
      const res = await fetch(`/api/attendance/overview?${params}`);
      if (!res.ok) {
        const j = await res.json().catch(() => null);
        setError(j?.error || `조회 실패 (${res.status})`);
        setData(null);
        return;
      }
      setData(await res.json());
    } catch (e) {
      console.error(e);
      setError("네트워크 오류");
    } finally {
      setLoading(false);
    }
  }, [startDate, endDate, departmentFilter, employeeFilter, canChooseDepartment]);

  // 실시간 현황 fetch (섹션 1, 2, 3)
  const fetchRealtime = useCallback(async (silent = false) => {
    if (!silent) setRealtimeLoading(true);
    try {
      const res = await fetch("/api/attendance/realtime");
      if (res.ok) {
        setRealtimeData(await res.json());
      }
    } catch (e) {
      console.error("realtime fetch error:", e);
    } finally {
      setRealtimeLoading(false);
    }
  }, []);

  // 첫 진입: 실시간 + 기간별(이번달) 자동 조회
  useEffect(() => {
    fetchRealtime();
    fetchData();
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
    };
  }, [realtimeData]);

  const workingTotal = counts.working + counts.away;
  const abnormalTotal = counts.late + counts.earlyLeave;

  // 직원별 요약 (섹션 4)
  const summary = useMemo<EmpSummary[]>(() => {
    if (!data) return [];
    const grouped = new Map<number, EmpSummary>();
    for (const r of data.rows) {
      if (!grouped.has(r.employeeId)) {
        grouped.set(r.employeeId, {
          employeeId: r.employeeId,
          employeeNo: r.employeeNo,
          name: r.name,
          departmentName: r.departmentName,
          positionName: r.positionName,
          attendedDays: 0,
          totalMinutes: 0,
          normalDays: 0,
          lateDays: 0,
          earlyLeaveDays: 0,
          absentDays: 0,
        });
      }
      const g = grouped.get(r.employeeId)!;
      if (r.checkIn) g.attendedDays += 1;
      if (r.workMinutes !== null) g.totalMinutes += r.workMinutes;
      if (r.autoStatus === "normal") g.normalDays += 1;
      else if (r.autoStatus === "late") g.lateDays += 1;
      else if (r.autoStatus === "early_leave") g.earlyLeaveDays += 1;
      else if (r.autoStatus === "absent") g.absentDays += 1;
    }
    return Array.from(grouped.values()).sort((a, b) =>
      a.employeeNo.localeCompare(b.employeeNo)
    );
  }, [data]);

  // 기간별 전체 통계 (섹션 4 카드)
  const totals = useMemo(() => {
    return summary.reduce(
      (acc, s) => ({
        attended: acc.attended + s.attendedDays,
        normal: acc.normal + s.normalDays,
        late: acc.late + s.lateDays,
        absent: acc.absent + s.absentDays,
      }),
      { attended: 0, normal: 0, late: 0, absent: 0 }
    );
  }, [summary]);

  // CSV: 사번, 이름, 부서, 날짜, 출근, 퇴근, 근무시간, 진행, 평가
  const handleExportCSV = () => {
    if (!data || data.rows.length === 0) return;
    exportCSV(
      ["사번", "이름", "부서", "날짜", "출근", "퇴근", "근무시간", "진행", "평가"],
      data.rows.map((r) => [
        r.employeeNo,
        r.name,
        r.departmentName ?? "",
        r.workDate,
        r.checkIn ? formatTime(r.checkIn) : "",
        r.checkOut ? formatTime(r.checkOut) : "",
        formatWorkMinutes(r.workMinutes),
        progressFromRow(r),
        evalLabel(r.autoStatus, !!r.checkOut),
      ]),
      `출퇴근_${startDate}_${endDate}.csv`
    );
  };

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
            onClick={handleExportCSV}
            disabled={!data || data.rows.length === 0}
            className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium bg-white border border-gray-200 text-gray-600 rounded-xl hover:bg-gray-50 disabled:opacity-40"
          >
            <Download size={14} />
            CSV
          </button>
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

      {/* ───── 섹션 1: 지금 (요약 카드 4개) ───── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
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
                {/* 상태 점 */}
                <span
                  className={`w-2.5 h-2.5 rounded-full shrink-0 ${progressDotColor(
                    r.progressStatus
                  )} ${r.progressStatus === "working" ? "animate-pulse" : ""}`}
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

                {/* 상태 배지 */}
                <span className={progressBadgeClass(r.progressStatus)}>
                  {progressLabel(r.progressStatus)}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* ───── 섹션 3: 오늘 출퇴근 상세 (표 / 모바일 카드) ───── */}
      <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
        <div className="px-5 py-3 border-b border-gray-100 bg-gray-50">
          <h3 className="text-sm font-bold text-gray-900">오늘 출퇴근 상세</h3>
        </div>

        {realtimeRows.length === 0 ? (
          <div className="px-5 py-12 text-center text-sm text-gray-400">
            <Calendar size={32} className="mx-auto mb-2 text-gray-300" />
            표시할 데이터가 없습니다
          </div>
        ) : (
          <>
            {/* 데스크탑 테이블 */}
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="bg-white border-b border-gray-100">
                    <th className="text-left text-xs font-semibold text-gray-500 px-5 py-3">
                      직원
                    </th>
                    <th className="text-left text-xs font-semibold text-gray-500 px-5 py-3">
                      첫 출근
                    </th>
                    <th className="text-left text-xs font-semibold text-gray-500 px-5 py-3">
                      마지막 활동
                    </th>
                    <th className="text-right text-xs font-semibold text-gray-500 px-5 py-3">
                      근무시간
                    </th>
                    <th className="text-center text-xs font-semibold text-gray-500 px-5 py-3">
                      진행
                    </th>
                    <th className="text-center text-xs font-semibold text-gray-500 px-5 py-3">
                      평가
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {realtimeRows.map((r) => (
                    <tr
                      key={r.employeeId}
                      className="border-b border-gray-50 hover:bg-blue-50/30 cursor-pointer"
                      onClick={() =>
                        setSelectedEmployee({
                          id: r.employeeId,
                          name: r.name,
                          departmentName: r.departmentName,
                          positionName: r.positionName,
                        })
                      }
                    >
                      <td className="px-5 py-3">
                        <div className="text-sm font-semibold text-gray-900">
                          {r.name}
                        </div>
                        <div className="text-xs text-gray-400">
                          {r.employeeNo || "-"} · {r.departmentName ?? "-"}
                        </div>
                      </td>
                      <td className="px-5 py-3 text-sm text-gray-900 font-mono">
                        {formatTime(r.todayCheckIn)}
                      </td>
                      <td className="px-5 py-3 text-sm font-mono">
                        {r.progressStatus === "working" ? (
                          <span className="text-emerald-600">
                            {formatTime(r.latestCheckedAt)} 연결
                          </span>
                        ) : r.progressStatus === "away" ? (
                          <span className="text-amber-600">
                            {formatTime(r.latestCheckedAt)} 끊김
                          </span>
                        ) : r.progressStatus === "completed" ? (
                          <span className="text-gray-700">
                            {formatTime(r.todayCheckOut ?? r.latestCheckedAt)}{" "}
                            퇴근
                          </span>
                        ) : (
                          <span className="text-gray-300">-</span>
                        )}
                      </td>
                      <td className="px-5 py-3 text-sm text-gray-900 font-mono text-right">
                        {formatWorkMinutes(r.todayWorkMinutes)}
                      </td>
                      <td className="px-5 py-3 text-center">
                        <span className={progressBadgeClass(r.progressStatus)}>
                          {progressLabel(r.progressStatus)}
                        </span>
                      </td>
                      <td className="px-5 py-3 text-center">
                        {r.todayAutoStatus && r.todayAutoStatus !== "working" ? (
                          <span
                            className={`text-sm font-medium ${evalColor(
                              r.todayAutoStatus,
                              !!r.todayCheckOut
                            )}`}
                          >
                            {evalLabel(r.todayAutoStatus, !!r.todayCheckOut)}
                          </span>
                        ) : (
                          <span className="text-sm text-gray-300">-</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* 모바일 카드 */}
            <div className="md:hidden divide-y divide-gray-50">
              {realtimeRows.map((r) => (
                <div
                  key={r.employeeId}
                  className="px-4 py-3 space-y-1"
                  onClick={() =>
                    setSelectedEmployee({
                      id: r.employeeId,
                      name: r.name,
                      departmentName: r.departmentName,
                      positionName: r.positionName,
                    })
                  }
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-sm font-semibold text-gray-900 truncate">
                      {r.name}
                    </span>
                    <span className={progressBadgeClass(r.progressStatus)}>
                      {progressLabel(r.progressStatus)}
                    </span>
                  </div>
                  <div className="text-xs text-gray-500 space-y-0.5">
                    <div>첫 출근 {formatTime(r.todayCheckIn)}</div>
                    <div>마지막 {renderActivityShort(r)}</div>
                    {r.todayWorkMinutes != null && (
                      <div>근무 {formatWorkMinutes(r.todayWorkMinutes)}</div>
                    )}
                    {r.todayAutoStatus && r.todayAutoStatus !== "working" && (
                      <div>
                        평가:{" "}
                        <span
                          className={evalColor(
                            r.todayAutoStatus,
                            !!r.todayCheckOut
                          )}
                        >
                          {evalLabel(r.todayAutoStatus, !!r.todayCheckOut)}
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {/* ───── 섹션 4: 기간별 조회 ───── */}
      <div className="space-y-4">
        {/* 필터 바 */}
        <div className="bg-white rounded-2xl border border-gray-100 p-4 space-y-3">
          <div className="flex items-center gap-2 text-sm font-semibold text-gray-700">
            <Filter size={14} />
            기간별 조회
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
            <div>
              <label className="block text-xs font-semibold text-gray-500 mb-1">
                시작일
              </label>
              <DatePicker
                value={startDate}
                placeholder="시작일 선택"
                onChange={(val) => setStartDate(val)}
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-gray-500 mb-1">
                종료일
              </label>
              <DatePicker
                value={endDate}
                min={startDate}
                placeholder="종료일 선택"
                onChange={(val) => setEndDate(val)}
              />
            </div>
            {canChooseDepartment && (
              <div>
                <label className="block text-xs font-semibold text-gray-500 mb-1">
                  부서
                </label>
                <select
                  value={departmentFilter}
                  onChange={(e) => {
                    setDepartmentFilter(e.target.value);
                    setEmployeeFilter("all");
                  }}
                  className="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm bg-white focus:ring-2 focus:ring-blue-500 outline-none"
                >
                  <option value="all">전체 부서</option>
                  {departments.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div>
              <label className="block text-xs font-semibold text-gray-500 mb-1">
                직원
              </label>
              <select
                value={employeeFilter}
                onChange={(e) => setEmployeeFilter(e.target.value)}
                className="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm bg-white focus:ring-2 focus:ring-blue-500 outline-none"
              >
                <option value="all">전체 직원</option>
                {employees
                  .filter((emp) => {
                    if (!canChooseDepartment) return true;
                    if (departmentFilter === "all") return true;
                    return String(emp.departmentId) === departmentFilter;
                  })
                  .map((emp) => (
                    <option key={emp.id} value={emp.id}>
                      {emp.name}
                      {emp.employeeNo && ` (${emp.employeeNo})`}
                    </option>
                  ))}
              </select>
            </div>
            <div className="flex items-end">
              <button
                onClick={() => fetchData()}
                disabled={loading}
                className="w-full px-4 py-2.5 text-sm font-bold text-white bg-blue-500 rounded-xl hover:bg-blue-600 disabled:opacity-60"
              >
                조회
              </button>
            </div>
          </div>
        </div>

        {/* 통계 카드 4개 */}
        {data && data.rows.length > 0 && (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
            <div className="bg-white rounded-2xl border border-gray-100 p-4 sm:p-5">
              <div className="flex items-start justify-between mb-3">
                <div className="w-10 h-10 rounded-xl flex items-center justify-center bg-blue-100">
                  <Calendar size={18} className="text-blue-600" />
                </div>
              </div>
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
                총 출근일
              </p>
              <p className="mt-1 text-2xl sm:text-3xl font-bold text-gray-900 font-mono">
                {totals.attended}
              </p>
              <p className="text-xs text-gray-400 mt-1">출근 기록 일수</p>
            </div>
            <div className="bg-white rounded-2xl border border-gray-100 p-4 sm:p-5">
              <div className="flex items-start justify-between mb-3">
                <div className="w-10 h-10 rounded-xl flex items-center justify-center bg-emerald-100">
                  <CheckCircle size={18} className="text-emerald-600" />
                </div>
              </div>
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
                정상
              </p>
              <p className="mt-1 text-2xl sm:text-3xl font-bold text-gray-900 font-mono">
                {totals.normal}
              </p>
              <p className="text-xs text-gray-400 mt-1">정상 출근 일수</p>
            </div>
            <div className="bg-white rounded-2xl border border-gray-100 p-4 sm:p-5">
              <div className="flex items-start justify-between mb-3">
                <div className="w-10 h-10 rounded-xl flex items-center justify-center bg-amber-100">
                  <AlertCircle size={18} className="text-amber-600" />
                </div>
              </div>
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
                지각
              </p>
              <p className="mt-1 text-2xl sm:text-3xl font-bold text-gray-900 font-mono">
                {totals.late}
              </p>
              <p className="text-xs text-gray-400 mt-1">출근 시각 늦음</p>
            </div>
            <div className="bg-white rounded-2xl border border-gray-100 p-4 sm:p-5">
              <div className="flex items-start justify-between mb-3">
                <div className="w-10 h-10 rounded-xl flex items-center justify-center bg-gray-100">
                  <XCircle size={18} className="text-gray-500" />
                </div>
              </div>
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
                결근
              </p>
              <p className="mt-1 text-2xl sm:text-3xl font-bold text-gray-900 font-mono">
                {totals.absent}
              </p>
              <p className="text-xs text-gray-400 mt-1">출퇴근 기록 없음</p>
            </div>
          </div>
        )}

        {/* 직원별 요약 (펼치기/접기) */}
        {data && summary.length > 0 && (
          <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
            <button
              onClick={() => setSummaryOpen((o) => !o)}
              className="w-full px-5 py-3 border-b border-gray-200 bg-gray-50 hover:bg-gray-100 transition-colors flex items-center justify-between text-left"
            >
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-bold text-gray-900">직원별 요약</h3>
                <span className="text-sm text-gray-500">
                  ({summary.length}명)
                </span>
                <span className="text-xs text-gray-400 ml-1">
                  — {summaryOpen ? "클릭하여 접기" : "클릭하여 펼치기"}
                </span>
              </div>
              {summaryOpen ? (
                <ChevronUp size={18} className="text-gray-600" />
              ) : (
                <ChevronDown size={18} className="text-gray-600" />
              )}
            </button>

            {summaryOpen && (
              <>
                {/* 데스크탑 테이블 */}
                <div className="hidden md:block overflow-x-auto">
                  <table className="w-full">
                    <thead>
                      <tr className="bg-white border-b border-gray-100">
                        <th className="text-left text-xs font-semibold text-gray-500 px-5 py-3">
                          사번
                        </th>
                        <th className="text-left text-xs font-semibold text-gray-500 px-5 py-3">
                          이름
                        </th>
                        <th className="text-left text-xs font-semibold text-gray-500 px-5 py-3">
                          부서
                        </th>
                        <th className="text-right text-xs font-semibold text-gray-500 px-5 py-3">
                          출근일
                        </th>
                        <th className="text-right text-xs font-semibold text-gray-500 px-5 py-3">
                          누적 근무
                        </th>
                        <th className="text-center text-xs font-semibold text-emerald-600 px-3 py-3">
                          정상
                        </th>
                        <th className="text-center text-xs font-semibold text-amber-600 px-3 py-3">
                          지각
                        </th>
                        <th className="text-center text-xs font-semibold text-rose-600 px-3 py-3">
                          조퇴
                        </th>
                        <th className="text-center text-xs font-semibold text-gray-500 px-3 py-3">
                          결근
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {summary.map((s) => (
                        <tr
                          key={s.employeeId}
                          className="border-b border-gray-50 hover:bg-blue-50/30 cursor-pointer"
                          onClick={() =>
                            setSelectedEmployee({
                              id: s.employeeId,
                              name: s.name,
                              departmentName: s.departmentName,
                              positionName: s.positionName,
                            })
                          }
                          title="클릭하여 최근 30일 상세 보기"
                        >
                          <td className="px-5 py-3 text-sm text-gray-900 font-mono">
                            {s.employeeNo}
                          </td>
                          <td className="px-5 py-3 text-sm font-semibold text-gray-900">
                            {s.name}
                          </td>
                          <td className="px-5 py-3 text-sm text-gray-500">
                            {s.departmentName ?? "-"}
                          </td>
                          <td className="px-5 py-3 text-sm text-gray-900 font-mono text-right">
                            {s.attendedDays}일
                          </td>
                          <td className="px-5 py-3 text-sm text-gray-900 font-mono text-right">
                            {formatWorkMinutes(s.totalMinutes)}
                          </td>
                          <td className="px-3 py-3 text-sm font-mono text-center text-emerald-700">
                            {s.normalDays || "-"}
                          </td>
                          <td className="px-3 py-3 text-sm font-mono text-center text-amber-700">
                            {s.lateDays || "-"}
                          </td>
                          <td className="px-3 py-3 text-sm font-mono text-center text-rose-700">
                            {s.earlyLeaveDays || "-"}
                          </td>
                          <td className="px-3 py-3 text-sm font-mono text-center text-gray-500">
                            {s.absentDays || "-"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* 모바일 카드 */}
                <div className="md:hidden divide-y divide-gray-50">
                  {summary.map((s) => (
                    <div
                      key={s.employeeId}
                      className="px-4 py-3 space-y-1.5 cursor-pointer"
                      onClick={() =>
                        setSelectedEmployee({
                          id: s.employeeId,
                          name: s.name,
                          departmentName: s.departmentName,
                          positionName: s.positionName,
                        })
                      }
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="text-sm font-semibold text-gray-900 truncate">
                            {s.name}
                          </span>
                          <span className="text-xs text-gray-400 font-mono shrink-0">
                            {s.employeeNo}
                          </span>
                        </div>
                        <span className="text-xs text-gray-500 font-mono shrink-0">
                          {s.attendedDays}일 · {formatWorkMinutes(s.totalMinutes)}
                        </span>
                      </div>
                      <p className="text-xs text-gray-400">
                        {s.departmentName ?? "(부서 없음)"}
                      </p>
                      <div className="flex gap-2 text-[11px] font-mono">
                        {s.normalDays > 0 && (
                          <span className="text-emerald-700">
                            정상 {s.normalDays}
                          </span>
                        )}
                        {s.lateDays > 0 && (
                          <span className="text-amber-700">
                            지각 {s.lateDays}
                          </span>
                        )}
                        {s.earlyLeaveDays > 0 && (
                          <span className="text-rose-700">
                            조퇴 {s.earlyLeaveDays}
                          </span>
                        )}
                        {s.absentDays > 0 && (
                          <span className="text-gray-500">
                            결근 {s.absentDays}
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        )}

        {/* 일자별 상세 */}
        <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
          <div className="px-5 py-3 border-b border-gray-100 bg-gray-50 flex items-center justify-between">
            <h3 className="text-sm font-bold text-gray-900">일자별 상세</h3>
            {data && (
              <span className="text-xs text-gray-500">{data.rows.length}건</span>
            )}
          </div>

          {error && (
            <div className="px-5 py-4 text-sm text-rose-600 bg-rose-50">
              {error}
            </div>
          )}

          {loading ? (
            <div className="flex items-center justify-center h-32">
              <Loader2 size={24} className="animate-spin text-blue-500" />
              <span className="ml-2 text-sm text-gray-500">로딩 중...</span>
            </div>
          ) : !data || data.rows.length === 0 ? (
            <div className="px-5 py-12 text-center text-sm text-gray-400">
              <Calendar size={32} className="mx-auto mb-2 text-gray-300" />
              조회된 출퇴근 기록이 없습니다
            </div>
          ) : (
            <>
              {/* 데스크탑 테이블 */}
              <div className="hidden md:block overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="bg-white border-b border-gray-100">
                      <th className="text-left text-xs font-semibold text-gray-500 px-5 py-3">
                        날짜
                      </th>
                      <th className="text-left text-xs font-semibold text-gray-500 px-5 py-3">
                        직원
                      </th>
                      <th className="text-left text-xs font-semibold text-gray-500 px-5 py-3">
                        출근
                      </th>
                      <th className="text-left text-xs font-semibold text-gray-500 px-5 py-3">
                        퇴근
                      </th>
                      <th className="text-right text-xs font-semibold text-gray-500 px-5 py-3">
                        근무
                      </th>
                      <th className="text-center text-xs font-semibold text-gray-500 px-5 py-3">
                        진행
                      </th>
                      <th className="text-center text-xs font-semibold text-gray-500 px-5 py-3">
                        평가
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.rows.map((r, idx) => (
                      <tr
                        key={`${r.employeeId}-${r.workDate}-${idx}`}
                        className="border-b border-gray-50 hover:bg-blue-50/30"
                      >
                        <td className="px-5 py-3 text-sm text-gray-500 font-mono">
                          {r.workDate}
                        </td>
                        <td className="px-5 py-3">
                          <div className="text-sm font-semibold text-gray-900">
                            {r.name}
                          </div>
                          <div className="text-xs text-gray-400">
                            {r.employeeNo || "-"} · {r.departmentName ?? "-"}
                          </div>
                        </td>
                        <td className="px-5 py-3 text-sm text-gray-900 font-mono">
                          {formatTime(r.checkIn)}
                        </td>
                        <td className="px-5 py-3 text-sm text-gray-900 font-mono">
                          {formatTime(r.checkOut)}
                        </td>
                        <td className="px-5 py-3 text-sm text-gray-900 font-mono text-right">
                          {formatWorkMinutes(r.workMinutes)}
                        </td>
                        <td className="px-5 py-3 text-center text-sm text-gray-700">
                          {progressFromRow(r)}
                        </td>
                        <td className="px-5 py-3 text-center">
                          <div className="inline-flex items-center gap-1">
                            <span
                              className={`text-sm font-medium ${evalColor(
                                r.autoStatus,
                                !!r.checkOut
                              )}`}
                            >
                              {evalLabel(r.autoStatus, !!r.checkOut)}
                            </span>
                            {r.isOverridden && (
                              <span className="text-[10px] font-semibold text-amber-700 bg-amber-50 px-1.5 py-0.5 rounded-full">
                                수동
                              </span>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* 모바일 카드 */}
              <div className="md:hidden divide-y divide-gray-50">
                {data.rows.map((r, idx) => (
                  <div
                    key={`${r.employeeId}-${r.workDate}-${idx}`}
                    className="px-4 py-3 space-y-1.5"
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-sm font-semibold text-gray-900 truncate">
                          {r.name}
                        </span>
                        <span className="text-xs text-gray-400 font-mono shrink-0">
                          {r.employeeNo}
                        </span>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <span
                          className={`text-xs font-medium ${evalColor(
                            r.autoStatus,
                            !!r.checkOut
                          )}`}
                        >
                          {evalLabel(r.autoStatus, !!r.checkOut)}
                        </span>
                        {r.isOverridden && (
                          <span className="text-[10px] font-semibold text-amber-700 bg-amber-50 px-1.5 py-0.5 rounded-full">
                            수동
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-gray-500 font-mono">
                        {r.workDate}
                      </span>
                      <span className="text-gray-500">
                        {progressFromRow(r)}
                      </span>
                    </div>
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-gray-900 font-mono">
                        {formatTime(r.checkIn)} - {formatTime(r.checkOut)}
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
        </div>
      </div>

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

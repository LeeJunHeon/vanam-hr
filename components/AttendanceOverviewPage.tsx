"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import {
  Calendar,
  Download,
  Loader2,
  RefreshCw,
  Filter,
  CheckCircle,
  AlertCircle,
  XCircle,
} from "lucide-react";
import { exportCSV } from "@/lib/csvUtils";
import { useCurrentEmployee } from "@/lib/useCurrentEmployee";

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

function formatTime(iso: string | null): string {
  if (!iso) return "-";
  const d = new Date(iso);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

function formatWorkMinutes(min: number | null): string {
  if (min === null) return "-";
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h === 0) return `${m}분`;
  if (m === 0) return `${h}시간`;
  return `${h}시간 ${m}분`;
}

function StatusBadge({ status }: { status: string | null }) {
  if (!status) return <span className="text-xs text-gray-300">-</span>;
  const config: Record<string, { label: string; cls: string }> = {
    normal: { label: "정상", cls: "bg-emerald-50 text-emerald-700" },
    late: { label: "지각", cls: "bg-amber-50 text-amber-700" },
    early_leave: { label: "조퇴", cls: "bg-rose-50 text-rose-700" },
    absent: { label: "결근", cls: "bg-gray-100 text-gray-500" },
  };
  const c = config[status] ?? {
    label: status,
    cls: "bg-gray-100 text-gray-500",
  };
  return (
    <span
      className={`inline-flex text-xs font-semibold px-2 py-0.5 rounded-full ${c.cls}`}
    >
      {c.label}
    </span>
  );
}

function todayStr() {
  return new Date().toISOString().split("T")[0];
}

function firstOfMonthStr() {
  const d = new Date();
  d.setDate(1);
  return d.toISOString().split("T")[0];
}

export default function AttendanceOverviewPage() {
  const { me, isCeo } = useCurrentEmployee();

  const [startDate, setStartDate] = useState(firstOfMonthStr());
  const [endDate, setEndDate] = useState(todayStr());
  const [departmentFilter, setDepartmentFilter] = useState<string>("all");
  const [employeeFilter, setEmployeeFilter] = useState<string>("all");

  const [data, setData] = useState<OverviewResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");

  const [departments, setDepartments] = useState<DeptOption[]>([]);
  const [employees, setEmployees] = useState<EmployeeOption[]>([]);

  // 부서 옵션 로드 (CEO/ADMIN_전체만 의미 있음)
  // ADMIN_부서지정은 본인 부서로 강제됨 (필터 UI는 숨김)
  const canChooseDepartment = isCeo || (me?.role === "admin" && me?.departmentId == null);

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
          const data = await res.json();
          setEmployees(
            data.map((e: {
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
            }))
          );
        }
      } catch (e) {
        console.error("employees fetch error:", e);
      }
    })();
  }, []);

  const fetchData = useCallback(
    async (showRefresh = false) => {
      if (showRefresh) setRefreshing(true);
      else setLoading(true);
      setError("");
      try {
        const params = new URLSearchParams({
          startDate,
          endDate,
        });
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
        setRefreshing(false);
      }
    },
    [startDate, endDate, departmentFilter, employeeFilter, canChooseDepartment]
  );

  useEffect(() => {
    fetchData();
    // 처음 1회만 자동 fetch. 이후는 사용자가 명시적으로 조회 버튼 누름.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 직원별 요약 (총 출근일수, 총 근무시간)
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

  // 전체 통계 (모든 직원 합계)
  const totals = useMemo(() => {
    return summary.reduce(
      (acc, s) => ({
        normal: acc.normal + s.normalDays,
        late: acc.late + s.lateDays,
        earlyLeave: acc.earlyLeave + s.earlyLeaveDays,
        absent: acc.absent + s.absentDays,
      }),
      { normal: 0, late: 0, earlyLeave: 0, absent: 0 }
    );
  }, [summary]);

  const handleExportCSV = () => {
    if (!data || data.rows.length === 0) return;
    exportCSV(
      [
        "사번",
        "이름",
        "부서",
        "직급",
        "날짜",
        "출근",
        "퇴근",
        "근무시간",
        "상태",
        "관리자수정",
      ],
      data.rows.map((r) => [
        r.employeeNo,
        r.name,
        r.departmentName ?? "",
        r.positionName ?? "",
        r.workDate,
        r.checkIn ? formatTime(r.checkIn) : "",
        r.checkOut ? formatTime(r.checkOut) : "",
        r.workMinutes !== null ? String(r.workMinutes) : "",
        r.autoStatus ?? "",
        r.isOverridden ? "Y" : "",
      ]),
      `출퇴근_${startDate}_${endDate}.csv`
    );
  };

  return (
    <div className="p-4 sm:p-6 space-y-5">
      {/* 헤더 */}
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-3">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold text-gray-900">
            전체 근태 조회
          </h1>
          <p className="text-sm text-gray-500 mt-0.5">
            {data?.scope === "all"
              ? "전체 직원 출퇴근 기록을 조회합니다"
              : data?.scope === "department"
              ? "본인 부서 직원 출퇴근 기록을 조회합니다"
              : "직원 출퇴근 기록을 조회합니다"}
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
            onClick={() => fetchData(true)}
            disabled={refreshing}
            className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium bg-white border border-gray-200 text-gray-600 rounded-xl hover:bg-gray-50 disabled:opacity-40"
          >
            <RefreshCw
              size={14}
              className={refreshing ? "animate-spin" : ""}
            />
            새로고침
          </button>
        </div>
      </div>

      {/* 필터 */}
      <div className="bg-white rounded-2xl border border-gray-100 p-4 space-y-3">
        <div className="flex items-center gap-2 text-sm font-semibold text-gray-700">
          <Filter size={14} />
          기간 / 부서 / 직원
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
          <div>
            <label className="block text-xs font-semibold text-gray-500 mb-1">
              시작일
            </label>
            <input
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              className="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-blue-500 outline-none"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-gray-500 mb-1">
              종료일
            </label>
            <input
              type="date"
              value={endDate}
              min={startDate}
              onChange={(e) => setEndDate(e.target.value)}
              className="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-blue-500 outline-none"
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
                  setEmployeeFilter("all"); // 부서 바꾸면 직원 필터 리셋
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
                  if (!canChooseDepartment) return true; // ADMIN 부서지정은 서버에서 강제
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

      {/* 이상 통계 카드 4개 */}
      {data && data.rows.length > 0 && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
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
              <div className="w-10 h-10 rounded-xl flex items-center justify-center bg-rose-100">
                <AlertCircle size={18} className="text-rose-600" />
              </div>
            </div>
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
              조퇴
            </p>
            <p className="mt-1 text-2xl sm:text-3xl font-bold text-gray-900 font-mono">
              {totals.earlyLeave}
            </p>
            <p className="text-xs text-gray-400 mt-1">근무시간 부족</p>
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

      {/* 직원별 요약 */}
      {data && summary.length > 0 && (
        <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
          <div className="px-5 py-3 border-b border-gray-100 bg-gray-50">
            <h3 className="text-sm font-bold text-gray-900">
              직원별 요약 ({summary.length}명)
            </h3>
          </div>

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
                    onClick={() => setEmployeeFilter(String(s.employeeId))}
                    title="클릭하여 이 직원만 필터링"
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
                onClick={() => setEmployeeFilter(String(s.employeeId))}
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
                    <span className="text-emerald-700">정상 {s.normalDays}</span>
                  )}
                  {s.lateDays > 0 && (
                    <span className="text-amber-700">지각 {s.lateDays}</span>
                  )}
                  {s.earlyLeaveDays > 0 && (
                    <span className="text-rose-700">조퇴 {s.earlyLeaveDays}</span>
                  )}
                  {s.absentDays > 0 && (
                    <span className="text-gray-500">결근 {s.absentDays}</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 일자별 상세 */}
      <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
        <div className="px-5 py-3 border-b border-gray-100 bg-gray-50 flex items-center justify-between">
          <h3 className="text-sm font-bold text-gray-900">
            일자별 상세
          </h3>
          {data && (
            <span className="text-xs text-gray-500">
              {data.rows.length}건
            </span>
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
                      사번
                    </th>
                    <th className="text-left text-xs font-semibold text-gray-500 px-5 py-3">
                      이름
                    </th>
                    <th className="text-left text-xs font-semibold text-gray-500 px-5 py-3">
                      부서
                    </th>
                    <th className="text-left text-xs font-semibold text-gray-500 px-5 py-3">
                      출근
                    </th>
                    <th className="text-left text-xs font-semibold text-gray-500 px-5 py-3">
                      퇴근
                    </th>
                    <th className="text-right text-xs font-semibold text-gray-500 px-5 py-3">
                      근무시간
                    </th>
                    <th className="text-center text-xs font-semibold text-gray-500 px-5 py-3">
                      상태
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
                      <td className="px-5 py-3 text-sm text-gray-500 font-mono">
                        {r.employeeNo}
                      </td>
                      <td className="px-5 py-3 text-sm font-semibold text-gray-900">
                        {r.name}
                      </td>
                      <td className="px-5 py-3 text-sm text-gray-500">
                        {r.departmentName ?? "-"}
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
                      <td className="px-5 py-3 text-center">
                        <div className="inline-flex items-center gap-1">
                          <StatusBadge status={r.autoStatus} />
                          {r.isOverridden && (
                            <span className="text-xs font-semibold text-amber-700 bg-amber-50 px-2 py-0.5 rounded-full">
                              수동수정
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
                      <StatusBadge status={r.autoStatus} />
                      {r.isOverridden && (
                        <span className="text-[10px] font-semibold text-amber-700 bg-amber-50 px-1.5 py-0.5 rounded-full">
                          수동
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-gray-500 font-mono">{r.workDate}</span>
                    <span className="text-gray-500">{r.departmentName ?? "-"}</span>
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
  );
}

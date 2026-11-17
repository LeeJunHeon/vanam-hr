"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import { ChevronLeft, ChevronRight, Loader2, Users, X } from "lucide-react";
import MonthPicker from "@/components/MonthPicker";
import DatePicker from "@/components/DatePicker";
import ExcelButton from "@/components/ExcelButton";
import { renderTimeCell } from "@/components/AttendanceTimeCell";
import { todayYmd } from "@/lib/dateUtils";
import { exportExcel } from "@/lib/excelUtils";
import { writePageQuery } from "@/lib/launcher";
import {
  addDays,
  addMonths,
  dayCellText,
  dayMinutesText,
  daysInRange,
  monthRange,
  monthWeeks,
  mondayOf,
  parseYm,
  parseYmd,
  periodExcludedText,
  periodTotalText,
  shortMd,
  summarizeDay,
  sumDays,
  weekRange,
  weekdayKo,
  type PeriodTotal,
  type WorkHoursDayRow,
} from "@/lib/work-hours";
import { formatWorkMinutes } from "@/lib/attendanceLabels";

// 전체 근무시간 조회 (관리자 메뉴 work-hours).
// 데이터: GET /api/attendance/work-hours (권한·부서 강제는 서버). 계산: lib/work-hours.
// 주소: /?page=work-hours&view=month&month=2026-11 | &view=week&date=2026-11-16 | &employee=8 | &department=3
//       (화면 상태가 바뀌면 replaceState 로 맞춘다. 다른 메뉴로 가면 lib/launcher 가 이 키들을 지운다)

type View = "month" | "week";

interface Employee {
  id: number;
  name: string;
  departmentName: string | null;
  isActive: boolean;
}

interface ApiResponse {
  range: { startDate: string; endDate: string };
  scope: "all" | "department";
  departmentId: number | null;
  departments: { id: number; name: string }[] | null;
  employees: Employee[];
  detailEmployee: Employee | null;
  rows: WorkHoursDayRow[];
}

interface Column {
  label: string;
  days: string[];
}

interface UrlState {
  view: View;
  month: string;
  date: string;
  employee: number | null;
  department: number | null;
}

function positiveInt(s: string | null): number | null {
  if (!s) return null;
  const n = Number(s);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// 주소 → 화면 상태 (잘못된 값은 기본값으로)
function readUrlState(): UrlState {
  const today = todayYmd();
  const q = new URLSearchParams(typeof window === "undefined" ? "" : window.location.search);
  return {
    view: q.get("view") === "week" ? "week" : "month",
    month: parseYm(q.get("month")) ?? today.slice(0, 7),
    date: parseYmd(q.get("date")) ?? today,
    employee: positiveInt(q.get("employee")),
    department: positiveInt(q.get("department")),
  };
}

const RULE_TEXT =
  "직원별 주간·월간 근무시간 — WiFi 첫 연결~마지막 연결(승인된 근태 정정 반영), 휴게시간 공제 없음, 퇴근 기록 없는 날은 합계 제외";

function TotalText({ t }: { t: PeriodTotal }) {
  const excluded = periodExcludedText(t);
  return (
    <>
      {formatWorkMinutes(t.minutes)}
      {excluded && <div className="text-[11px] font-normal text-gray-400">{excluded}</div>}
    </>
  );
}

function RetiredBadge() {
  return (
    <span className="text-xs font-semibold text-rose-600 bg-rose-50 px-2 py-0.5 rounded-full shrink-0">
      퇴사
    </span>
  );
}

export default function WorkHoursPage() {
  const [initial] = useState(readUrlState);
  const [view, setView] = useState<View>(initial.view);
  const [month, setMonth] = useState(initial.month);
  const [date, setDate] = useState(initial.date);
  const [employeeId, setEmployeeId] = useState<number | null>(initial.employee);
  const [departmentId, setDepartmentId] = useState<number | null>(initial.department);

  // 마지막으로 받은 응답 — 다음 조회 중에도 이전 표를 그대로 보여준다
  const [result, setResult] = useState<{
    key: string;
    data: ApiResponse | null;
    error: string | null;
  } | null>(null);
  const [monthPickerOpen, setMonthPickerOpen] = useState(false);

  const range = useMemo(
    () => (view === "month" ? monthRange(month) : weekRange(date)),
    [view, month, date]
  );

  // 화면 상태 → 주소
  useEffect(() => {
    writePageQuery({
      view,
      month: view === "month" ? month : null,
      date: view === "week" ? date : null,
      employee: employeeId ? String(employeeId) : null,
      department: departmentId ? String(departmentId) : null,
    });
  }, [view, month, date, employeeId, departmentId]);

  const queryKey = useMemo(() => {
    const params = new URLSearchParams({ startDate: range.start, endDate: range.end });
    if (departmentId) params.set("departmentId", String(departmentId));
    if (employeeId) params.set("employeeId", String(employeeId));
    return params.toString();
  }, [range.start, range.end, departmentId, employeeId]);

  useEffect(() => {
    let cancelled = false;
    const fail = "근무시간을 불러오지 못했습니다.";
    fetch(`/api/attendance/work-hours?${queryKey}`)
      .then(async (res) => {
        const json = await res.json().catch(() => null);
        if (cancelled) return;
        setResult(
          res.ok
            ? { key: queryKey, data: json as ApiResponse, error: null }
            : { key: queryKey, data: null, error: json?.error ?? fail }
        );
      })
      .catch(() => {
        if (!cancelled) setResult({ key: queryKey, data: null, error: fail });
      });
    return () => {
      cancelled = true;
    };
  }, [queryKey]);

  const loading = result?.key !== queryKey;
  const data = result?.data ?? null;
  const error = result?.error ?? null;

  // 직원 → 날짜 → 근태 행
  const byEmployee = useMemo(() => {
    const m = new Map<number, Map<string, WorkHoursDayRow>>();
    for (const r of data?.rows ?? []) {
      let inner = m.get(r.employeeId);
      if (!inner) m.set(r.employeeId, (inner = new Map()));
      inner.set(r.workDate, r);
    }
    return m;
  }, [data]);

  // 표 열 — 월별: 그 달의 주(그 달 날짜만), 주별: 월~일
  const columns: Column[] = useMemo(() => {
    if (view === "month") {
      return monthWeeks(month).map((w) => ({
        label: `${w.index}주 (${shortMd(w.start)}~${shortMd(w.end)})`,
        days: daysInRange(w.start, w.end),
      }));
    }
    return daysInRange(range.start, range.end).map((d) => ({
      label: `${weekdayKo(d)} (${shortMd(d)})`,
      days: [d],
    }));
  }, [view, month, range.start, range.end]);
  const totalLabel = view === "month" ? "월 합계" : "주 합계";

  const periodTotal = useCallback(
    (empId: number, days: string[]): PeriodTotal => {
      const rows = byEmployee.get(empId);
      return sumDays(days.map((d) => summarizeDay(rows?.get(d))));
    },
    [byEmployee]
  );
  const allDays = useMemo(() => daysInRange(range.start, range.end), [range.start, range.end]);

  // 칸 글자 (엑셀·휴대폰 카드) — 주별은 하루 칸, 월별은 주 합계
  const cellText = (empId: number, col: Column): string =>
    view === "week"
      ? dayCellText(summarizeDay(byEmployee.get(empId)?.get(col.days[0])))
      : periodTotalText(periodTotal(empId, col.days));
  const totalText = (empId: number): string => periodTotalText(periodTotal(empId, allDays));

  // 표 칸 — 합계는 제외 표시를 작은 둘째 줄로
  const cellNode = (empId: number, col: Column) =>
    view === "week" ? cellText(empId, col) : <TotalText t={periodTotal(empId, col.days)} />;

  const employees = data?.employees ?? [];
  // 표에 있는 직원은 바로, 표 밖 직원(다른 부서 등)은 서버가 돌려준 detailEmployee 로
  const detail = employeeId
    ? (employees.find((e) => e.id === employeeId) ??
      (data?.detailEmployee?.id === employeeId ? data.detailEmployee : null))
    : null;

  // ── 기간 이동 ──
  const goPrev = () =>
    view === "month" ? setMonth(addMonths(month, -1)) : setDate(addDays(mondayOf(date), -7));
  const goNext = () =>
    view === "month" ? setMonth(addMonths(month, 1)) : setDate(addDays(mondayOf(date), 7));
  const goToday = () => {
    const t = todayYmd();
    if (view === "month") setMonth(t.slice(0, 7));
    else setDate(t);
  };
  const switchView = (v: View) => {
    if (v === view) return;
    // 보던 기간을 이어서 — 월별→주별은 그 달 1일(이번 달이면 오늘)의 주, 주별→월별은 그 주 월요일의 달
    if (v === "week") {
      const t = todayYmd();
      setDate(t.slice(0, 7) === month ? t : `${month}-01`);
    } else {
      setMonth(mondayOf(date).slice(0, 7));
    }
    setView(v);
  };

  const periodLabel =
    view === "month"
      ? `${month.slice(0, 4)}년 ${Number(month.slice(5, 7))}월`
      : `${range.start.replace(/-/g, ".")} ~ ${shortMd(range.end)}`;

  // ── 엑셀 — 지금 보고 있는 표 그대로 ──
  const handleExport = async () => {
    if (!data || employees.length === 0) return;
    const headers = ["이름", "부서", ...columns.map((c) => c.label), totalLabel];
    const rows = employees.map((e) => [
      e.isActive ? e.name : `${e.name} (퇴사)`,
      e.departmentName ?? "",
      ...columns.map((c) => cellText(e.id, c)),
      totalText(e.id),
    ]);
    const deptName =
      departmentId && data.departments
        ? data.departments.find((d) => d.id === departmentId)?.name
        : null;
    const period = view === "month" ? `월별_${month}` : `주별_${range.start}~${range.end}`;
    await exportExcel(
      headers,
      rows,
      `근무시간_${period}${deptName ? `_${deptName}` : ""}.xlsx`,
      "근무시간"
    );
  };

  // ── 일별 상세 ──
  const detailDays = useMemo(() => {
    if (!detail) return [];
    const rows = byEmployee.get(detail.id);
    return daysInRange(range.start, range.end).map((d) => {
      const row = rows?.get(d) ?? null;
      return { ymd: d, row, summary: summarizeDay(row) };
    });
  }, [detail, byEmployee, range.start, range.end]);
  const detailTotal = periodTotalText(sumDays(detailDays.map((d) => d.summary)));

  const thCls = "text-xs font-semibold text-gray-500 px-4 py-2.5 whitespace-nowrap";
  const tdCls = "px-4 py-2.5 text-sm";

  return (
    <div className="p-4 sm:p-6 space-y-5">
      {/* ───── 헤더 ───── */}
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-3">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold text-gray-900">전체 근무시간 조회</h1>
          <p className="text-sm text-gray-500 mt-0.5">{RULE_TEXT}</p>
        </div>
        <ExcelButton
          onClick={handleExport}
          disabled={!data || loading || employees.length === 0}
          className="self-start sm:self-auto"
        />
      </div>

      {/* ───── 보기·기간·부서 ───── */}
      <div className="flex flex-col lg:flex-row lg:items-center gap-3">
        <div className="flex gap-1 bg-gray-100 p-1 rounded-xl w-fit">
          {(["month", "week"] as const).map((v) => (
            <button
              key={v}
              onClick={() => switchView(v)}
              className={`px-4 py-2 text-sm font-medium rounded-lg transition-all ${
                view === v ? "bg-white text-blue-600 shadow-sm" : "text-gray-500 hover:text-gray-700"
              }`}
            >
              {v === "month" ? "월별" : "주별"}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={goPrev}
            className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-500"
            aria-label={view === "month" ? "이전 달" : "이전 주"}
          >
            <ChevronLeft size={16} />
          </button>
          {view === "month" ? (
            <button
              onClick={() => setMonthPickerOpen(true)}
              className="font-semibold text-sm sm:text-base px-3 py-1.5 hover:bg-gray-100 rounded-lg min-w-[110px] text-center text-gray-900"
              title="년월 선택"
            >
              {periodLabel}
            </button>
          ) : (
            <>
              <span className="hidden sm:inline font-semibold text-base px-1 text-gray-900 whitespace-nowrap">
                {periodLabel}
              </span>
              <DatePicker
                value={date}
                onChange={(v) => {
                  if (v) setDate(v);
                }}
                className="w-40"
              />
            </>
          )}
          <button
            onClick={goNext}
            className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-500"
            aria-label={view === "month" ? "다음 달" : "다음 주"}
          >
            <ChevronRight size={16} />
          </button>
          <button
            onClick={goToday}
            className="text-xs text-blue-600 hover:text-blue-700 px-2 py-1 rounded hover:bg-blue-50"
            title={view === "month" ? "이번 달로 이동" : "이번 주로 이동"}
          >
            오늘
          </button>
        </div>

        {data?.departments && (
          <select
            value={departmentId ?? "all"}
            onChange={(e) => setDepartmentId(e.target.value === "all" ? null : Number(e.target.value))}
            className="lg:ml-auto px-3 py-2.5 border border-gray-200 rounded-xl text-sm bg-white outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="all">전체 부서</option>
            {data.departments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        )}
      </div>

      {/* ───── 직원별 표 ───── */}
      {loading && !data ? (
        <div className="bg-white rounded-2xl border border-gray-100 flex items-center justify-center h-32">
          <Loader2 size={20} className="animate-spin text-blue-500" />
          <span className="ml-2 text-sm text-gray-500">불러오는 중...</span>
        </div>
      ) : error ? (
        <div className="bg-white rounded-2xl border border-gray-100 px-5 py-6 text-sm text-rose-600">
          {error}
        </div>
      ) : employees.length === 0 ? (
        <div className="bg-white rounded-2xl border border-gray-100 px-5 py-12 text-center">
          <Users size={32} className="mx-auto mb-2 text-gray-300" />
          <p className="text-sm text-gray-400">표시할 직원이 없습니다</p>
        </div>
      ) : (
        <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
          <div className="px-5 py-3 border-b border-gray-100 bg-gray-50 flex items-center justify-between">
            <h3 className="text-sm font-bold text-gray-900">
              {view === "month" ? "월별 근무시간" : "주별 근무시간"}
            </h3>
            <span className="text-xs text-gray-400 flex items-center gap-1.5">
              {loading && <Loader2 size={12} className="animate-spin" />}
              {employees.length}명 · 이름 클릭 시 일별 상세
            </span>
          </div>

          {/* 데스크탑 표 */}
          <div className="hidden md:block overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-100">
                  <th className={`text-left ${thCls}`}>이름</th>
                  <th className={`text-left ${thCls}`}>부서</th>
                  {columns.map((c) => (
                    <th key={c.label} className={`text-right ${thCls}`}>
                      {c.label}
                    </th>
                  ))}
                  <th className={`text-right ${thCls}`}>{totalLabel}</th>
                </tr>
              </thead>
              <tbody>
                {employees.map((e) => (
                  <tr
                    key={e.id}
                    className={`border-b border-gray-50 last:border-0 hover:bg-blue-50/30 ${
                      employeeId === e.id ? "bg-blue-50/40" : ""
                    }`}
                  >
                    <td className={`${tdCls} whitespace-nowrap`}>
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => setEmployeeId(e.id)}
                          className="font-semibold text-gray-900 hover:text-blue-600"
                        >
                          {e.name}
                        </button>
                        {!e.isActive && <RetiredBadge />}
                      </div>
                    </td>
                    <td className={`${tdCls} text-gray-600 whitespace-nowrap`}>
                      {e.departmentName ?? "-"}
                    </td>
                    {columns.map((c) => (
                      <td key={c.label} className={`${tdCls} text-gray-700 text-right whitespace-nowrap`}>
                        {cellNode(e.id, c)}
                      </td>
                    ))}
                    <td className={`${tdCls} text-gray-900 font-semibold text-right whitespace-nowrap`}>
                      <TotalText t={periodTotal(e.id, allDays)} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* 모바일 카드 */}
          <div className="md:hidden divide-y divide-gray-50">
            {employees.map((e) => (
              <button
                key={e.id}
                onClick={() => setEmployeeId(e.id)}
                className="w-full text-left px-4 py-3 space-y-1.5 hover:bg-blue-50/30"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-sm font-semibold text-gray-900 truncate">{e.name}</span>
                    {!e.isActive && <RetiredBadge />}
                  </div>
                  <span className="text-xs text-gray-400 shrink-0">{e.departmentName ?? "-"}</span>
                </div>
                <div className="space-y-0.5">
                  {columns.map((c) => (
                    <div key={c.label} className="flex items-center justify-between text-xs">
                      <span className="text-gray-500">{c.label}</span>
                      <span className="text-gray-700">{cellText(e.id, c)}</span>
                    </div>
                  ))}
                  <div className="flex items-center justify-between text-xs pt-1">
                    <span className="text-gray-700 font-semibold">{totalLabel}</span>
                    <span className="text-gray-900 font-semibold">{totalText(e.id)}</span>
                  </div>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ───── 직원 일별 상세 ───── */}
      {detail && !error && (
        <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
          <div className="px-5 py-3 border-b border-gray-100 bg-gray-50 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <h3 className="text-sm font-bold text-gray-900 truncate">
                {detail.name} 일별 근무시간
              </h3>
              {!detail.isActive && <RetiredBadge />}
              <span className="text-xs text-gray-400 whitespace-nowrap">
                {detail.departmentName ?? ""} · {periodLabel}
              </span>
            </div>
            <button
              onClick={() => setEmployeeId(null)}
              className="p-1.5 rounded-lg hover:bg-gray-100 shrink-0"
              aria-label="닫기"
            >
              <X size={16} className="text-gray-400" />
            </button>
          </div>

          {/* 데스크탑 표 */}
          <div className="hidden md:block overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-100">
                  <th className={`text-left ${thCls}`}>날짜</th>
                  <th className={`text-left ${thCls}`}>출근</th>
                  <th className={`text-left ${thCls}`}>퇴근</th>
                  <th className={`text-right ${thCls}`}>근무</th>
                  <th className={`text-left ${thCls}`}>사유</th>
                </tr>
              </thead>
              <tbody>
                {detailDays.map(({ ymd, row, summary }) => (
                  <tr key={ymd} className="border-b border-gray-50 last:border-0 hover:bg-blue-50/30">
                    <td className={`${tdCls} text-gray-700 font-mono whitespace-nowrap`}>
                      {ymd.slice(5)} ({weekdayKo(ymd)})
                    </td>
                    <td className={`${tdCls} text-gray-900 font-mono whitespace-nowrap`}>
                      {row ? renderTimeCell(row.originalCheckIn, row.checkIn) : "-"}
                    </td>
                    <td className={`${tdCls} text-gray-900 font-mono whitespace-nowrap`}>
                      {row ? renderTimeCell(row.originalCheckOut, row.checkOut, row.workDate) : "-"}
                    </td>
                    <td className={`${tdCls} text-gray-900 font-mono text-right whitespace-nowrap`}>
                      {dayMinutesText(summary)}
                    </td>
                    <td className={`${tdCls} text-gray-600 w-full`}>
                      {summary.notes.length ? summary.notes.join(", ") : <span className="text-gray-300">-</span>}
                    </td>
                  </tr>
                ))}
                <tr className="bg-gray-50 border-t border-gray-100">
                  <td colSpan={3} className={`${tdCls} font-semibold text-gray-700`}>
                    합계
                  </td>
                  <td colSpan={2} className={`${tdCls} font-semibold text-gray-900 whitespace-nowrap`}>
                    {detailTotal}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          {/* 모바일 카드 */}
          <div className="md:hidden divide-y divide-gray-50">
            {detailDays.map(({ ymd, row, summary }) => (
              <div key={ymd} className="px-4 py-3 space-y-1">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-semibold text-gray-900 font-mono">
                    {ymd.slice(5)} ({weekdayKo(ymd)})
                  </span>
                  <span className="text-xs text-gray-700 font-mono font-semibold">
                    {dayMinutesText(summary)}
                  </span>
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-gray-900 font-mono">
                    {row ? (
                      <>
                        {renderTimeCell(row.originalCheckIn, row.checkIn)} ~{" "}
                        {renderTimeCell(row.originalCheckOut, row.checkOut, row.workDate)}
                      </>
                    ) : (
                      "-"
                    )}
                  </span>
                  {summary.notes.length > 0 && (
                    <span className="text-gray-600 truncate ml-2">{summary.notes.join(", ")}</span>
                  )}
                </div>
              </div>
            ))}
            <div className="px-4 py-3 flex items-center justify-between text-sm bg-gray-50">
              <span className="font-semibold text-gray-700">합계</span>
              <span className="font-semibold text-gray-900">{detailTotal}</span>
            </div>
          </div>
        </div>
      )}

      {monthPickerOpen && (
        <MonthPicker
          value={month}
          onChange={(ym) => setMonth(ym)}
          onClose={() => setMonthPickerOpen(false)}
        />
      )}
    </div>
  );
}

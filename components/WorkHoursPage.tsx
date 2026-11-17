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
  periodMinutesText,
  periodRemarkText,
  shortMd,
  summarizeDay,
  sumDays,
  weekRange,
  weekdayKo,
  type DayState,
  type DaySummary,
  type PeriodTotal,
  type WorkHoursDayRow,
} from "@/lib/work-hours";
import { formatWorkMinutes, PROGRESS_WORKING } from "@/lib/attendanceLabels";

// 전체 근무시간 조회 (관리자 메뉴 work-hours).
// 데이터: GET /api/attendance/work-hours (권한·부서 강제는 서버). 계산: lib/work-hours.
// 주소: /?page=work-hours&view=month&month=2026-11 | &view=week&date=2026-11-16 | &employee=8 | &department=3
//       (화면 상태가 바뀌면 replaceState 로 맞춘다. 다른 메뉴로 가면 lib/launcher 가 이 키들을 지운다)
// 표: 열 너비 고정(table-fixed) — 달마다 주 개수가 달라도 이름·부서·합계·비고 위치는 그대로,
//     좁은 창에서는 카드 안에서만 가로 스크롤(이름 칸 고정).

type View = "month" | "week";

interface Employee {
  id: number;
  name: string;
  departmentName: string | null;
  isActive: boolean;
}

interface ApiResponse {
  range: { startDate: string; endDate: string };
  /** 오늘 근무일 (work_date_cutoff_hour 기준) */
  today: string;
  scope: "all" | "department";
  departmentId: number | null;
  departments: { id: number; name: string }[] | null;
  employees: Employee[];
  detailEmployee: Employee | null;
  rows: WorkHoursDayRow[];
}

interface Column {
  key: string;
  /** 머리글 윗줄 — "1주" / "월" */
  title: string;
  /** 머리글 아랫줄 — "11/2~11/8" / "11/16" */
  sub: string;
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
  "직원별 주간·월간 근무시간 — WiFi 첫 연결~마지막 연결(승인된 근태 정정 반영), 휴게시간 공제 없음, 지난 날짜의 퇴근 기록 없는 날은 합계 제외";

// 숫자 칸 글자 색 — "-"·"0분" 연한 회색, 근무중 파랑, 퇴근 없음·기록 오류 주황
const ZERO = formatWorkMinutes(0);
function tone(text: string, state?: DayState): string {
  if (text === "-" || text === ZERO) return "text-gray-300";
  if (state === "working") return PROGRESS_WORKING.cls;
  if (state === "no_checkout" || state === "invalid") return "text-orange-500";
  return "text-gray-700";
}

// 주별 머리글 — 토·일 색은 AttendanceCalendarView 와 같다
function weekdayTone(ymd: string): string {
  const dow = new Date(ymd + "T00:00:00.000Z").getUTCDay();
  return dow === 0 ? "text-rose-500" : dow === 6 ? "text-blue-500" : "text-gray-500";
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
  // 오늘 근무일 — 서버(work_date_cutoff_hour 기준)가 준 값, 받기 전에는 브라우저 날짜
  const today = data?.today ?? todayYmd();

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
        key: w.start,
        title: `${w.index}주`,
        sub: w.start === w.end ? shortMd(w.start) : `${shortMd(w.start)}~${shortMd(w.end)}`,
        days: daysInRange(w.start, w.end),
      }));
    }
    return daysInRange(range.start, range.end).map((d) => ({
      key: d,
      title: weekdayKo(d),
      sub: shortMd(d),
      days: [d],
    }));
  }, [view, month, range.start, range.end]);
  const totalLabel = view === "month" ? "월 합계" : "주 합계";
  const allDays = useMemo(() => daysInRange(range.start, range.end), [range.start, range.end]);

  const daySummary = useCallback(
    (empId: number, ymd: string): DaySummary =>
      summarizeDay(ymd, byEmployee.get(empId)?.get(ymd), today),
    [byEmployee, today]
  );
  const periodTotal = useCallback(
    (empId: number, days: string[]): PeriodTotal => sumDays(days.map((d) => daySummary(empId, d))),
    [daySummary]
  );

  // 칸 — 주별은 하루 값, 월별은 주 합계
  const cell = (empId: number, col: Column): { text: string; state?: DayState } => {
    if (view === "week") {
      const s = daySummary(empId, col.days[0]);
      return { text: dayCellText(s), state: s.state };
    }
    return { text: periodMinutesText(periodTotal(empId, col.days)) };
  };
  const total = (empId: number) => {
    const t = periodTotal(empId, allDays);
    return { text: periodMinutesText(t), remark: periodRemarkText(t) };
  };

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

  // ── 엑셀 — 지금 보고 있는 표 그대로 (머리글은 한 줄 "2주 (11/2~11/8)") ──
  const handleExport = async () => {
    if (!data || employees.length === 0) return;
    const headers = [
      "이름",
      "부서",
      ...columns.map((c) => `${c.title} (${c.sub})`),
      totalLabel,
      "비고",
    ];
    const rows = employees.map((e) => {
      const t = total(e.id);
      return [
        e.isActive ? e.name : `${e.name} (퇴사)`,
        e.departmentName ?? "",
        ...columns.map((c) => cell(e.id, c).text),
        t.text,
        t.remark,
      ];
    });
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
    return daysInRange(range.start, range.end).map((d) => ({
      ymd: d,
      row: byEmployee.get(detail.id)?.get(d) ?? null,
      summary: daySummary(detail.id, d),
    }));
  }, [detail, byEmployee, daySummary, range.start, range.end]);
  const detailSum = sumDays(detailDays.map((d) => d.summary));
  const detailTotal = periodMinutesText(detailSum);
  const detailRemark = periodRemarkText(detailSum);

  const thBase = "align-middle text-xs font-semibold text-gray-500 whitespace-nowrap";
  const thCls = `h-[52px] px-3 ${thBase}`;
  const thNumCls = `h-[52px] px-2 text-right ${thBase}`;
  const thDetailCls = `h-10 px-3 ${thBase}`;
  const tdBase = "h-11 text-sm whitespace-nowrap overflow-hidden text-ellipsis";
  const tdCls = `${tdBase} px-3`;
  // 숫자 칸 — 상세 모달 근무 칸과 같은 font-mono, 오른쪽 정렬로 자릿수를 맞춘다
  const numCls = `${tdBase} px-2 font-mono tabular-nums text-right`;

  return (
    <div className="p-4 sm:p-6 pb-24 sm:pb-24 space-y-5 min-w-0">
      {/* ───── 헤더 ───── */}
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl sm:text-2xl font-bold text-gray-900">전체 근무시간 조회</h1>
          <p className="text-sm text-gray-500 mt-0.5">{RULE_TEXT}</p>
        </div>
        <ExcelButton
          onClick={handleExport}
          disabled={!data || loading || employees.length === 0}
          className="self-start sm:self-auto shrink-0"
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

          {/* 데스크탑 표 — 열 너비 고정, 좁으면 이 안에서만 가로 스크롤 */}
          <div className="hidden md:block overflow-x-auto">
            <table className="w-full min-w-[1280px] table-fixed">
              <colgroup>
                <col className="w-[180px]" />
                <col className="w-[110px]" />
                {columns.map((c) => (
                  <col key={c.key} />
                ))}
                <col className="w-[140px]" />
                <col className="w-[170px]" />
              </colgroup>
              <thead>
                <tr className="bg-gray-50 border-b border-gray-100">
                  <th className={`${thCls} text-left sticky left-0 z-10 bg-gray-50`}>이름</th>
                  <th className={`${thCls} text-left`}>부서</th>
                  {columns.map((c) => {
                    const isToday = view === "week" && c.days[0] === today;
                    return (
                      <th key={c.key} className={`${thNumCls} ${isToday ? "bg-blue-50" : ""}`}>
                        <div className={view === "week" ? weekdayTone(c.key) : ""}>{c.title}</div>
                        <div className="text-[11px] font-normal text-gray-400 font-mono tabular-nums">
                          {c.sub}
                        </div>
                      </th>
                    );
                  })}
                  <th className={thNumCls}>{totalLabel}</th>
                  <th className={`${thCls} text-left`}>비고</th>
                </tr>
              </thead>
              <tbody>
                {employees.map((e) => {
                  const selected = employeeId === e.id;
                  const t = total(e.id);
                  return (
                    <tr
                      key={e.id}
                      className={`group border-b border-gray-50 last:border-0 ${
                        selected ? "bg-blue-50" : "hover:bg-slate-50"
                      }`}
                    >
                      <td
                        className={`${tdCls} sticky left-0 z-[1] ${
                          selected ? "bg-blue-50" : "bg-white group-hover:bg-slate-50"
                        }`}
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          <button
                            onClick={() => setEmployeeId(e.id)}
                            className="font-semibold text-gray-900 hover:text-blue-600 truncate"
                            title={e.name}
                          >
                            {e.name}
                          </button>
                          {!e.isActive && <RetiredBadge />}
                        </div>
                      </td>
                      <td className={`${tdCls} text-gray-600`} title={e.departmentName ?? undefined}>
                        {e.departmentName ?? "-"}
                      </td>
                      {columns.map((c) => {
                        const v = cell(e.id, c);
                        const isToday = view === "week" && c.days[0] === today;
                        return (
                          <td
                            key={c.key}
                            className={`${numCls} ${tone(v.text, v.state)} ${
                              isToday ? "bg-blue-50/60" : ""
                            }`}
                            title={v.text}
                          >
                            {v.text}
                          </td>
                        );
                      })}
                      <td className={`${numCls} font-semibold ${t.text === "-" || t.text === ZERO ? "text-gray-300" : "text-gray-900"}`}>
                        {t.text}
                      </td>
                      <td className={`${tdCls} text-xs text-orange-500`} title={t.remark || undefined}>
                        {t.remark}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* 모바일 카드 */}
          <div className="md:hidden divide-y divide-gray-50">
            {employees.map((e) => {
              const t = total(e.id);
              return (
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
                    {columns.map((c) => {
                      const v = cell(e.id, c);
                      const isToday = view === "week" && c.days[0] === today;
                      return (
                        <div key={c.key} className="flex items-center justify-between gap-2 text-xs">
                          <span className={`shrink-0 ${isToday ? "text-blue-600 font-semibold" : "text-gray-500"}`}>
                            {c.title} ({c.sub})
                          </span>
                          <span className={`font-mono tabular-nums truncate ${tone(v.text, v.state)}`}>
                            {v.text}
                          </span>
                        </div>
                      );
                    })}
                    <div className="flex items-center justify-between text-xs pt-1">
                      <span className="text-gray-700 font-semibold">{totalLabel}</span>
                      <span className="text-gray-900 font-semibold font-mono tabular-nums">{t.text}</span>
                    </div>
                    {t.remark && <div className="text-[11px] text-orange-500 text-right">{t.remark}</div>}
                  </div>
                </button>
              );
            })}
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
            <table className="w-full min-w-[720px] table-fixed">
              <colgroup>
                <col className="w-[120px]" />
                <col className="w-[150px]" />
                <col className="w-[150px]" />
                <col className="w-[130px]" />
                <col />
              </colgroup>
              <thead>
                <tr className="bg-gray-50 border-b border-gray-100">
                  <th className={`${thDetailCls} text-left`}>날짜</th>
                  <th className={`${thDetailCls} text-left`}>출근</th>
                  <th className={`${thDetailCls} text-left`}>퇴근</th>
                  <th className={`h-10 px-2 text-right ${thBase}`}>근무</th>
                  <th className={`${thDetailCls} text-left`}>사유</th>
                </tr>
              </thead>
              <tbody>
                {detailDays.map(({ ymd, row, summary }) => {
                  const future = summary.state === "future";
                  const minutes = dayMinutesText(summary);
                  const notes = summary.notes.join(", ");
                  return (
                    <tr
                      key={ymd}
                      className={`border-b border-gray-50 last:border-0 ${
                        ymd === today ? "bg-blue-50/60" : "hover:bg-slate-50"
                      }`}
                    >
                      <td className={`${tdCls} font-mono tabular-nums ${future ? "text-gray-300" : "text-gray-700"}`}>
                        {ymd.slice(5)} (<span className={future ? "" : weekdayTone(ymd)}>{weekdayKo(ymd)}</span>)
                      </td>
                      <td className={`${tdCls} font-mono tabular-nums ${row?.checkIn && !future ? "text-gray-900" : "text-gray-300"}`}>
                        {row && !future ? renderTimeCell(row.originalCheckIn, row.checkIn) : "-"}
                      </td>
                      <td className={`${tdCls} font-mono tabular-nums ${row?.checkOut && !future ? "text-gray-900" : "text-gray-300"}`}>
                        {row && !future ? renderTimeCell(row.originalCheckOut, row.checkOut, row.workDate) : "-"}
                      </td>
                      <td className={`${numCls} ${minutes === "-" || minutes === ZERO ? "text-gray-300" : summary.state === "working" ? PROGRESS_WORKING.cls : "text-gray-900"}`}>
                        {minutes}
                      </td>
                      <td className={`${tdCls} ${notes ? "text-gray-600" : "text-gray-300"}`} title={notes || undefined}>
                        {notes || "-"}
                      </td>
                    </tr>
                  );
                })}
                <tr className="bg-gray-50 border-t border-gray-100">
                  <td colSpan={3} className={`${tdCls} font-semibold text-gray-700`}>
                    합계
                  </td>
                  <td className={`${numCls} font-semibold text-gray-900`}>{detailTotal}</td>
                  <td className={`${tdCls} text-xs text-orange-500`} title={detailRemark || undefined}>
                    {detailRemark}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          {/* 모바일 카드 */}
          <div className="md:hidden divide-y divide-gray-50">
            {detailDays.map(({ ymd, row, summary }) => {
              const future = summary.state === "future";
              const minutes = dayMinutesText(summary);
              return (
                <div key={ymd} className={`px-4 py-3 space-y-1 ${ymd === today ? "bg-blue-50/60" : ""}`}>
                  <div className="flex items-center justify-between">
                    <span className={`text-sm font-semibold font-mono ${future ? "text-gray-300" : "text-gray-900"}`}>
                      {ymd.slice(5)} ({weekdayKo(ymd)})
                    </span>
                    <span
                      className={`text-xs font-mono tabular-nums font-semibold ${
                        minutes === "-" ? "text-gray-300" : summary.state === "working" ? PROGRESS_WORKING.cls : "text-gray-700"
                      }`}
                    >
                      {minutes}
                    </span>
                  </div>
                  {!future && (row || summary.notes.length > 0) && (
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
                  )}
                </div>
              );
            })}
            <div className="px-4 py-3 space-y-0.5 bg-gray-50">
              <div className="flex items-center justify-between text-sm">
                <span className="font-semibold text-gray-700">합계</span>
                <span className="font-semibold text-gray-900 font-mono tabular-nums">{detailTotal}</span>
              </div>
              {detailRemark && <div className="text-[11px] text-orange-500 text-right">{detailRemark}</div>}
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

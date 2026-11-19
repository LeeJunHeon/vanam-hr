"use client";

import { useState, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { ChevronLeft, ChevronRight, Loader2, Users } from "lucide-react";
import MonthPicker from "@/components/MonthPicker";
import DatePicker from "@/components/DatePicker";
import ExcelButton from "@/components/ExcelButton";
import WorkHoursTable from "@/components/work-hours/WorkHoursTable";
import WorkHoursMobileList from "@/components/work-hours/WorkHoursMobileList";
import type { WorkHoursDetailData } from "@/components/work-hours/WorkHoursDetail";
import type { WorkHoursEmployee, WorkHoursListProps } from "@/components/work-hours/shared";
import { todayYmd } from "@/lib/dateUtils";
import { exportExcel } from "@/lib/excelUtils";
import { writePageQuery } from "@/lib/launcher";
import {
  addDays,
  addMonths,
  buildColumns,
  buildDetailLines,
  columnCell,
  daysInRange,
  isColumnClickable,
  monthRange,
  monthWeeks,
  mondayOf,
  neighborIds,
  parseDayParam,
  parseWeekParam,
  parseYm,
  parseYmd,
  periodMinutesText,
  periodRemarkText,
  periodTotalOf,
  shortMd,
  summarizeDay,
  weekRange,
  type DaySummarizer,
  type WorkHoursColumn,
  type WorkHoursDayRow,
  type WorkHoursView,
} from "@/lib/work-hours";

// 전체 근무시간 조회 (관리자 메뉴 work-hours) — 상태·주소·데이터 조회를 맡는 컨테이너.
// 화면 조각: components/work-hours/ (WorkHoursTable 데스크톱 표, WorkHoursMobileList 휴대폰 카드, WorkHoursDetail 펼친 상세)
// 데이터: GET /api/attendance/work-hours (권한·부서 강제는 서버). 계산: lib/work-hours.
// 주소: /?page=work-hours&view=month&month=2026-11 | &view=week&date=2026-11-16 | &department=3
//       | &employee=8 (펼친 직원) | &week=3 (월별 — 그 주만) | &day=2026-11-18 (주별 — 그날 강조)
//       (화면 상태가 바뀌면 replaceState 로 맞춘다. 보기·기간·부서를 바꾸면 week·day 는 지운다.
//        다른 메뉴로 가면 lib/launcher 가 이 키들을 지운다)
// 펼치기: 한 번에 한 명, 누른 행(카드) 바로 아래. 주소로 바로 열면 처음 한 번 그 행이 보이게 스크롤한다.

interface ApiResponse {
  range: { startDate: string; endDate: string };
  /** 오늘 근무일 (work_date_cutoff_hour 기준) */
  today: string;
  scope: "all" | "department";
  departmentId: number | null;
  departments: { id: number; name: string }[] | null;
  employees: WorkHoursEmployee[];
  rows: WorkHoursDayRow[];
}

interface UrlState {
  view: WorkHoursView;
  month: string;
  date: string;
  employee: number | null;
  department: number | null;
  week: number | null;
  day: string | null;
}

function positiveInt(s: string | null): number | null {
  if (!s) return null;
  const n = Number(s);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// 주소 → 화면 상태 (잘못된 값은 기본값으로, week·day 는 보기·기간·직원과 맞을 때만)
function readUrlState(): UrlState {
  const today = todayYmd();
  const q = new URLSearchParams(typeof window === "undefined" ? "" : window.location.search);
  const view: WorkHoursView = q.get("view") === "week" ? "week" : "month";
  const month = parseYm(q.get("month")) ?? today.slice(0, 7);
  const date = parseYmd(q.get("date")) ?? today;
  const employee = positiveInt(q.get("employee"));
  return {
    view,
    month,
    date,
    employee,
    department: positiveInt(q.get("department")),
    week: employee && view === "month" ? parseWeekParam(q.get("week"), month) : null,
    day: employee && view === "week" ? parseDayParam(q.get("day"), date) : null,
  };
}

const RULE_TEXT =
  "직원별 주간·월간 근무시간 — WiFi 첫 연결~마지막 연결(승인된 근태 정정 반영), 휴게시간 공제 없음, 지난 날짜의 퇴근 기록 없는 날은 합계 제외";

// ── 펼칠 때 스크롤 (페이지 스크롤 상자는 app/page 의 overflow-y-auto 영역) ──
function scrollParentOf(el: HTMLElement): HTMLElement {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const oy = getComputedStyle(p).overflowY;
    if ((oy === "auto" || oy === "scroll") && p.scrollHeight > p.clientHeight) return p;
  }
  return (document.scrollingElement as HTMLElement) ?? document.documentElement;
}

function viewportOf(sp: HTMLElement): { top: number; bottom: number } {
  if (sp === document.scrollingElement || sp === document.documentElement) {
    return { top: 0, bottom: window.innerHeight };
  }
  const r = sp.getBoundingClientRect();
  return { top: r.top, bottom: r.bottom };
}

export default function WorkHoursPage() {
  const [initial] = useState(readUrlState);
  const [view, setView] = useState<WorkHoursView>(initial.view);
  const [month, setMonth] = useState(initial.month);
  const [date, setDate] = useState(initial.date);
  const [employeeId, setEmployeeId] = useState<number | null>(initial.employee);
  const [departmentId, setDepartmentId] = useState<number | null>(initial.department);
  const [week, setWeek] = useState<number | null>(initial.week);
  const [day, setDay] = useState<string | null>(initial.day);

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

  // 펼친 직원의 근태 행은 표 데이터에 이미 있으므로 employeeId 는 조회 조건에 넣지 않는다(펼칠 때마다 다시 받지 않음)
  const queryKey = useMemo(() => {
    const params = new URLSearchParams({ startDate: range.start, endDate: range.end });
    if (departmentId) params.set("departmentId", String(departmentId));
    return params.toString();
  }, [range.start, range.end, departmentId]);

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
  const employees = useMemo(() => data?.employees ?? [], [data]);

  // 펼친 직원 — 지금 표에 있을 때만 (부서 필터 밖이면 펼치지 않고 주소에서도 뺀다)
  const expandedId = employeeId !== null && employees.some((e) => e.id === employeeId) ? employeeId : null;
  const urlEmployee = loading || !data ? employeeId : expandedId;

  // 화면 상태 → 주소
  useEffect(() => {
    writePageQuery({
      view,
      month: view === "month" ? month : null,
      date: view === "week" ? date : null,
      employee: urlEmployee ? String(urlEmployee) : null,
      department: departmentId ? String(departmentId) : null,
      week: urlEmployee && view === "month" && week ? String(week) : null,
      day: urlEmployee && view === "week" && day ? day : null,
    });
  }, [view, month, date, urlEmployee, departmentId, week, day]);

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

  const columns: WorkHoursColumn[] = useMemo(() => buildColumns(view, month, date), [view, month, date]);
  const weeks = useMemo(() => monthWeeks(month), [month]);
  const totalLabel = view === "month" ? "월 합계" : "주 합계";
  const allDays = useMemo(() => daysInRange(range.start, range.end), [range.start, range.end]);

  const summarizerFor = (empId: number): DaySummarizer => (ymd) =>
    summarizeDay(ymd, byEmployee.get(empId)?.get(ymd), today);
  const cellOf = (empId: number, col: WorkHoursColumn) => columnCell(view, col, summarizerFor(empId));
  const totalOf = (empId: number) => {
    const t = periodTotalOf(allDays, summarizerFor(empId));
    return { text: periodMinutesText(t), remark: periodRemarkText(t) };
  };

  // ── 펼친 행 스크롤 ──
  const containerRef = useRef<HTMLDivElement>(null);
  // 주소로 바로 열었을 때 처음 한 번 그 행이 보이게
  const initialScrollPending = useRef(initial.employee !== null);
  // 사용자가 누를 때 — 누른 행(이전/다음은 지금 펼친 행) 위치를 기억해 두고, 다시 그린 뒤 같은 자리에 두고
  // 펼친 영역이 화면 밖이면 보이는 만큼만 부드럽게 내린다
  const anchorRef = useRef<{ id: number; top: number } | null>(null);

  const visibleEl = (selector: string): HTMLElement | null => {
    for (const el of containerRef.current?.querySelectorAll<HTMLElement>(selector) ?? []) {
      if (el.getClientRects().length > 0) return el;
    }
    return null;
  };
  const rowEl = (id: number) => visibleEl(`[data-emp-row="${id}"]`);

  const rememberAnchor = (targetId: number, fromId: number) => {
    const el = rowEl(fromId);
    anchorRef.current = el ? { id: targetId, top: el.getBoundingClientRect().top } : null;
  };

  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    anchorRef.current = null;
    if (!anchor) return;
    const row = rowEl(anchor.id);
    if (!row) return;
    const sp = scrollParentOf(row);
    const shift = row.getBoundingClientRect().top - anchor.top;
    if (shift !== 0) sp.scrollTop += shift;
    const detailEl = visibleEl(`[data-emp-detail="${anchor.id}"]`);
    if (!detailEl) return;
    const vp = viewportOf(sp);
    const overflow = detailEl.getBoundingClientRect().bottom - vp.bottom;
    // 행이 화면 위로 밀려나지 않는 만큼까지만
    const room = row.getBoundingClientRect().top - vp.top - 8;
    const by = Math.min(overflow + 8, room);
    if (overflow > 0 && by > 0) sp.scrollBy({ top: by, behavior: "smooth" });
    // rowEl·visibleEl 은 containerRef 만 읽는다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [employeeId, week, day]);

  useEffect(() => {
    if (!initialScrollPending.current || loading || !data) return;
    initialScrollPending.current = false;
    if (expandedId === null) return;
    rowEl(expandedId)?.scrollIntoView({ block: "start" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, data, expandedId]);

  // ── 펼치기·칸 누르기 ──
  const clearFocus = () => {
    setWeek(null);
    setDay(null);
  };
  // 행(이름) — 접힘이면 펼치기, 그 주만 보는 중이면 월 전체, 그 밖에는 접기
  const toggleEmployee = (id: number) => {
    rememberAnchor(id, id);
    if (expandedId === id && view === "month" && week !== null) {
      setWeek(null);
      return;
    }
    setEmployeeId(expandedId === id ? null : id);
    clearFocus();
  };
  // 칸 — 월별: 그 주만 보기, 주별: 그날 강조. 같은 칸을 다시 누르면 풀린다. 미래 칸은 반응 없음
  const selectColumn = (id: number, col: WorkHoursColumn) => {
    if (!isColumnClickable(col, today)) return;
    rememberAnchor(id, id);
    const same = expandedId === id;
    setEmployeeId(id);
    if (view === "month") {
      setWeek(same && week === col.weekIndex ? null : col.weekIndex);
      setDay(null);
    } else {
      setDay(same && day === col.days[0] ? null : col.days[0]);
      setWeek(null);
    }
  };
  const closeDetail = () => {
    if (expandedId !== null) rememberAnchor(expandedId, expandedId);
    setEmployeeId(null);
    clearFocus();
  };
  // 이전/다음 직원 — 지금 표 순서(부서 필터 반영), 보던 주·날은 유지
  const neighbors = expandedId !== null ? neighborIds(employees.map((e) => e.id), expandedId) : null;
  const moveTo = (id: number | null) => {
    if (id === null || expandedId === null) return;
    rememberAnchor(id, expandedId);
    setEmployeeId(id);
  };

  // ── 기간 이동 (보기·기간·부서가 바뀌면 week·day 는 지운다) ──
  const changeMonth = (ym: string) => {
    setMonth(ym);
    clearFocus();
  };
  const changeDate = (ymd: string) => {
    setDate(ymd);
    clearFocus();
  };
  const goPrev = () =>
    view === "month" ? changeMonth(addMonths(month, -1)) : changeDate(addDays(mondayOf(date), -7));
  const goNext = () =>
    view === "month" ? changeMonth(addMonths(month, 1)) : changeDate(addDays(mondayOf(date), 7));
  const goToday = () => {
    const t = todayYmd();
    if (view === "month") changeMonth(t.slice(0, 7));
    else changeDate(t);
  };
  const switchView = (v: WorkHoursView) => {
    if (v === view) return;
    // 보던 기간을 이어서 — 월별→주별은 그 달 1일(이번 달이면 오늘)의 주, 주별→월별은 그 주 월요일의 달
    if (v === "week") {
      const t = todayYmd();
      setDate(t.slice(0, 7) === month ? t : `${month}-01`);
    } else {
      setMonth(mondayOf(date).slice(0, 7));
    }
    setView(v);
    clearFocus();
  };
  const changeDepartment = (id: number | null) => {
    setDepartmentId(id);
    clearFocus();
  };

  const periodLabel =
    view === "month"
      ? `${month.slice(0, 4)}년 ${Number(month.slice(5, 7))}월`
      : `${range.start.replace(/-/g, ".")} ~ ${shortMd(range.end)}`;

  // ── 엑셀 — 지금 보고 있는 표 그대로 (머리글은 한 줄 "2주 (11/2~11/8)") ──
  const handleExport = async () => {
    if (!data || employees.length === 0) return;
    const headers = ["이름", "부서", ...columns.map((c) => `${c.title} (${c.sub})`), totalLabel, "비고"];
    const rows = employees.map((e) => {
      const t = totalOf(e.id);
      return [
        e.isActive ? e.name : `${e.name} (퇴사)`,
        e.departmentName ?? "",
        ...columns.map((c) => cellOf(e.id, c).text),
        t.text,
        t.remark,
      ];
    });
    const deptName =
      departmentId && data.departments ? data.departments.find((d) => d.id === departmentId)?.name : null;
    const period = view === "month" ? `월별_${month}` : `주별_${range.start}~${range.end}`;
    await exportExcel(headers, rows, `근무시간_${period}${deptName ? `_${deptName}` : ""}.xlsx`, "근무시간");
  };

  // ── 펼친 직원 일별 상세 (표·카드 공용 — 날짜 줄·주 소계·합계를 여기서 한 번 만든다) ──
  const focusWeek = view === "month" && week !== null ? (weeks[week - 1] ?? null) : null;
  let detail: WorkHoursDetailData | null = null;
  if (expandedId !== null) {
    const employee = employees.find((e) => e.id === expandedId)!;
    const summarize = summarizerFor(expandedId);
    const days = focusWeek ? daysInRange(focusWeek.start, focusWeek.end) : allDays;
    detail = {
      employee,
      periodLabel,
      focusWeek,
      focusDay: view === "week" ? day : null,
      // 월 전체일 때만 주 소계 줄
      lines: buildDetailLines(days, summarize, view === "month" && !focusWeek ? weeks : null),
      total: periodTotalOf(days, summarize),
      today,
      getRow: (ymd) => byEmployee.get(expandedId)?.get(ymd) ?? null,
      hasPrev: neighbors?.prev != null,
      hasNext: neighbors?.next != null,
      onPrev: () => moveTo(neighbors?.prev ?? null),
      onNext: () => moveTo(neighbors?.next ?? null),
      onClose: closeDetail,
      onShowMonth: () => {
        rememberAnchor(expandedId, expandedId);
        setWeek(null);
      },
    };
  }

  const listProps: WorkHoursListProps = {
    view,
    columns,
    employees,
    today,
    totalLabel,
    cellOf,
    totalOf,
    expandedId,
    activeColumnKey:
      view === "month"
        ? (columns.find((c) => c.weekIndex === week)?.key ?? null)
        : day,
    onToggleEmployee: toggleEmployee,
    onSelectColumn: selectColumn,
    detail,
  };

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
                  if (v) changeDate(v);
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
            onChange={(e) => changeDepartment(e.target.value === "all" ? null : Number(e.target.value))}
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

      {/* ───── 직원별 표 (행 아래 펼침 상세) ───── */}
      {loading && !data ? (
        <div className="bg-white rounded-2xl border border-gray-100 flex items-center justify-center h-32">
          <Loader2 size={20} className="animate-spin text-blue-500" />
          <span className="ml-2 text-sm text-gray-500">불러오는 중...</span>
        </div>
      ) : error ? (
        <div className="bg-white rounded-2xl border border-gray-100 px-5 py-6 text-sm text-rose-600">{error}</div>
      ) : employees.length === 0 ? (
        <div className="bg-white rounded-2xl border border-gray-100 px-5 py-12 text-center">
          <Users size={32} className="mx-auto mb-2 text-gray-300" />
          <p className="text-sm text-gray-400">표시할 직원이 없습니다</p>
        </div>
      ) : (
        <div ref={containerRef} className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
          <div className="px-5 py-3 border-b border-gray-100 bg-gray-50 flex items-center justify-between gap-2">
            <h3 className="text-sm font-bold text-gray-900 shrink-0">
              {view === "month" ? "월별 근무시간" : "주별 근무시간"}
            </h3>
            <span className="text-xs text-gray-400 flex items-center gap-1.5 min-w-0 truncate">
              {loading && <Loader2 size={12} className="animate-spin shrink-0" />}
              {employees.length}명 · 행을 누르면 일별 상세
            </span>
          </div>
          <WorkHoursTable {...listProps} />
          <WorkHoursMobileList {...listProps} />
        </div>
      )}

      {monthPickerOpen && (
        <MonthPicker value={month} onChange={changeMonth} onClose={() => setMonthPickerOpen(false)} />
      )}
    </div>
  );
}

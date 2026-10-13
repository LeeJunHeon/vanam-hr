"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { Loader2, TrendingUp, X, Plus, Settings, ChevronLeft, ChevronRight, Lock } from "lucide-react";
import PerfSheetForm, { PerfExampleBadge, PerfStatusBadge } from "@/components/performance/PerfSheetForm";
import PerfReviewPanel, { type PerfReviewData } from "@/components/performance/PerfReviewPanel";
import type { PerfContent, PerfInfo } from "@/lib/performance/form";
import {
  addDaysYmd,
  cycleProgressLabel,
  formatKstShort,
  quarterKey,
  REVIEW_STATUS_META,
  type CycleState,
  type ReviewStatus,
  type SheetStatus,
} from "@/lib/performance/rules";

const REVIEW_LEAVE_CONFIRM = "저장하지 않은 면담 기록이 있습니다. 저장하지 않고 이동할까요?";

interface CycleItem {
  id: number;
  year: number;
  quarter: number;
  label: string;
  submitStart: string;
  submitEnd: string;
  state: CycleState;
  dDay: number;
  targetCount: number;
  submittedCount: number;
}

interface CycleDefaults {
  todayYmd: string;
  submitDays: number;
  suggestedYear: number;
  suggestedQuarter: number;
}

interface EmployeeOption {
  id: number;
  name: string;
  departmentName: string | null;
}

interface StatusRow {
  employeeId: number;
  name: string;
  departmentName: string | null;
  status: SheetStatus;
  submittedAt: string | null;
  hasSubmitted: boolean;
  /** 04 면담 기록 상태 (내용은 오지 않는다) */
  reviewStatus: ReviewStatus;
}

interface SheetView {
  employeeName: string;
  label: string;
  status: string;
  submittedAt: string;
  revisionReason: string | null;
  revisionRequestedAt: string | null;
  content: PerfContent;
  info: PerfInfo;
  /** 04 면담 및 평가 기록 (관리자 전용) */
  review: PerfReviewData;
  /** 로그인한 관리자 이름 — 평가자 칸 미리 채우기 */
  viewerName: string;
  history: { year: number; quarter: number; label: string }[];
}

const INPUT_CLS =
  "w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-blue-200 disabled:bg-gray-50 disabled:text-gray-500";

export default function PerformanceAdminPage() {
  const [cycles, setCycles] = useState<CycleItem[]>([]);
  const [defaults, setDefaults] = useState<CycleDefaults | null>(null);
  const [employees, setEmployees] = useState<EmployeeOption[]>([]);
  const [cycleId, setCycleId] = useState<number | null>(null);
  const cycleIdRef = useRef<number | null>(null);
  const [rows, setRows] = useState<StatusRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [rowsLoading, setRowsLoading] = useState(false);
  const [loadError, setLoadError] = useState("");

  // 열람: 선택한 직원 + 보고 있는 분기(기본 = 회차 분기, "다른 분기"로 바꿀 수 있음)
  const [viewEmpId, setViewEmpId] = useState<number | null>(null);
  const [viewQuarter, setViewQuarter] = useState<{ year: number; quarter: number } | null>(null);
  const [sheet, setSheet] = useState<SheetView | null>(null);
  const [sheetLoading, setSheetLoading] = useState(false);
  const [sheetError, setSheetError] = useState("");
  const sheetReq = useRef(0);
  // 불러올 때마다 +1 — 04 패널을 새로 마운트해 편집 상태를 초기화
  const [sheetVersion, setSheetVersion] = useState(0);
  // 04 패널에 저장하지 않은 변경이 있는지 (이동·창 닫기 확인)
  const reviewDirtyRef = useRef(false);

  const [cycleModal, setCycleModal] = useState<"create" | "edit" | null>(null);
  const [revisionOpen, setRevisionOpen] = useState(false);
  const [toast, setToast] = useState("");

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(""), 2000);
  };

  const cycle = cycles.find((c) => c.id === cycleId) ?? null;

  const loadRows = useCallback(async (id: number) => {
    setRowsLoading(true);
    try {
      const res = await fetch(`/api/performance/cycles/${id}/status`, { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (res.ok) setRows(data.rows ?? []);
      else setLoadError(data.error ?? "제출 현황을 불러오지 못했습니다.");
    } catch {
      setLoadError("네트워크 오류로 제출 현황을 불러오지 못했습니다.");
    } finally {
      setRowsLoading(false);
    }
  }, []);

  /** 회차 전환 — 현황 다시 불러오고 열람 닫기 */
  const selectCycle = useCallback(
    (id: number | null) => {
      cycleIdRef.current = id;
      setCycleId(id);
      sheetReq.current++;
      setViewEmpId(null);
      setSheet(null);
      setRows([]);
      if (id != null) loadRows(id);
    },
    [loadRows]
  );

  const loadCycles = useCallback(async (keepId?: number | null) => {
    try {
      const res = await fetch("/api/performance/cycles", { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setLoadError(data.error ?? "회차 목록을 불러오지 못했습니다.");
        return;
      }
      const list: CycleItem[] = data.cycles ?? [];
      setCycles(list);
      setDefaults(data.defaults ?? null);
      setEmployees(data.employees ?? []);
      const want = keepId !== undefined ? keepId : cycleIdRef.current;
      const nextId = want != null && list.some((c) => c.id === want) ? want : list[0]?.id ?? null;
      if (nextId !== cycleIdRef.current) selectCycle(nextId);
    } catch {
      setLoadError("네트워크 오류로 회차 목록을 불러오지 못했습니다.");
    } finally {
      setLoading(false);
    }
  }, [selectCycle]);

  const loadSheet = useCallback(async (employeeId: number, year: number, quarter: number) => {
    const req = ++sheetReq.current;
    setSheetLoading(true);
    setSheetError("");
    try {
      const res = await fetch(
        `/api/performance/sheets?employeeId=${employeeId}&year=${year}&quarter=${quarter}`,
        { cache: "no-store" }
      );
      const data = await res.json().catch(() => ({}));
      if (req !== sheetReq.current) return;
      if (!res.ok) {
        setSheet(null);
        setSheetError(data.error ?? "성과를 불러오지 못했습니다.");
        return;
      }
      reviewDirtyRef.current = false;
      setSheet(data);
      setSheetVersion((v) => v + 1);
    } catch {
      if (req === sheetReq.current) setSheetError("네트워크 오류로 성과를 불러오지 못했습니다.");
    } finally {
      if (req === sheetReq.current) setSheetLoading(false);
    }
  }, []);

  useEffect(() => {
    loadCycles();
  }, [loadCycles]);

  // 저장하지 않은 04 변경이 있을 때만 창 닫기·새로고침 경고
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!reviewDirtyRef.current) return;
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  /** 저장하지 않은 04 변경이 있으면 이동 전에 확인 — 이동해도 되면 true */
  const confirmLeave = () => {
    if (reviewDirtyRef.current && !window.confirm(REVIEW_LEAVE_CONFIRM)) return false;
    reviewDirtyRef.current = false;
    return true;
  };

  const submittedRows = useMemo(() => rows.filter((r) => r.hasSubmitted), [rows]);

  const openEmployee = (employeeId: number) => {
    if (!cycle) return;
    if (!confirmLeave()) return;
    setViewEmpId(employeeId);
    setViewQuarter({ year: cycle.year, quarter: cycle.quarter });
    const row = rows.find((r) => r.employeeId === employeeId);
    if (row?.hasSubmitted) {
      loadSheet(employeeId, cycle.year, cycle.quarter);
    } else {
      sheetReq.current++;
      setSheet(null);
      setSheetLoading(false);
      setSheetError("");
    }
  };

  const closeViewer = () => {
    if (!confirmLeave()) return;
    sheetReq.current++;
    setViewEmpId(null);
    setSheet(null);
  };

  const moveEmployee = (dir: -1 | 1) => {
    const idx = submittedRows.findIndex((r) => r.employeeId === viewEmpId);
    const next = submittedRows[idx + dir];
    if (next) openEmployee(next.employeeId);
  };

  const changeViewQuarter = (key: string) => {
    if (viewEmpId == null || !sheet) return;
    const h = sheet.history.find((x) => quarterKey(x.year, x.quarter) === key);
    if (!h) return;
    if (!confirmLeave()) return;
    setViewQuarter({ year: h.year, quarter: h.quarter });
    loadSheet(viewEmpId, h.year, h.quarter);
  };

  const viewRow = rows.find((r) => r.employeeId === viewEmpId) ?? null;
  const viewIdx = submittedRows.findIndex((r) => r.employeeId === viewEmpId);

  // ── 열람 패널 (데스크톱 오른쪽 / 모바일 전체 화면) ──
  const renderViewer = (mobile: boolean) => {
    if (viewEmpId == null || !viewRow) {
      return (
        <div className="h-full flex items-center justify-center text-sm text-gray-400 py-16">
          왼쪽 목록에서 직원을 선택하세요.
        </div>
      );
    }
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <h2 className="flex-1 min-w-0 text-base font-bold text-gray-900 truncate">
            {viewRow.name} · {sheet?.label ?? cycle?.label}
          </h2>
          {viewRow.hasSubmitted && (
            <>
              <button
                onClick={() => moveEmployee(-1)}
                disabled={viewIdx <= 0}
                className="p-1.5 rounded-lg border border-gray-200 text-gray-500 hover:bg-gray-50 disabled:opacity-30"
                aria-label="이전 직원"
              >
                <ChevronLeft size={16} />
              </button>
              <button
                onClick={() => moveEmployee(1)}
                disabled={viewIdx < 0 || viewIdx >= submittedRows.length - 1}
                className="p-1.5 rounded-lg border border-gray-200 text-gray-500 hover:bg-gray-50 disabled:opacity-30"
                aria-label="다음 직원"
              >
                <ChevronRight size={16} />
              </button>
            </>
          )}
          {mobile && (
            <button onClick={closeViewer} className="p-1.5 text-gray-400 hover:text-gray-700" aria-label="닫기">
              <X size={20} />
            </button>
          )}
        </div>

        {!viewRow.hasSubmitted ? (
          <div className="bg-gray-50 border border-gray-200 rounded-2xl px-4 py-6 text-center text-sm text-gray-500">
            <Lock size={18} className="mx-auto mb-2 text-gray-300" />
            제출 전이라 내용을 볼 수 없습니다.
          </div>
        ) : sheetLoading && !sheet ? (
          <div className="flex justify-center py-16">
            <Loader2 className="animate-spin text-gray-400" size={28} />
          </div>
        ) : sheetError ? (
          <div className="text-sm text-rose-600">{sheetError}</div>
        ) : (
          sheet && (
            <div className={`space-y-4 ${sheetLoading ? "opacity-60" : ""}`}>
              <div className="flex flex-wrap items-center gap-2 text-xs text-gray-500">
                <span>제출 {formatKstShort(sheet.submittedAt)}</span>
                {sheet.history.length > 1 && viewQuarter && (
                  <select
                    value={quarterKey(viewQuarter.year, viewQuarter.quarter)}
                    onChange={(e) => changeViewQuarter(e.target.value)}
                    className="ml-auto px-2 py-1 border border-gray-200 rounded-lg text-xs bg-white"
                    aria-label="다른 분기"
                  >
                    {sheet.history.map((h) => (
                      <option key={quarterKey(h.year, h.quarter)} value={quarterKey(h.year, h.quarter)}>
                        {h.label}
                      </option>
                    ))}
                  </select>
                )}
              </div>

              {sheet.status === "revision" && (
                <div className="bg-purple-50 border border-purple-200 rounded-xl px-3 py-2 text-sm text-purple-800 whitespace-pre-wrap break-words">
                  수정 요청 중 · {sheet.revisionReason}
                  {sheet.revisionRequestedAt && ` (${formatKstShort(sheet.revisionRequestedAt).split(" ")[0]})`}
                </div>
              )}

              <PerfSheetForm content={sheet.content} readOnly info={sheet.info} />

              {sheet.status === "submitted" &&
                (sheet.review.finalizedAt ? (
                  <p className="text-right text-xs text-gray-400">
                    평가가 확정되어 수정 요청을 보낼 수 없습니다.
                  </p>
                ) : (
                  <div className="flex justify-end">
                    <button
                      onClick={() => setRevisionOpen(true)}
                      className="px-4 py-2.5 bg-white border border-purple-200 text-purple-700 rounded-xl text-sm font-semibold hover:bg-purple-50"
                    >
                      수정 요청
                    </button>
                  </div>
                ))}

              {viewEmpId != null && viewQuarter && (
                <PerfReviewPanel
                  key={sheetVersion}
                  employeeId={viewEmpId}
                  year={viewQuarter.year}
                  quarter={viewQuarter.quarter}
                  review={sheet.review}
                  viewerName={sheet.viewerName}
                  dirtyRef={reviewDirtyRef}
                  onChanged={afterReviewChange}
                  onReload={() => loadSheet(viewEmpId, viewQuarter.year, viewQuarter.quarter)}
                  showToast={showToast}
                />
              )}
            </div>
          )
        )}
      </div>
    );
  };

  /** 04 저장·확정·확정 취소 뒤 — 목록 배지와 열람 내용 다시 불러오기 */
  const afterReviewChange = async () => {
    const tasks: Promise<unknown>[] = [];
    if (cycleId != null) tasks.push(loadRows(cycleId));
    if (viewEmpId != null && viewQuarter) tasks.push(loadSheet(viewEmpId, viewQuarter.year, viewQuarter.quarter));
    await Promise.all(tasks);
  };

  const afterRevision = async () => {
    setRevisionOpen(false);
    showToast("수정을 요청했습니다.");
    if (cycleId != null) await loadRows(cycleId);
    if (viewEmpId != null && viewQuarter) await loadSheet(viewEmpId, viewQuarter.year, viewQuarter.quarter);
    loadCycles(cycleId);
  };

  return (
    <div className="p-4 sm:p-6 space-y-5">
      {toast && (
        <div className="fixed bottom-6 right-6 z-[70] bg-gray-900 text-white text-sm font-medium px-5 py-3 rounded-xl shadow-lg">
          {toast}
        </div>
      )}

      {/* 헤더 */}
      <div className="flex flex-col lg:flex-row lg:items-center gap-3">
        <div className="flex-1 min-w-0">
          <h1 className="text-xl sm:text-2xl font-bold text-gray-900 flex items-center gap-2">
            <TrendingUp size={20} />
            성과 관리
            <PerfExampleBadge />
          </h1>
          <p className="text-sm text-gray-500 mt-0.5">분기별 성과 제출 회차를 만들고 제출 현황을 확인합니다</p>
        </div>
        {cycles.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={cycleId ?? ""}
              onChange={(e) => {
                if (confirmLeave()) selectCycle(Number(e.target.value));
              }}
              className="px-3 py-2 border border-gray-200 rounded-xl text-sm bg-white outline-none focus:ring-2 focus:ring-blue-200"
            >
              {cycles.map((c) => (
                <option key={c.id} value={c.id}>{c.label}</option>
              ))}
            </select>
            {cycle && (
              <span className="text-sm text-gray-600">
                제출 <span className="font-semibold text-gray-900">{cycle.submittedCount}</span> / {cycle.targetCount}
                {" · "}
                {cycleProgressLabel(cycle)}
              </span>
            )}
            <button
              onClick={() => setCycleModal("create")}
              className="inline-flex items-center gap-1.5 px-3 py-2 bg-blue-600 text-white rounded-xl text-sm font-semibold hover:bg-blue-700"
            >
              <Plus size={14} />새 회차 만들기
            </button>
            <button
              onClick={() => setCycleModal("edit")}
              disabled={!cycle || rowsLoading}
              className="inline-flex items-center gap-1.5 px-3 py-2 bg-white border border-gray-200 text-gray-700 rounded-xl text-sm font-medium hover:bg-gray-50 disabled:opacity-50"
            >
              <Settings size={14} />회차 설정
            </button>
          </div>
        )}
      </div>

      {loadError && <div className="text-sm text-rose-600">{loadError}</div>}

      {loading ? (
        <div className="flex items-center justify-center py-20 text-gray-400">
          <Loader2 className="animate-spin mr-2" size={20} />
          불러오는 중...
        </div>
      ) : cycles.length === 0 ? (
        <div className="bg-white rounded-2xl border border-gray-100 py-16 text-center">
          <p className="text-sm text-gray-500">아직 만든 회차가 없습니다.</p>
          <button
            onClick={() => setCycleModal("create")}
            className="mt-4 inline-flex items-center gap-1.5 px-4 py-2.5 bg-blue-600 text-white rounded-xl text-sm font-semibold hover:bg-blue-700"
          >
            <Plus size={14} />회차 만들기
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-[minmax(280px,360px)_1fr] gap-4 items-start">
          {/* 대상자 목록 */}
          <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
            <div className="px-4 py-3 bg-gray-50 border-b border-gray-100 text-xs font-semibold text-gray-500">
              대상자 {rows.length}명
            </div>
            {rowsLoading && rows.length === 0 ? (
              <div className="flex justify-center py-10">
                <Loader2 className="animate-spin text-gray-400" size={22} />
              </div>
            ) : (
              <ul className={`max-h-[70vh] overflow-y-auto ${rowsLoading ? "opacity-60" : ""}`}>
                {rows.map((r) => (
                  <li key={r.employeeId}>
                    <button
                      onClick={() => openEmployee(r.employeeId)}
                      className={`w-full text-left px-4 py-3 border-b border-gray-50 transition-colors ${
                        viewEmpId === r.employeeId ? "bg-blue-50" : "hover:bg-gray-50"
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-gray-400 shrink-0">{r.departmentName ?? "-"}</span>
                        <span className={`flex-1 min-w-0 truncate text-sm font-medium ${r.hasSubmitted ? "text-gray-900" : "text-gray-500"}`}>
                          {r.name}
                        </span>
                        <PerfStatusBadge status={r.status} />
                        {r.reviewStatus !== "none" && (
                          <span
                            className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold ${
                              REVIEW_STATUS_META[r.reviewStatus].badgeClass
                            }`}
                          >
                            {REVIEW_STATUS_META[r.reviewStatus].label}
                          </span>
                        )}
                      </div>
                      {r.submittedAt && (
                        <p className="text-[11px] text-gray-400 mt-0.5">제출 {formatKstShort(r.submittedAt)}</p>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* 열람 — 데스크톱 */}
          <div className="hidden lg:block bg-white rounded-2xl border border-gray-100 p-5 min-h-[300px]">
            {renderViewer(false)}
          </div>
        </div>
      )}

      {/* 열람 — 모바일 전체 화면 */}
      {viewEmpId != null && (
        <div className="lg:hidden fixed inset-0 z-50 bg-white overflow-y-auto p-4">{renderViewer(true)}</div>
      )}

      {cycleModal && defaults && (
        <CycleModal
          mode={cycleModal}
          cycle={cycleModal === "edit" ? cycle : null}
          defaults={defaults}
          employees={employees}
          statusRows={cycleModal === "edit" ? rows : []}
          existingKeys={cycles.map((c) => quarterKey(c.year, c.quarter))}
          onClose={() => setCycleModal(null)}
          onSaved={async (savedId, msg) => {
            setCycleModal(null);
            showToast(msg);
            await loadCycles(savedId);
            if (savedId != null && savedId === cycleId) loadRows(savedId);
          }}
        />
      )}

      {revisionOpen && viewEmpId != null && viewQuarter && sheet && (
        <RevisionModal
          employeeId={viewEmpId}
          year={viewQuarter.year}
          quarter={viewQuarter.quarter}
          title={`${sheet.employeeName} · ${sheet.label}`}
          onClose={() => setRevisionOpen(false)}
          onDone={afterRevision}
        />
      )}
    </div>
  );
}

// ── 회차 만들기 / 설정 모달 (배경 클릭으로 닫히지 않음) ──
function CycleModal({
  mode,
  cycle,
  defaults,
  employees,
  statusRows,
  existingKeys,
  onClose,
  onSaved,
}: {
  mode: "create" | "edit";
  cycle: CycleItem | null;
  defaults: CycleDefaults;
  employees: EmployeeOption[];
  statusRows: StatusRow[];
  existingKeys: string[];
  onClose: () => void;
  onSaved: (cycleId: number | null, msg: string) => void;
}) {
  const isEdit = mode === "edit" && !!cycle;
  const [year, setYear] = useState(isEdit ? cycle!.year : defaults.suggestedYear);
  const [quarter, setQuarter] = useState(isEdit ? cycle!.quarter : defaults.suggestedQuarter);
  const [start, setStart] = useState(isEdit ? cycle!.submitStart : defaults.todayYmd);
  const [end, setEnd] = useState(
    isEdit ? cycle!.submitEnd : addDaysYmd(defaults.todayYmd, defaults.submitDays - 1)
  );
  const [endTouched, setEndTouched] = useState(isEdit);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);

  // 체크리스트 = 재직자 + (설정 모드) 지금 대상자 중 목록에 없는 사람(퇴사 등)
  const options: EmployeeOption[] = useMemo(() => {
    const ids = new Set(employees.map((e) => e.id));
    const extra = statusRows
      .filter((r) => !ids.has(r.employeeId))
      .map((r) => ({ id: r.employeeId, name: r.name, departmentName: r.departmentName }));
    return [...employees, ...extra];
  }, [employees, statusRows]);
  const locked = useMemo(
    () => new Set(statusRows.filter((r) => r.hasSubmitted).map((r) => r.employeeId)),
    [statusRows]
  );
  const [checked, setChecked] = useState<Set<number>>(
    () => new Set(isEdit ? statusRows.map((r) => r.employeeId) : employees.map((e) => e.id))
  );

  const canDelete = isEdit && statusRows.every((r) => !r.hasSubmitted);
  const dupQuarter = !isEdit && existingKeys.includes(quarterKey(year, quarter));

  const toggle = (id: number) => {
    if (locked.has(id)) return;
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const selectAll = (on: boolean) =>
    setChecked(on ? new Set(options.map((o) => o.id)) : new Set(locked));

  const changeStart = (v: string) => {
    setStart(v);
    if (!endTouched && v) setEnd(addDaysYmd(v, defaults.submitDays - 1));
  };

  const save = async () => {
    setError("");
    if (!start || !end) return setError("제출 기간을 입력해 주세요.");
    if (start > end) return setError("제출 시작일은 마감일보다 늦을 수 없습니다.");
    if (checked.size === 0) return setError("대상자를 1명 이상 선택해 주세요.");
    setSaving(true);
    try {
      const body = { submitStart: start, submitEnd: end, targetEmployeeIds: Array.from(checked) };
      const res = await fetch(isEdit ? `/api/performance/cycles/${cycle!.id}` : "/api/performance/cycles", {
        method: isEdit ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(isEdit ? body : { ...body, year, quarter }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? "저장하지 못했습니다.");
        return;
      }
      onSaved(isEdit ? cycle!.id : data.id ?? null, isEdit ? "회차 설정을 저장했습니다." : "회차를 만들었습니다.");
    } catch {
      setError("네트워크 오류로 저장하지 못했습니다.");
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!cycle) return;
    setSaving(true);
    setError("");
    try {
      const res = await fetch(`/api/performance/cycles/${cycle.id}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? "삭제하지 못했습니다.");
        setConfirmDelete(false);
        return;
      }
      onSaved(null, "회차를 삭제했습니다.");
    } catch {
      setError("네트워크 오류로 삭제하지 못했습니다.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
          <h2 className="text-lg font-bold text-gray-900">{isEdit ? "회차 설정" : "새 회차 만들기"}</h2>
          <button onClick={onClose} disabled={saving} className="text-gray-400 hover:text-gray-700 disabled:opacity-50">
            <X size={20} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-gray-500 mb-1.5">연도</label>
              <input
                type="number"
                value={year}
                onChange={(e) => setYear(Number(e.target.value))}
                disabled={isEdit}
                className={INPUT_CLS}
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-gray-500 mb-1.5">분기</label>
              <select
                value={quarter}
                onChange={(e) => setQuarter(Number(e.target.value))}
                disabled={isEdit}
                className={`${INPUT_CLS} bg-white`}
              >
                {[1, 2, 3, 4].map((q) => (
                  <option key={q} value={q}>{q}분기</option>
                ))}
              </select>
            </div>
          </div>
          {dupQuarter && <p className="text-xs text-rose-600 -mt-2">이미 같은 분기 회차가 있습니다.</p>}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-gray-500 mb-1.5">제출 시작</label>
              <input type="date" value={start} onChange={(e) => changeStart(e.target.value)} className={INPUT_CLS} />
            </div>
            <div>
              <label className="block text-xs font-semibold text-gray-500 mb-1.5">제출 마감</label>
              <input
                type="date"
                value={end}
                onChange={(e) => {
                  setEnd(e.target.value);
                  setEndTouched(true);
                }}
                className={INPUT_CLS}
              />
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-xs font-semibold text-gray-500">
                대상자 <span className="text-gray-400 font-normal">({checked.size}명)</span>
              </label>
              <div className="flex gap-2 text-[11px]">
                <button type="button" onClick={() => selectAll(true)} className="text-blue-600 hover:underline">
                  전체 선택
                </button>
                <button type="button" onClick={() => selectAll(false)} className="text-gray-500 hover:underline">
                  전체 해제
                </button>
              </div>
            </div>
            <div className="border border-gray-200 rounded-xl max-h-64 overflow-y-auto divide-y divide-gray-50">
              {options.map((e) => (
                <label
                  key={e.id}
                  className={`flex items-center gap-2 px-3 py-2 text-sm ${locked.has(e.id) ? "opacity-70" : "cursor-pointer hover:bg-gray-50"}`}
                >
                  <input
                    type="checkbox"
                    checked={checked.has(e.id)}
                    onChange={() => toggle(e.id)}
                    disabled={locked.has(e.id)}
                  />
                  <span className="text-xs text-gray-400 w-20 truncate">{e.departmentName ?? "-"}</span>
                  <span className="flex-1 text-gray-800">{e.name}</span>
                  {locked.has(e.id) && <span className="text-[11px] text-gray-400">제출함</span>}
                </label>
              ))}
            </div>
          </div>

          {error && <div className="text-sm text-rose-600">{error}</div>}
        </div>

        <div className="flex items-center gap-2 px-5 py-4 border-t border-gray-100">
          {canDelete &&
            (confirmDelete ? (
              <div className="flex items-center gap-2">
                <span className="text-xs text-rose-600">회차를 삭제하시겠습니까?</span>
                <button
                  onClick={remove}
                  disabled={saving}
                  className="px-3 py-2 bg-rose-500 text-white rounded-xl text-xs font-bold hover:bg-rose-600 disabled:opacity-50"
                >
                  삭제
                </button>
                <button
                  onClick={() => setConfirmDelete(false)}
                  disabled={saving}
                  className="px-3 py-2 bg-gray-100 text-gray-600 rounded-xl text-xs font-medium hover:bg-gray-200"
                >
                  취소
                </button>
              </div>
            ) : (
              <button
                onClick={() => setConfirmDelete(true)}
                disabled={saving}
                className="px-3 py-2.5 text-rose-600 text-sm font-medium hover:bg-rose-50 rounded-xl disabled:opacity-50"
              >
                회차 삭제
              </button>
            ))}
          <div className="flex-1" />
          <button
            onClick={onClose}
            disabled={saving}
            className="px-4 py-2.5 bg-white border border-gray-200 text-gray-600 rounded-xl text-sm font-medium hover:bg-gray-50 disabled:opacity-50"
          >
            취소
          </button>
          <button
            onClick={save}
            disabled={saving || dupQuarter}
            className="inline-flex items-center gap-2 bg-blue-600 text-white text-sm font-semibold px-5 py-2.5 rounded-xl hover:bg-blue-700 disabled:opacity-50"
          >
            {saving && <Loader2 size={16} className="animate-spin" />}
            {isEdit ? "저장" : "만들기"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── 수정 요청 모달 (사유 필수, 배경 클릭으로 닫히지 않음) ──
function RevisionModal({
  employeeId,
  year,
  quarter,
  title,
  onClose,
  onDone,
}: {
  employeeId: number;
  year: number;
  quarter: number;
  title: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const submit = async () => {
    if (!reason.trim()) return setError("수정 요청 사유를 입력해 주세요.");
    setSaving(true);
    setError("");
    try {
      const res = await fetch("/api/performance/sheets/request-revision", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ employeeId, year, quarter, reason: reason.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? "수정 요청을 보내지 못했습니다.");
        return;
      }
      onDone();
    } catch {
      setError("네트워크 오류로 수정 요청을 보내지 못했습니다.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-6 space-y-4">
        <div>
          <h3 className="text-lg font-bold text-gray-900">수정 요청</h3>
          <p className="text-xs text-gray-500 mt-0.5">{title}</p>
        </div>
        <p className="text-sm text-gray-600">
          수정을 요청하면 직원이 성과를 고쳐서 다시 제출할 수 있습니다. 사유는 직원에게 알림으로 전달됩니다.
        </p>
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={4}
          maxLength={1000}
          placeholder="수정이 필요한 부분과 사유를 적어 주세요"
          className="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-blue-200 resize-y"
        />
        {error && <div className="text-sm text-rose-600">{error}</div>}
        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            disabled={saving}
            className="px-4 py-2 text-sm font-medium text-gray-600 bg-gray-100 rounded-xl hover:bg-gray-200 disabled:opacity-50"
          >
            취소
          </button>
          <button
            onClick={submit}
            disabled={saving || !reason.trim()}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-bold text-white bg-purple-600 rounded-xl hover:bg-purple-700 disabled:opacity-50"
          >
            {saving && <Loader2 size={14} className="animate-spin" />}
            수정 요청
          </button>
        </div>
      </div>
    </div>
  );
}

"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Loader2, Target, X, AlertTriangle, Send, Download } from "lucide-react";
import PerfSheetForm, { PerfExampleBadge, PerfStatusBadge } from "@/components/performance/PerfSheetForm";
import {
  PERF_FORM,
  importPrevious,
  pendingBasicFields,
  pendingProposals,
  validateForSubmit,
  withDisplayRows,
  type PerfContent,
  type PerfInfo,
  type PerfPrevious,
} from "@/lib/performance/form";
import {
  dDayLabel,
  formatKstShort,
  formatKstTime,
  formatMonthDay,
  quarterKey,
  SHEET_STATUS_META,
  type CycleState,
  type SheetAccess,
  type SheetStatus,
  type YearQuarter,
} from "@/lib/performance/rules";

interface QuarterItem {
  year: number;
  quarter: number;
  label: string;
  status: SheetStatus;
  cycleState: CycleState | null;
  canSubmit: boolean;
}

interface SheetData {
  label: string;
  formVersion: string;
  status: SheetStatus;
  content: PerfContent;
  submittedAt: string | null;
  revisionReason: string | null;
  revisionRequestedAt: string | null;
  updatedAt: string | null;
  cycle: { submitStart: string; submitEnd: string; state: CycleState; dDay: number } | null;
  isTarget: boolean;
  access: SheetAccess;
  info: PerfInfo;
  /** 직전 분기 성과표의 기본 정보·다음 분기 목표 제안 (없으면 null) */
  previous: PerfPrevious | null;
}

type SaveState = "idle" | "saving" | "saved" | "error";

const AUTOSAVE_MS = 1500;
// keepalive 요청 본문 한도(64KB) 안쪽 — 바이트 수로 비교 (한글은 한 글자 3바이트)
const KEEPALIVE_MAX_BYTES = 60000;
const SHEET_URL = "/api/performance/my/sheet";
// 분기 선택 — 최근 이만큼은 버튼, 그보다 앞은 "이전 분기" 선택 상자
const RECENT_QUARTER_BUTTONS = 4;

export default function MyPerformancePage() {
  const [quarters, setQuarters] = useState<QuarterItem[]>([]);
  const [startLabel, setStartLabel] = useState("");
  const [selected, setSelected] = useState<YearQuarter | null>(null);
  const [sheet, setSheet] = useState<SheetData | null>(null);
  const [content, setContent] = useState<PerfContent>({});
  const [listLoading, setListLoading] = useState(true);
  const [sheetLoading, setSheetLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [saveError, setSaveError] = useState("");
  const [previewOpen, setPreviewOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [serverErrors, setServerErrors] = useState<string[]>([]);
  const [toast, setToast] = useState("");

  // 자동 저장용 최신 값 (타이머·이벤트 핸들러에서 읽음)
  const selectedRef = useRef<YearQuarter | null>(null);
  const contentRef = useRef<PerfContent>({});
  const canEditRef = useRef(false);
  const dirtyRef = useRef(false);
  const editVerRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 저장 요청을 순서대로 보내기 위한 체인 (늦게 보낸 저장이 먼저 끝나 덮어쓰는 것 방지)
  const queueRef = useRef<Promise<unknown>>(Promise.resolve());

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(""), 2000);
  };

  const loadSheet = useCallback(async (q: YearQuarter) => {
    setSheetLoading(true);
    setLoadError("");
    try {
      const res = await fetch(`${SHEET_URL}?year=${q.year}&quarter=${q.quarter}`, { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      // 응답이 오기 전에 다른 분기로 바뀌었으면 버린다
      const cur = selectedRef.current;
      if (!cur || cur.year !== q.year || cur.quarter !== q.quarter) return;
      if (!res.ok) {
        setSheet(null);
        setLoadError(data.error ?? "성과를 불러오지 못했습니다.");
        return;
      }
      const sd = data as SheetData;
      const initial = withDisplayRows(sd.content);
      // 불러온 직후에는 저장하지 않는다
      contentRef.current = initial;
      dirtyRef.current = false;
      canEditRef.current = sd.access.canEdit;
      setContent(initial);
      setSheet(sd);
      setSaveState("idle");
      setSaveError("");
      setSavedAt(null);
    } catch {
      setLoadError("네트워크 오류로 성과를 불러오지 못했습니다.");
    } finally {
      setSheetLoading(false);
    }
  }, []);

  /** 분기 선택 → 성과표 불러오기 */
  const openQuarter = useCallback(
    (q: YearQuarter) => {
      // 이전 분기 내용이 새 분기로 저장되지 않게 — 새 성과표를 불러오기 전까지 편집·저장 막음
      selectedRef.current = q;
      dirtyRef.current = false;
      canEditRef.current = false;
      setSelected(q);
      loadSheet(q);
    },
    [loadSheet]
  );

  const loadQuarters = useCallback(async (selectDefault: boolean) => {
    try {
      const res = await fetch("/api/performance/my", { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setLoadError(data.error ?? "성과 목록을 불러오지 못했습니다.");
        return;
      }
      setQuarters(data.quarters ?? []);
      setStartLabel(data.startLabel ?? "");
      if (selectDefault && data.defaultQuarter) openQuarter(data.defaultQuarter);
    } catch {
      setLoadError("네트워크 오류로 성과 목록을 불러오지 못했습니다.");
    } finally {
      setListLoading(false);
    }
  }, [openQuarter]);

  /** 남은 변경을 저장. keepalive 면 화면을 떠나는 중 — 응답을 기다리지 않는다. */
  const persist = useCallback((opts?: { keepalive?: boolean }): Promise<boolean> => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const q = selectedRef.current;
    if (!q || !dirtyRef.current || !canEditRef.current) return Promise.resolve(true);

    const ver = editVerRef.current;
    const body = JSON.stringify({ year: q.year, quarter: q.quarter, content: contentRef.current });

    if (opts?.keepalive) {
      dirtyRef.current = false;
      // 실패하면 그 사이 더 바뀐 내용이 없고 같은 분기일 때 dirty 를 되돌려 다음 저장에서 다시 보낸다
      const restoreDirty = () => {
        const cur = selectedRef.current;
        if (ver === editVerRef.current && cur && cur.year === q.year && cur.quarter === q.quarter) {
          dirtyRef.current = true;
        }
      };
      fetch(SHEET_URL, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body,
        keepalive: new TextEncoder().encode(body).length < KEEPALIVE_MAX_BYTES,
      })
        .then((res) => {
          if (!res.ok) restoreDirty();
        })
        .catch(restoreDirty);
      return Promise.resolve(true);
    }

    const run = async (): Promise<boolean> => {
      const isCurrent = () => {
        const cur = selectedRef.current;
        return !!cur && cur.year === q.year && cur.quarter === q.quarter;
      };
      if (isCurrent()) setSaveState("saving");
      try {
        const res = await fetch(SHEET_URL, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body,
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          if (isCurrent()) {
            setSaveState("error");
            setSaveError(data.error ?? "저장하지 못했습니다.");
          }
          return false;
        }
        // 저장하는 사이 더 바뀌었으면 dirty 유지 (다음 저장이 보낸다)
        if (ver === editVerRef.current) dirtyRef.current = false;
        if (isCurrent()) {
          setSaveState("saved");
          setSaveError("");
          setSavedAt(data.updatedAt ?? null);
        }
        setQuarters((prev) =>
          prev.map((x) =>
            x.year === q.year && x.quarter === q.quarter && data.status ? { ...x, status: data.status } : x
          )
        );
        return true;
      } catch {
        if (isCurrent()) {
          setSaveState("error");
          setSaveError("네트워크 오류로 저장하지 못했습니다.");
        }
        return false;
      }
    };
    const p = queueRef.current.then(run, run);
    queueRef.current = p;
    return p;
  }, []);

  // 최초 목록
  useEffect(() => {
    loadQuarters(true);
  }, [loadQuarters]);

  // 화면을 떠날 때(탭 숨김·다른 메뉴로 이동) 남은 변경 즉시 저장
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === "hidden") persist({ keepalive: true });
    };
    // 저장되지 않은 변경이 있을 때만 창 닫기·새로고침 경고
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!dirtyRef.current) return;
      e.preventDefault();
      e.returnValue = "";
    };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("beforeunload", onBeforeUnload);
      persist({ keepalive: true });
    };
  }, [persist]);

  const handleChange = (next: PerfContent) => {
    contentRef.current = next;
    dirtyRef.current = true;
    editVerRef.current += 1;
    setContent(next);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      persist();
    }, AUTOSAVE_MS);
  };

  const selectQuarter = async (q: YearQuarter) => {
    if (selected && selected.year === q.year && selected.quarter === q.quarter) return;
    const ok = await persist(); // 분기 전환 전 남은 변경 저장
    if (!ok && !window.confirm("저장하지 못한 변경이 있습니다. 그래도 다른 분기로 이동하시겠습니까?")) return;
    openQuarter(q);
  };

  const openPreview = () => {
    setSubmitError("");
    setServerErrors([]);
    setPreviewOpen(true);
  };

  const handleSubmit = async () => {
    if (!selected) return;
    // 대기 중인 자동 저장은 취소하고 현재 내용을 제출 API 로 함께 보낸다
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setSubmitting(true);
    setSubmitError("");
    setServerErrors([]);
    try {
      await queueRef.current.catch(() => {}); // 이미 보낸 저장이 끝난 뒤 제출
      const res = await fetch("/api/performance/my/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ year: selected.year, quarter: selected.quarter, content: contentRef.current }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setSubmitError(data.error ?? "제출하지 못했습니다.");
        if (Array.isArray(data.errors)) setServerErrors(data.errors);
        return;
      }
      dirtyRef.current = false;
      setPreviewOpen(false);
      showToast("제출했습니다.");
      await Promise.all([loadSheet(selected), loadQuarters(false)]);
    } catch {
      setSubmitError("네트워크 오류로 제출하지 못했습니다.");
    } finally {
      setSubmitting(false);
    }
  };

  /** 지난 분기 기본 정보·목표 제안 불러오기 — 내용만 바꾸고 자동 저장 흐름을 그대로 탄다 */
  const importFromPrevious = () => {
    if (!sheet) return;
    const r = importPrevious(contentRef.current, sheet.previous);
    if (r.imported === 0 && r.basicFilled === 0) {
      showToast("목표 표에 빈 자리가 없어 불러오지 못했습니다.");
      return;
    }
    handleChange(r.content);
    if (r.basicFilled > 0 && r.imported > 0) showToast(`기본 정보와 목표 ${r.imported}개를 불러왔습니다.`);
    else if (r.basicFilled > 0) showToast("기본 정보를 불러왔습니다.");
    else showToast(`목표 ${r.imported}개를 불러왔습니다.`);
  };

  const canEdit = !!sheet?.access.canEdit;
  const pending = canEdit && sheet ? pendingProposals(content, sheet.previous) : [];
  const pendingBasic = canEdit && sheet ? pendingBasicFields(content, sheet.previous) : [];
  const importText = !sheet?.previous
    ? ""
    : pendingBasic.length > 0 && pending.length > 0
      ? `${sheet.previous.label} 성과표에서 기본 정보(부서·직급 등)와 다음 분기 목표 제안 ${pending.length}개를 불러올 수 있습니다.`
      : pendingBasic.length > 0
        ? `${sheet.previous.label} 성과표에서 기본 정보(부서·직급 등)를 불러올 수 있습니다.`
        : pending.length > 0
          ? `${sheet.previous.label}에 제안한 다음 분기 목표 ${pending.length}개가 있습니다.`
          : "";

  // 분기 선택 — 최근 4개는 버튼(오래된 순), 그보다 앞은 "이전 분기" 선택 상자(최근 순)
  const recentQuarters = quarters.slice(-RECENT_QUARTER_BUTTONS);
  const olderQuarters = quarters.slice(0, Math.max(0, quarters.length - RECENT_QUARTER_BUTTONS)).reverse();
  const selectedOlder =
    selected && olderQuarters.some((q) => q.year === selected.year && q.quarter === selected.quarter)
      ? quarterKey(selected.year, selected.quarter)
      : "";
  const previewErrors = previewOpen ? validateForSubmit(content) : [];

  // ── 상태 띠 ──
  const renderBand = () => {
    if (!sheet) return null;
    const { status, access, cycle } = sheet;
    if (status === "revision") {
      return (
        <div className="flex flex-col sm:flex-row sm:items-center gap-3 bg-purple-50 border border-purple-200 rounded-2xl px-4 py-3">
          <p className="flex-1 text-sm text-purple-800 whitespace-pre-wrap break-words">
            관리자가 수정을 요청했습니다: {sheet.revisionReason}
          </p>
          <button
            onClick={openPreview}
            className="shrink-0 inline-flex items-center justify-center gap-1.5 bg-purple-600 text-white text-sm font-semibold px-4 py-2 rounded-xl hover:bg-purple-700"
          >
            <Send size={14} />다시 제출하기
          </button>
        </div>
      );
    }
    if (status === "submitted") {
      return (
        <div className="bg-emerald-50 border border-emerald-200 rounded-2xl px-4 py-3">
          <p className="text-sm font-semibold text-emerald-800">
            제출 완료{sheet.submittedAt ? ` · ${formatKstShort(sheet.submittedAt)}` : ""}
          </p>
          <p className="text-xs text-emerald-700 mt-0.5">제출한 성과는 수정할 수 없습니다.</p>
        </div>
      );
    }
    if (access.canSubmit && cycle) {
      return (
        <div className="flex flex-col sm:flex-row sm:items-center gap-3 bg-blue-50 border border-blue-200 rounded-2xl px-4 py-3">
          <p className="flex-1 text-sm text-blue-800">
            <span className="font-semibold">{sheet.label} 제출 기간</span>
            {` · ${formatMonthDay(cycle.submitEnd, true)} 마감 · ${dDayLabel(cycle.dDay)}`}
          </p>
          <button
            onClick={openPreview}
            className="shrink-0 inline-flex items-center justify-center gap-1.5 bg-blue-600 text-white text-sm font-semibold px-4 py-2 rounded-xl hover:bg-blue-700"
          >
            <Send size={14} />제출하기
          </button>
        </div>
      );
    }
    if (!access.reason) return null;
    return (
      <div className="bg-gray-50 border border-gray-200 rounded-2xl px-4 py-3 text-sm text-gray-600">
        {access.reason}
      </div>
    );
  };

  return (
    <div className="p-4 sm:p-6 space-y-5">
      {toast && (
        <div className="fixed bottom-6 right-6 z-[60] bg-emerald-600 text-white text-sm font-medium px-5 py-3 rounded-xl shadow-lg">
          {toast}
        </div>
      )}

      {/* 헤더 */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold text-gray-900 flex items-center gap-2">
            <Target size={20} />
            내 성과
            <PerfExampleBadge />
          </h1>
          <p className="text-sm text-gray-500 mt-0.5">분기 초 목표 설정 → 분기 말 성과 작성 → 면담에서 확인</p>
        </div>
        {canEdit && (
          <div className="text-xs pt-2 shrink-0">
            {saveState === "saving" && (
              <span className="inline-flex items-center gap-1 text-gray-400">
                <Loader2 size={12} className="animate-spin" />저장 중…
              </span>
            )}
            {saveState === "saved" && savedAt && (
              <span className="text-gray-400">저장됨 {formatKstTime(savedAt)}</span>
            )}
            {saveState === "error" && (
              <button
                onClick={() => persist()}
                className="text-rose-600 hover:underline"
                title={saveError || undefined}
              >
                저장 실패 · 다시 시도
              </button>
            )}
          </div>
        )}
      </div>

      {listLoading ? (
        <div className="flex items-center justify-center py-20 text-gray-400">
          <Loader2 className="animate-spin mr-2" size={20} />
          불러오는 중...
        </div>
      ) : (
        <>
          {/* 분기 선택 */}
          {quarters.length === 0 && startLabel && (
            <div className="bg-gray-50 border border-gray-200 rounded-2xl px-4 py-6 text-center text-sm text-gray-500">
              성과 관리는 {startLabel}부터 시작합니다.
            </div>
          )}
          <div className="flex gap-2 overflow-x-auto pb-1">
            {olderQuarters.length > 0 && (
              <select
                value={selectedOlder}
                onChange={(e) => {
                  const q = olderQuarters.find((x) => quarterKey(x.year, x.quarter) === e.target.value);
                  if (q) selectQuarter({ year: q.year, quarter: q.quarter });
                }}
                aria-label="이전 분기"
                className={`shrink-0 px-3 py-2 rounded-xl border text-sm outline-none ${
                  selectedOlder
                    ? "border-blue-500 bg-blue-50 text-blue-700 font-semibold"
                    : "border-gray-200 bg-white text-gray-600 hover:bg-gray-50"
                }`}
              >
                <option value="" disabled>
                  이전 분기
                </option>
                {olderQuarters.map((q) => (
                  <option key={quarterKey(q.year, q.quarter)} value={quarterKey(q.year, q.quarter)}>
                    {q.label} · {SHEET_STATUS_META[q.status].label}
                  </option>
                ))}
              </select>
            )}
            {recentQuarters.map((q) => {
              const active = selected?.year === q.year && selected?.quarter === q.quarter;
              return (
                <button
                  key={quarterKey(q.year, q.quarter)}
                  onClick={() => selectQuarter({ year: q.year, quarter: q.quarter })}
                  className={`shrink-0 flex items-center gap-2 px-3 py-2 rounded-xl border text-sm transition-colors ${
                    active
                      ? "border-blue-500 bg-blue-50 text-blue-700 font-semibold"
                      : "border-gray-200 bg-white text-gray-600 hover:bg-gray-50"
                  }`}
                >
                  {q.label}
                  <PerfStatusBadge status={q.status} />
                </button>
              );
            })}
          </div>

          {loadError && <div className="text-sm text-rose-600">{loadError}</div>}

          {sheetLoading && !sheet ? (
            <div className="flex justify-center py-16">
              <Loader2 className="animate-spin text-gray-400" size={28} />
            </div>
          ) : (
            sheet && (
              <div className={`space-y-4 ${sheetLoading ? "opacity-60 pointer-events-none" : ""}`}>
                {renderBand()}
                {importText && (
                  <div className="flex flex-col sm:flex-row sm:items-center gap-3 bg-sky-50 border border-sky-200 rounded-2xl px-4 py-3">
                    <p className="flex-1 text-sm text-sky-800">{importText}</p>
                    <button
                      onClick={importFromPrevious}
                      className="shrink-0 inline-flex items-center justify-center gap-1.5 bg-white border border-sky-300 text-sky-700 text-sm font-semibold px-4 py-2 rounded-xl hover:bg-sky-100"
                    >
                      <Download size={14} />불러오기
                    </button>
                  </div>
                )}
                <PerfSheetForm
                  form={PERF_FORM}
                  content={content}
                  onChange={canEdit ? handleChange : undefined}
                  readOnly={!canEdit}
                  info={sheet.info}
                />
              </div>
            )
          )}
        </>
      )}

      {/* 제출 미리보기 — 배경 클릭으로 닫히지 않음 */}
      {previewOpen && sheet && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-4xl max-h-[90vh] flex flex-col">
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
              <div className="min-w-0">
                <h2 className="text-lg font-bold text-gray-900">제출 미리보기</h2>
                <p className="text-xs text-gray-500 mt-0.5">{sheet.label} · 관리자에게 보이는 모습입니다</p>
              </div>
              <button
                onClick={() => setPreviewOpen(false)}
                disabled={submitting}
                className="text-gray-400 hover:text-gray-700 disabled:opacity-50 shrink-0"
              >
                <X size={20} />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-5 space-y-4 bg-gray-50">
              {previewErrors.length > 0 && (
                <div className="bg-rose-50 border border-rose-200 rounded-xl px-4 py-3">
                  <p className="text-sm font-semibold text-rose-700">입력하지 않은 항목이 있습니다</p>
                  <ul className="mt-1 list-disc pl-5 text-sm text-rose-700 space-y-0.5">
                    {previewErrors.map((e) => (
                      <li key={e}>{e}</li>
                    ))}
                  </ul>
                </div>
              )}
              <PerfSheetForm form={PERF_FORM} content={content} readOnly info={sheet.info} />
            </div>

            <div className="px-5 py-4 border-t border-gray-100 space-y-3">
              <p className="flex items-start gap-2 text-sm text-amber-700">
                <AlertTriangle size={16} className="shrink-0 mt-0.5" />
                제출하면 수정할 수 없습니다. 수정은 관리자의 수정 요청이 있어야 가능합니다.
              </p>
              {submitError && (
                <div className="text-sm text-rose-600">
                  {submitError}
                  {serverErrors.length > 0 && (
                    <ul className="mt-1 list-disc pl-5">
                      {serverErrors.map((e) => (
                        <li key={e}>{e}</li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
              <div className="flex justify-end gap-2">
                <button
                  onClick={() => setPreviewOpen(false)}
                  disabled={submitting}
                  className="px-4 py-2.5 bg-white border border-gray-200 text-gray-600 rounded-xl text-sm font-medium hover:bg-gray-50 disabled:opacity-50"
                >
                  취소
                </button>
                <button
                  onClick={handleSubmit}
                  disabled={submitting || previewErrors.length > 0}
                  className="inline-flex items-center gap-2 bg-blue-600 text-white text-sm font-semibold px-5 py-2.5 rounded-xl hover:bg-blue-700 disabled:opacity-50"
                >
                  {submitting && <Loader2 size={16} className="animate-spin" />}
                  제출
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

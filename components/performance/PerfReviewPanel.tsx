"use client";

import { useState, type MutableRefObject } from "react";
import { Loader2, Lock, RotateCcw } from "lucide-react";
import PerfSheetForm from "@/components/performance/PerfSheetForm";
import {
  PERF_REVIEW_FORM,
  hasAnyContent,
  validateForSubmit,
  withDisplayRows,
  type PerfContent,
  type PerfRow,
} from "@/lib/performance/form";
import { formatKstDateDot, formatKstShort } from "@/lib/performance/rules";

// 04 면담 및 평가 기록 패널 — 성과 관리 화면의 제출본 열람 아래. 관리자 전용 (직원 화면에는 쓰지 않는다).
// 기록이 바뀌어 다시 불러오면 부모가 key 를 바꿔 새로 마운트한다 (편집 상태 초기화).

export interface PerfReviewData {
  content: PerfContent;
  updatedAt: string | null;
  updatedByName: string | null;
  finalizedAt: string | null;
  finalizedByName: string | null;
}

/** 빈 기록이면 평가자 칸을 로그인한 관리자 이름으로 미리 채운다 (변경으로 보지 않음) */
function initialContent(review: PerfReviewData, viewerName: string): PerfContent {
  const c = withDisplayRows(review.content, PERF_REVIEW_FORM);
  if (review.finalizedAt || review.updatedAt || hasAnyContent(review.content, PERF_REVIEW_FORM) || !viewerName) {
    return c;
  }
  const meeting = (c.meeting as PerfRow | undefined) ?? {};
  return { ...c, meeting: { ...meeting, evaluator: viewerName } };
}

export default function PerfReviewPanel({
  employeeId,
  year,
  quarter,
  review,
  viewerName,
  dirtyRef,
  onChanged,
  onReload,
  showToast,
}: {
  employeeId: number;
  year: number;
  quarter: number;
  review: PerfReviewData;
  viewerName: string;
  /** 저장하지 않은 변경 여부 — 부모가 이동·창 닫기 확인에 쓴다 */
  dirtyRef: MutableRefObject<boolean>;
  /** 저장·확정·확정 취소 뒤 — 목록 배지와 열람 내용을 다시 불러온다 */
  onChanged: () => Promise<void> | void;
  /** 열람 내용만 다시 불러오기 (409 뒤) */
  onReload: () => void;
  showToast: (msg: string) => void;
}) {
  const [content, setContent] = useState<PerfContent>(() => initialContent(review, viewerName));
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<"" | "save" | "finalize" | "unfinalize">("");
  const [error, setError] = useState("");
  const [needsReload, setNeedsReload] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [serverErrors, setServerErrors] = useState<string[]>([]);

  const finalized = !!review.finalizedAt;
  const target = { employeeId, year, quarter };

  const handleChange = (next: PerfContent) => {
    setContent(next);
    setDirty(true);
    dirtyRef.current = true;
  };

  /** 409 등 실패 응답 처리 */
  const fail = (res: Response, data: { error?: string }, fallback: string) => {
    setError(data.error ?? fallback);
    setNeedsReload(res.status === 409);
  };

  const save = async () => {
    setBusy("save");
    setError("");
    setNeedsReload(false);
    try {
      const res = await fetch("/api/performance/sheets/review", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...target, content, baseUpdatedAt: review.updatedAt }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return fail(res, data, "면담 기록을 저장하지 못했습니다.");
      dirtyRef.current = false;
      setDirty(false);
      showToast("면담 기록을 저장했습니다.");
      await onChanged();
    } catch {
      setError("네트워크 오류로 저장하지 못했습니다.");
    } finally {
      setBusy("");
    }
  };

  const openFinalize = () => {
    setServerErrors([]);
    setError("");
    setConfirmOpen(true);
  };

  const finalize = async () => {
    setBusy("finalize");
    setServerErrors([]);
    try {
      const res = await fetch("/api/performance/sheets/review/finalize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...target, content, baseUpdatedAt: review.updatedAt }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (res.status === 400 && Array.isArray(data.errors)) {
          setServerErrors(data.errors);
          return;
        }
        setConfirmOpen(false);
        return fail(res, data, "평가를 확정하지 못했습니다.");
      }
      dirtyRef.current = false;
      setDirty(false);
      setConfirmOpen(false);
      showToast("평가를 확정했습니다.");
      await onChanged();
    } catch {
      setServerErrors(["네트워크 오류로 확정하지 못했습니다."]);
    } finally {
      setBusy("");
    }
  };

  const unfinalize = async () => {
    if (!window.confirm("평가 확정을 취소할까요? 취소하면 면담 기록을 다시 수정할 수 있습니다.")) return;
    setBusy("unfinalize");
    setError("");
    setNeedsReload(false);
    try {
      const res = await fetch("/api/performance/sheets/review/unfinalize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(target),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return fail(res, data, "확정을 취소하지 못했습니다.");
      showToast("평가 확정을 취소했습니다.");
      await onChanged();
    } catch {
      setError("네트워크 오류로 확정을 취소하지 못했습니다.");
    } finally {
      setBusy("");
    }
  };

  const reload = () => {
    dirtyRef.current = false;
    onReload();
  };

  const validationErrors = confirmOpen ? validateForSubmit(content, PERF_REVIEW_FORM) : [];
  const modalErrors = serverErrors.length > 0 ? serverErrors : validationErrors;

  const aside = (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-gray-100 text-[11px] font-semibold text-gray-600">
      <Lock size={11} />
      관리자 전용 · 직원에게 보이지 않습니다
    </span>
  );

  return (
    <div className="border-t-2 border-dashed border-gray-200 pt-5 space-y-3">
      <PerfSheetForm
        form={PERF_REVIEW_FORM}
        content={content}
        onChange={finalized ? undefined : handleChange}
        readOnly={finalized}
        titleAside={aside}
      />

      {error && (
        <div className="flex flex-wrap items-center gap-2 bg-rose-50 border border-rose-200 rounded-xl px-3 py-2 text-sm text-rose-700">
          <span className="flex-1 min-w-0">{error}</span>
          {needsReload && (
            <button
              onClick={reload}
              className="shrink-0 inline-flex items-center gap-1 px-3 py-1.5 bg-white border border-rose-200 rounded-lg text-xs font-semibold hover:bg-rose-100"
            >
              <RotateCcw size={12} />다시 불러오기
            </button>
          )}
        </div>
      )}

      {finalized ? (
        <div className="flex flex-wrap items-center gap-2 bg-indigo-50 border border-indigo-200 rounded-xl px-3 py-2">
          <span className="flex-1 min-w-0 text-sm font-semibold text-indigo-800">
            평가 확정 {formatKstDateDot(review.finalizedAt!)}
            {review.finalizedByName ? ` · ${review.finalizedByName}` : ""}
          </span>
          <button
            onClick={unfinalize}
            disabled={!!busy}
            className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 bg-white border border-indigo-200 text-indigo-700 rounded-lg text-xs font-semibold hover:bg-indigo-100 disabled:opacity-50"
          >
            {busy === "unfinalize" && <Loader2 size={12} className="animate-spin" />}
            확정 취소
          </button>
        </div>
      ) : (
        <div className="flex flex-col sm:flex-row sm:items-center gap-2">
          <p className={`flex-1 text-xs ${dirty ? "text-amber-700" : "text-gray-400"}`}>
            {dirty
              ? "저장하지 않은 변경이 있습니다"
              : review.updatedAt
                ? `저장됨 ${formatKstShort(review.updatedAt)}${review.updatedByName ? ` · ${review.updatedByName}` : ""}`
                : ""}
          </p>
          <div className="flex justify-end gap-2">
            <button
              onClick={save}
              disabled={!!busy || !dirty}
              className="inline-flex items-center gap-1.5 px-4 py-2 bg-white border border-gray-200 text-gray-700 rounded-xl text-sm font-semibold hover:bg-gray-50 disabled:opacity-50"
            >
              {busy === "save" && <Loader2 size={14} className="animate-spin" />}
              저장
            </button>
            <button
              onClick={openFinalize}
              disabled={!!busy}
              className="px-4 py-2 bg-indigo-600 text-white rounded-xl text-sm font-semibold hover:bg-indigo-700 disabled:opacity-50"
            >
              평가 확정
            </button>
          </div>
        </div>
      )}

      {/* 평가 확정 확인 — 배경 클릭으로 닫히지 않음 */}
      {confirmOpen && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-6 space-y-4">
            <h3 className="text-lg font-bold text-gray-900">평가 확정</h3>
            {modalErrors.length > 0 ? (
              <div className="bg-rose-50 border border-rose-200 rounded-xl px-4 py-3">
                <p className="text-sm font-semibold text-rose-700">입력하지 않은 항목이 있습니다</p>
                <ul className="mt-1 list-disc pl-5 text-sm text-rose-700 space-y-0.5">
                  {modalErrors.map((e) => (
                    <li key={e}>{e}</li>
                  ))}
                </ul>
              </div>
            ) : (
              <p className="text-sm text-gray-600">확정하면 기록이 잠기고, 직원에게 수정 요청을 보낼 수 없습니다.</p>
            )}
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setConfirmOpen(false)}
                disabled={busy === "finalize"}
                className="px-4 py-2 text-sm font-medium text-gray-600 bg-gray-100 rounded-xl hover:bg-gray-200 disabled:opacity-50"
              >
                취소
              </button>
              <button
                onClick={finalize}
                disabled={busy === "finalize" || modalErrors.length > 0}
                className="inline-flex items-center gap-2 px-4 py-2 text-sm font-bold text-white bg-indigo-600 rounded-xl hover:bg-indigo-700 disabled:opacity-50"
              >
                {busy === "finalize" && <Loader2 size={14} className="animate-spin" />}
                확정
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

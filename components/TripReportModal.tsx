"use client";

import { useState, useEffect, useCallback } from "react";
import { Loader2, X, FileText, Plus, Trash2 } from "lucide-react";

// 경비 행 — 화면 입력값. 금액은 입력 중 빈 문자열이 될 수 있어 string으로 다룬다.
interface ExpenseRow {
  method: string;
  item: string;
  amount: string;
  projectName: string;
  note: string;
}

export interface TripReportTarget {
  kind: "trip" | "request";
  refId: number;
  title: string;
  location: string | null;
  startDate: string | null;
  endDate: string | null;
  myDates: { date: string | null; startTime: string | null; endTime: string | null }[];
}

const EMPTY_ROW: ExpenseRow = {
  method: "",
  item: "",
  amount: "",
  projectName: "",
  note: "",
};

function formatWon(n: number): string {
  return n.toLocaleString("ko-KR");
}

// 서버는 UTC — 저장 시각은 KST로 표기한다.
function formatKst(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
}

/** 제출/수정 시각 안내 문구 — 보고서가 없으면 null */
function timestampLabel(
  status: string,
  submittedAt: string | null,
  updatedAt: string | null
): string | null {
  const updated = formatKst(updatedAt);
  if (status === "submitted") {
    const submitted = formatKst(submittedAt);
    if (!submitted) return updated ? `최종 수정: ${updated}` : null;
    // 제출 후 수정된 적이 있으면(1분 이상 차이) 최종 수정 시각을 병기
    const gapMs =
      submittedAt && updatedAt
        ? new Date(updatedAt).getTime() - new Date(submittedAt).getTime()
        : 0;
    const edited = gapMs >= 60_000 && updated;
    return `제출일: ${submitted}${edited ? ` · 최종 수정: ${updated}` : ""}`;
  }
  if (status === "draft") {
    return updated ? `임시저장 · 최종 수정: ${updated}` : "임시저장";
  }
  return null;
}

/** 참가일자에 시간이 있으면 "HH:MM~HH:MM"로 업무시간 프리필 */
function prefillWorkHours(target: TripReportTarget): string {
  const withTime = target.myDates.find((d) => d.startTime && d.endTime);
  return withTime ? `${withTime.startTime}~${withTime.endTime}` : "";
}

/** 출장 일자 표시 — 그룹출장은 참가일자 나열, 단건 신청은 기간 */
function tripDateLabel(target: TripReportTarget): string {
  if (target.kind === "trip") {
    const dates = target.myDates.map((d) => d.date).filter(Boolean);
    if (dates.length > 0) return dates.join(", ");
  }
  if (target.startDate && target.endDate) {
    return target.startDate === target.endDate
      ? target.startDate
      : `${target.startDate} ~ ${target.endDate}`;
  }
  return target.startDate ?? target.endDate ?? "-";
}

export default function TripReportModal({
  target,
  employeeName,
  onClose,
  onSaved,
  readOnly = false,
}: {
  target: TripReportTarget;
  /** 출장자 표시용. 관리자 열람에서는 대상 직원 이름을 넘긴다. */
  employeeName?: string;
  onClose: () => void;
  onSaved?: () => void;
  /** true면 열람 전용 — 입력 잠금 + 저장/제출 버튼 없음 (기본 false: 기존 동작) */
  readOnly?: boolean;
}) {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");
  const [toast, setToast] = useState("");

  const [status, setStatus] = useState<string>("none");
  const [submittedAt, setSubmittedAt] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [workHours, setWorkHours] = useState("");
  const [region, setRegion] = useState("");
  const [destination, setDestination] = useState("");
  const [detail, setDetail] = useState("");
  const [followup, setFollowup] = useState("");
  const [expenses, setExpenses] = useState<ExpenseRow[]>([{ ...EMPTY_ROW }]);

  const refQuery =
    target.kind === "trip"
      ? `participantId=${target.refId}`
      : `requestId=${target.refId}`;

  // 기존 보고서 로드 (없으면 빈 폼 + 참가일자 기반 프리필)
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setLoadError("");
      try {
        const res = await fetch(`/api/trip-reports?${refQuery}`);
        const json = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok) {
          setLoadError(json.error ?? "보고서를 불러오지 못했습니다.");
          return;
        }
        if (json.report) {
          const r = json.report;
          setStatus(r.status ?? "draft");
          setSubmittedAt(r.submittedAt ?? null);
          setUpdatedAt(r.updatedAt ?? null);
          setWorkHours(r.workHours ?? "");
          setRegion(r.region ?? "");
          setDestination(r.destination ?? "");
          setDetail(r.detail ?? "");
          setFollowup(r.followup ?? "");
          setExpenses(
            Array.isArray(r.expenses) && r.expenses.length > 0
              ? r.expenses.map(
                  (e: {
                    method: string;
                    item: string;
                    amount: number;
                    projectName: string | null;
                    note: string | null;
                  }) => ({
                    method: e.method ?? "",
                    item: e.item ?? "",
                    amount: String(e.amount ?? ""),
                    projectName: e.projectName ?? "",
                    note: e.note ?? "",
                  })
                )
              : [{ ...EMPTY_ROW }]
          );
        } else {
          setStatus("none");
          setWorkHours(prefillWorkHours(target));
        }
      } catch (e) {
        console.error("GET /api/trip-reports error:", e);
        if (!cancelled) setLoadError("네트워크 오류로 보고서를 불러오지 못했습니다.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refQuery]);

  // ESC로 닫기 (저장 중에는 무시)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && readOnly && !saving) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, saving, readOnly]);

  const updateRow = (idx: number, patch: Partial<ExpenseRow>) => {
    setExpenses((prev) =>
      prev.map((r, i) => (i === idx ? { ...r, ...patch } : r))
    );
  };
  const removeRow = (idx: number) => {
    setExpenses((prev) =>
      prev.length <= 1 ? [{ ...EMPTY_ROW }] : prev.filter((_, i) => i !== idx)
    );
  };

  const totalAmount = expenses.reduce((sum, r) => {
    const n = Number(r.amount);
    return sum + (Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);
  }, 0);

  const isSubmitted = status === "submitted";

  const handleSave = useCallback(
    async (submit: boolean) => {
      // 완전히 빈 행은 저장에서 제외 (사용자가 '행 추가'만 눌러둔 경우)
      const rows = expenses.filter(
        (r) => r.method.trim() || r.item.trim() || r.amount.trim()
      );
      for (const [i, r] of rows.entries()) {
        if (!r.method.trim() || !r.item.trim()) {
          setFormError(`경비 ${i + 1}행: 수단과 항목을 입력해 주세요.`);
          return;
        }
        const n = Number(r.amount);
        if (!Number.isInteger(n) || n < 0) {
          setFormError(`경비 ${i + 1}행: 금액은 0 이상의 정수여야 합니다.`);
          return;
        }
      }

      setSaving(true);
      setFormError("");
      try {
        const res = await fetch("/api/trip-reports", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...(target.kind === "trip"
              ? { tripParticipantId: target.refId }
              : { attendanceRequestId: target.refId }),
            workHours,
            region,
            destination,
            detail,
            followup,
            expenses: rows.map((r) => ({
              method: r.method.trim(),
              item: r.item.trim(),
              amount: Number(r.amount),
              projectName: r.projectName.trim() || null,
              note: r.note.trim() || null,
            })),
            submit,
          }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) {
          setFormError(json.error ?? "저장에 실패했습니다.");
          setSaving(false);
          return;
        }
        setToast(submit ? "보고서가 제출되었습니다." : "임시저장되었습니다.");
        setTimeout(() => {
          onSaved?.();
          onClose();
        }, 1100);
      } catch (e) {
        console.error("PUT /api/trip-reports error:", e);
        setFormError("네트워크 오류로 저장에 실패했습니다.");
        setSaving(false);
      }
    },
    [expenses, workHours, region, destination, detail, followup, target, onSaved, onClose]
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={readOnly && !saving ? onClose : undefined}
    >
      {toast && (
        <div className="fixed bottom-6 right-6 z-[60] bg-emerald-600 text-white text-sm font-medium px-5 py-3 rounded-xl shadow-lg">
          {toast}
        </div>
      )}
      <div
        className="bg-white rounded-2xl shadow-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 헤더 */}
        <div className="sticky top-0 bg-white flex items-center justify-between px-5 py-4 border-b border-gray-100 z-10">
          <div className="min-w-0">
            <h2 className="text-lg font-bold text-gray-900 flex items-center gap-2">
              <FileText size={18} className="text-blue-600" />
              출장보고서
            </h2>
            <p className="text-xs text-gray-500 truncate mt-0.5">{target.title}</p>
          </div>
          <button
            onClick={onClose}
            disabled={saving}
            className="text-gray-400 hover:text-gray-700 disabled:opacity-50 shrink-0"
          >
            <X size={20} />
          </button>
        </div>

        {loading ? (
          <div className="flex justify-center py-16">
            <Loader2 className="animate-spin text-gray-400" size={28} />
          </div>
        ) : loadError ? (
          <div className="p-6 text-center text-sm text-rose-600">{loadError}</div>
        ) : (
          <div className="p-5 space-y-4">
            {/* 작성/제출 시각 — 기존 보고서가 있을 때만 */}
            {(() => {
              const label = timestampLabel(status, submittedAt, updatedAt);
              return label ? (
                <p className="text-[11px] text-gray-400">{label}</p>
              ) : null;
            })()}

            {readOnly ? (
              status === "none" ? (
                <div className="text-xs bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 text-gray-600">
                  아직 작성되지 않은 보고서입니다.
                </div>
              ) : (
                <div className="text-xs bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 text-gray-600">
                  열람 전용입니다.
                  {status === "draft" && " (작성 중인 보고서)"}
                </div>
              )
            ) : (
              isSubmitted && (
                <div className="text-xs bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2 text-emerald-800">
                  제출 완료된 보고서입니다. 내용을 고치면 수정 저장됩니다.
                </div>
              )
            )}

            {/* 출장자 / 출장 일자 — 읽기전용 */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-semibold text-gray-500 mb-1">
                  출장자
                </label>
                <div className="px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm text-gray-700">
                  {employeeName || "-"}
                </div>
              </div>
              <div>
                <label className="block text-xs font-semibold text-gray-500 mb-1">
                  출장 일자
                </label>
                <div className="px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm text-gray-700 break-words">
                  {tripDateLabel(target)}
                </div>
              </div>
            </div>

            {/* 출장 업무 시간 */}
            <div>
              <label className="block text-xs font-semibold text-gray-500 mb-1">
                출장 업무 시간
              </label>
              <input
                type="text"
                value={workHours}
                onChange={(e) => setWorkHours(e.target.value)}
                disabled={readOnly}
                placeholder="10:00~15:00 (출장 출발 ~ 출장업무 끝나는 시간)"
                className="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-blue-200 disabled:bg-gray-50 disabled:text-gray-600"
              />
            </div>

            {/* 지역 / 목적지 */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-semibold text-gray-500 mb-1">
                  출장 지역
                </label>
                <input
                  type="text"
                  value={region}
                  onChange={(e) => setRegion(e.target.value)}
                  disabled={readOnly}
                  placeholder="예: 대전"
                  className="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-blue-200 disabled:bg-gray-50 disabled:text-gray-600"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-gray-500 mb-1">
                  출장 목적지
                </label>
                <input
                  type="text"
                  value={destination}
                  onChange={(e) => setDestination(e.target.value)}
                  disabled={readOnly}
                  placeholder="예: 한국전자통신연구원"
                  className="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-blue-200 disabled:bg-gray-50 disabled:text-gray-600"
                />
              </div>
            </div>

            {/* 상세 내용 */}
            <div>
              <label className="block text-xs font-semibold text-gray-500 mb-1">
                출장 상세 내용
              </label>
              <textarea
                value={detail}
                onChange={(e) => setDetail(e.target.value)}
                disabled={readOnly}
                rows={4}
                placeholder="출장에서 수행한 업무 내용을 작성하세요"
                className="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-blue-200 resize-y disabled:bg-gray-50 disabled:text-gray-600"
              />
            </div>

            {/* 후속조치 */}
            <div>
              <label className="block text-xs font-semibold text-gray-500 mb-1">
                후속조치 및 계획
              </label>
              <textarea
                value={followup}
                onChange={(e) => setFollowup(e.target.value)}
                disabled={readOnly}
                rows={3}
                placeholder="후속으로 진행할 사항을 작성하세요"
                className="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-blue-200 resize-y disabled:bg-gray-50 disabled:text-gray-600"
              />
            </div>

            {/* 사용 경비 */}
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-xs font-semibold text-gray-500">
                  사용 경비
                </label>
                {!readOnly && (
                  <button
                    type="button"
                    onClick={() =>
                      setExpenses((p) =>
                        p.length >= 20 ? p : [...p, { ...EMPTY_ROW }]
                      )
                    }
                    disabled={expenses.length >= 20}
                    className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold text-blue-600 border border-blue-200 rounded-lg hover:bg-blue-50 disabled:opacity-50"
                    title={expenses.length >= 20 ? "최대 20행까지 입력할 수 있습니다" : undefined}
                  >
                    <Plus size={12} />행 추가
                  </button>
                )}
              </div>

              <div className="space-y-2">
                {expenses.map((r, i) => (
                  <div
                    key={i}
                    className="bg-gray-50 border border-gray-100 rounded-xl p-2.5 space-y-2"
                  >
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={r.method}
                        onChange={(e) => updateRow(i, { method: e.target.value })}
                        disabled={readOnly}
                        placeholder="R&D Card"
                        className="flex-1 min-w-0 px-2.5 py-2 border border-gray-200 rounded-lg text-xs bg-white outline-none focus:ring-2 focus:ring-blue-200 disabled:bg-gray-50 disabled:text-gray-600"
                      />
                      <input
                        type="text"
                        value={r.item}
                        onChange={(e) => updateRow(i, { item: e.target.value })}
                        disabled={readOnly}
                        placeholder="교통비"
                        className="flex-1 min-w-0 px-2.5 py-2 border border-gray-200 rounded-lg text-xs bg-white outline-none focus:ring-2 focus:ring-blue-200 disabled:bg-gray-50 disabled:text-gray-600"
                      />
                      {!readOnly && (
                        <button
                          type="button"
                          onClick={() => removeRow(i)}
                          className="p-1.5 rounded-lg text-gray-400 hover:text-rose-600 hover:bg-rose-50 shrink-0"
                          aria-label={`경비 ${i + 1}행 삭제`}
                        >
                          <Trash2 size={14} />
                        </button>
                      )}
                    </div>
                    <div className="flex gap-2">
                      <div className="relative flex-1 min-w-0">
                        <input
                          type="number"
                          min={0}
                          step={1}
                          value={r.amount}
                          onChange={(e) => updateRow(i, { amount: e.target.value })}
                          disabled={readOnly}
                          placeholder="금액"
                          className="w-full pl-2.5 pr-6 py-2 border border-gray-200 rounded-lg text-xs bg-white outline-none focus:ring-2 focus:ring-blue-200 disabled:bg-gray-50 disabled:text-gray-600"
                        />
                        <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-gray-400">
                          원
                        </span>
                      </div>
                      <input
                        type="text"
                        value={r.projectName}
                        onChange={(e) => updateRow(i, { projectName: e.target.value })}
                        disabled={readOnly}
                        placeholder="딥테크팁스"
                        className="flex-1 min-w-0 px-2.5 py-2 border border-gray-200 rounded-lg text-xs bg-white outline-none focus:ring-2 focus:ring-blue-200 disabled:bg-gray-50 disabled:text-gray-600"
                      />
                    </div>
                    <input
                      type="text"
                      value={r.note}
                      onChange={(e) => updateRow(i, { note: e.target.value })}
                      disabled={readOnly}
                      placeholder="비고 (선택)"
                      className="w-full px-2.5 py-2 border border-gray-200 rounded-lg text-xs bg-white outline-none focus:ring-2 focus:ring-blue-200 disabled:bg-gray-50 disabled:text-gray-600"
                    />
                  </div>
                ))}
              </div>

              <div className="flex justify-end mt-2 text-sm">
                <span className="text-gray-500 mr-2">합계</span>
                <span className="font-bold text-gray-900">
                  {formatWon(totalAmount)}원
                </span>
              </div>
            </div>

            {formError && <div className="text-sm text-rose-600">{formError}</div>}

            {/* 하단 버튼 — 열람 전용이면 닫기만 */}
            {readOnly ? (
              <div className="flex justify-end pt-1">
                <button
                  onClick={onClose}
                  className="px-5 py-2.5 bg-gray-100 text-gray-700 rounded-xl text-sm font-semibold hover:bg-gray-200"
                >
                  닫기
                </button>
              </div>
            ) : (
            <div className="flex justify-end gap-2 pt-1">
              <button
                onClick={onClose}
                disabled={saving}
                className="px-4 py-2.5 bg-white border border-gray-200 text-gray-600 rounded-xl text-sm font-medium hover:bg-gray-50 disabled:opacity-50"
              >
                취소
              </button>
              {!isSubmitted && (
                <button
                  onClick={() => handleSave(false)}
                  disabled={saving}
                  className="px-4 py-2.5 bg-white border border-blue-200 text-blue-700 rounded-xl text-sm font-semibold hover:bg-blue-50 disabled:opacity-50"
                >
                  임시저장
                </button>
              )}
              <button
                onClick={() => handleSave(true)}
                disabled={saving}
                className="inline-flex items-center gap-2 bg-blue-600 text-white text-sm font-semibold px-5 py-2.5 rounded-xl hover:bg-blue-700 disabled:opacity-50"
              >
                {saving && <Loader2 size={16} className="animate-spin" />}
                {isSubmitted ? "수정 저장" : "제출"}
              </button>
            </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

"use client";

import { useState, useEffect, useCallback } from "react";
import { Loader2, X, Clock, Check } from "lucide-react";

// schedule 원소: { dayIndex, start, end, type } — dayIndex는 "그 주 월요일=0" 기준
interface SchedulePoint {
  dayIndex: number;
  start: string | null;
  end: string | null;
  type: string;
}

interface ShiftPattern {
  id: number;
  name: string;
  description: string | null;
  cycleDays: number;
  schedule: SchedulePoint[];
}

interface CurrentShift extends ShiftPattern {
  startDate: string;
}

interface MyShiftResponse {
  currentShift: CurrentShift | null;
  patterns: ShiftPattern[];
  attendedToday: boolean;
  effectiveDate: string; // "YYYY-MM-DD"
}

const WEEKDAY = ["월", "화", "수", "목", "금", "토", "일"];

// 스케줄 그리드 — dayIndex 오름차순, cycleDays>7이면 주차로 묶어 표시.
function ScheduleGrid({
  schedule,
  cycleDays,
}: {
  schedule: SchedulePoint[];
  cycleDays: number;
}) {
  if (!Array.isArray(schedule) || schedule.length === 0) {
    return <div className="text-xs text-gray-400">스케줄 정보 없음</div>;
  }
  const sorted = [...schedule].sort((a, b) => a.dayIndex - b.dayIndex);
  const multiWeek = cycleDays > 7;

  // 주차별 그룹핑 (0~6=1주차, 7~13=2주차 …)
  const weeks = new Map<number, SchedulePoint[]>();
  for (const p of sorted) {
    const w = Math.floor(p.dayIndex / 7);
    if (!weeks.has(w)) weeks.set(w, []);
    weeks.get(w)!.push(p);
  }

  return (
    <div className="space-y-2">
      {[...weeks.entries()].map(([w, pts]) => (
        <div key={w}>
          {multiWeek && (
            <div className="text-[11px] font-semibold text-gray-500 mb-1">
              {w + 1}주차
            </div>
          )}
          <div className="grid grid-cols-7 gap-1">
            {pts.map((p) => {
              const off = p.type === "off";
              return (
                <div
                  key={p.dayIndex}
                  style={{ gridColumnStart: (p.dayIndex % 7) + 1 }}
                  className={`rounded-md px-0.5 py-1 text-center ${
                    off ? "bg-gray-50" : "bg-blue-50"
                  }`}
                >
                  <div className="text-[10px] font-medium text-gray-400">
                    {WEEKDAY[p.dayIndex % 7]}
                  </div>
                  {off ? (
                    <div className="text-[10px] font-semibold text-gray-400">
                      휴무
                    </div>
                  ) : (
                    <div className="text-[10px] font-semibold text-blue-700 leading-tight">
                      <div>{p.start}</div>
                      <div>~{p.end}</div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

export default function MyShiftModal({
  onClose,
  onChanged,
}: {
  onClose: () => void;
  onChanged?: () => void;
}) {
  const [data, setData] = useState<MyShiftResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState("");
  const [toast, setToast] = useState("");

  const fetchData = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    try {
      const res = await fetch("/api/my-shift");
      if (res.ok) {
        const json: MyShiftResponse = await res.json();
        setData(json);
        // 현재 시프트를 기본 선택으로 (같으면 변경 버튼은 비활성)
        setSelectedId(json.currentShift?.id ?? null);
      } else {
        const err = await res.json().catch(() => ({}));
        setLoadError(err.error ?? "시프트 정보를 불러오지 못했습니다.");
      }
    } catch (e) {
      console.error("GET /api/my-shift error:", e);
      setLoadError("네트워크 오류로 시프트 정보를 불러오지 못했습니다.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const currentId = data?.currentShift?.id ?? null;
  const changeDisabled =
    submitting || selectedId == null || selectedId === currentId;

  const handleChange = async () => {
    if (changeDisabled || selectedId == null) return;
    setSubmitting(true);
    setFormError("");
    try {
      const res = await fetch("/api/my-shift", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ patternId: selectedId }),
      });
      const json = await res.json().catch(() => ({}));
      if (res.ok && json.ok) {
        setToast(
          `‘${json.patternName}’ 시프트로 변경되었습니다. ${json.effectiveDate}부터 적용됩니다.`
        );
        setTimeout(() => {
          onChanged?.();
          onClose();
        }, 1400);
      } else {
        setFormError(json.error ?? "시프트 변경에 실패했습니다.");
        setSubmitting(false);
      }
    } catch (e) {
      console.error("PUT /api/my-shift error:", e);
      setFormError("네트워크 오류로 시프트 변경에 실패했습니다.");
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md max-h-[90vh] overflow-y-auto">
        {toast && (
          <div className="fixed bottom-6 right-6 z-[60] bg-emerald-600 text-white text-sm font-medium px-5 py-3 rounded-xl shadow-lg max-w-xs">
            {toast}
          </div>
        )}

        {/* 헤더 */}
        <div className="sticky top-0 bg-white flex items-center justify-between px-5 py-4 border-b border-gray-100 z-10">
          <h2 className="text-lg font-bold text-gray-900 flex items-center gap-2">
            <Clock size={18} className="text-blue-600" />
            시프트 변경
          </h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-700"
          >
            <X size={20} />
          </button>
        </div>

        {loading ? (
          <div className="flex justify-center py-16">
            <Loader2 className="animate-spin text-gray-400" size={28} />
          </div>
        ) : loadError ? (
          <div className="p-6 text-center text-sm text-rose-600">
            {loadError}
          </div>
        ) : data ? (
          <div className="p-5 space-y-4">
            {/* 현재 시프트 */}
            <div>
              <div className="text-xs font-semibold text-gray-500 mb-1.5">
                현재 시프트
              </div>
              {data.currentShift ? (
                <div className="bg-gray-50 rounded-xl px-4 py-3 space-y-2">
                  <div className="text-sm font-semibold text-gray-900">
                    {data.currentShift.name}
                  </div>
                  <ScheduleGrid
                    schedule={data.currentShift.schedule}
                    cycleDays={data.currentShift.cycleDays}
                  />
                </div>
              ) : (
                <div className="bg-gray-50 rounded-xl px-4 py-3 text-sm text-gray-400">
                  현재 배정된 시프트가 없습니다
                </div>
              )}
            </div>

            {/* 적용일 안내 배너 */}
            {data.attendedToday ? (
              <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-sm text-amber-800">
                오늘 이미 출근하셔서, 변경한 시프트는 {data.effectiveDate}부터
                적용됩니다.
              </div>
            ) : (
              <div className="bg-blue-50 border border-blue-200 rounded-xl px-4 py-3 text-sm text-blue-700">
                선택한 시프트는 오늘({data.effectiveDate})부터 적용됩니다.
              </div>
            )}

            {/* 선택 목록 */}
            <div>
              <div className="text-xs font-semibold text-gray-500 mb-1.5">
                시프트 선택
              </div>
              {data.patterns.length === 0 ? (
                <div className="text-sm text-gray-400 px-1 py-2">
                  선택 가능한 시프트가 없습니다
                </div>
              ) : (
                <div className="space-y-2">
                  {data.patterns.map((p) => {
                    const selected = selectedId === p.id;
                    const isCurrent = currentId === p.id;
                    return (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => setSelectedId(p.id)}
                        className={`w-full text-left rounded-xl border px-4 py-3 transition-colors ${
                          selected
                            ? "border-blue-500 bg-blue-50 ring-1 ring-blue-200"
                            : "border-gray-200 bg-white hover:bg-gray-50"
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2 mb-2">
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="text-sm font-semibold text-gray-900 truncate">
                              {p.name}
                            </span>
                            {isCurrent && (
                              <span className="shrink-0 text-[10px] font-semibold text-blue-600 bg-blue-100 rounded-full px-2 py-0.5">
                                현재 시프트
                              </span>
                            )}
                          </div>
                          {selected && (
                            <Check
                              size={16}
                              className="shrink-0 text-blue-600"
                            />
                          )}
                        </div>
                        {p.description && (
                          <div className="text-xs text-gray-500 mb-2">
                            {p.description}
                          </div>
                        )}
                        <ScheduleGrid
                          schedule={p.schedule}
                          cycleDays={p.cycleDays}
                        />
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {/* 변경 에러 */}
            {formError && (
              <div className="text-sm text-rose-600">{formError}</div>
            )}

            {/* 하단 버튼 */}
            <div className="flex justify-end gap-2 pt-1">
              <button
                onClick={onClose}
                className="px-4 py-2.5 bg-white border border-gray-200 text-gray-600 rounded-xl text-sm font-medium hover:bg-gray-50"
              >
                취소
              </button>
              <button
                onClick={handleChange}
                disabled={changeDisabled}
                className="inline-flex items-center gap-2 bg-blue-600 text-white text-sm font-semibold px-5 py-2.5 rounded-xl hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {submitting && (
                  <Loader2 size={16} className="animate-spin" />
                )}
                이 시프트로 변경
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

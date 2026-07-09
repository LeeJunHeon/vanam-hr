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

// @db.Date는 UTC 자정으로 오간다. 날짜 계산은 UTC 메서드로 일관 처리.
// "YYYY-MM-DD" → 그 주 월요일 Date (백엔드 anchor와 동일: start_date를 그 주 월요일로 내림)
function mondayOfUTC(ymd: string): Date {
  const d = new Date(ymd + "T00:00:00.000Z");
  const dow = (d.getUTCDay() + 6) % 7; // 일=0..토=6 → 월=0..일=6
  d.setUTCDate(d.getUTCDate() - dow);
  return d;
}
function addDaysUTC(d: Date, n: number): Date {
  const r = new Date(d);
  r.setUTCDate(r.getUTCDate() + n);
  return r;
}
function mmddUTC(d: Date): string {
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
}
// 현재 시프트: 지금 진행 중인 사이클의 1주차 월요일(YYYY-MM-DD) — 첫 사이클의 옛 날짜 대신 현재 반복 날짜를 보여주기 위함
function currentCycleMonday(
  startDate: string,
  cycleDays: number,
  refYmd: string
): string {
  const anchor = mondayOfUTC(startDate);
  const ref = mondayOfUTC(refYmd);
  const daysBetween = Math.round((ref.getTime() - anchor.getTime()) / 86400000);
  const cyclesPassed = cycleDays > 0 ? Math.floor(daysBetween / cycleDays) : 0;
  const cur = addDaysUTC(anchor, cyclesPassed * cycleDays);
  return cur.toISOString().split("T")[0];
}

// 요일 포함 M/D 표기: "7/9(목)"
const DOW = ["일", "월", "화", "수", "목", "금", "토"];
function fmtMdDow(ymd: string): string {
  const d = new Date(ymd + "T00:00:00.000Z");
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}(${DOW[d.getUTCDay()]})`;
}
// 새 시프트를 ymd(적용일)부터 시작한다고 할 때 그 날 해당하는 schedule point.
// 백엔드 anchor 규칙과 동일: start_date(=ymd)가 속한 주 월요일 기준 dayOffset.
function pointForDate(
  schedule: SchedulePoint[],
  cycleDays: number,
  ymd: string
): SchedulePoint | null {
  if (!Array.isArray(schedule) || cycleDays < 1) return null;
  const d = new Date(ymd + "T00:00:00.000Z");
  const anchor = mondayOfUTC(ymd);
  const dayOffset =
    ((Math.round((d.getTime() - anchor.getTime()) / 86400000) % cycleDays) +
      cycleDays) %
    cycleDays;
  return schedule.find((p) => p.dayIndex === dayOffset) ?? null;
}

// 스케줄 그리드 — dayIndex 오름차순, cycleDays>7이면 주차로 묶어 표시.
// anchorDate가 있으면(멀티위크) 각 주차에 실제 날짜 범위를 병기.
function ScheduleGrid({
  schedule,
  cycleDays,
  anchorDate,
}: {
  schedule: SchedulePoint[];
  cycleDays: number;
  anchorDate?: string; // 이 시프트가 적용되는(될) 기준 시작일 "YYYY-MM-DD"
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

  const anchorMon = anchorDate ? mondayOfUTC(anchorDate) : null;

  return (
    <div className="space-y-2">
      {[...weeks.entries()].map(([w, pts]) => {
        let rangeLabel = "";
        if (multiWeek && anchorMon) {
          const wStart = addDaysUTC(anchorMon, w * 7);
          const wEnd = addDaysUTC(wStart, 6);
          rangeLabel = `${mmddUTC(wStart)}~${mmddUTC(wEnd)}`;
        }
        return (
          <div key={w}>
            {multiWeek && (
              <div className="text-[11px] font-semibold text-gray-500 mb-1">
                {w + 1}주차
                {rangeLabel && (
                  <span className="ml-1 font-normal text-gray-400">
                    ({rangeLabel})
                  </span>
                )}
              </div>
            )}
            <div className="grid grid-cols-7 gap-1">
              {pts.map((p) => {
                const off = p.type === "off";
                const box = off
                  ? "bg-gray-50"
                  : p.type === "night"
                  ? "bg-indigo-50"
                  : p.type === "half_day"
                  ? "bg-amber-50"
                  : "bg-blue-50";
                const txt =
                  p.type === "night"
                    ? "text-indigo-700"
                    : p.type === "half_day"
                    ? "text-amber-700"
                    : "text-blue-700";
                return (
                  <div
                    key={p.dayIndex}
                    style={{ gridColumnStart: (p.dayIndex % 7) + 1 }}
                    className={`rounded-md px-0.5 py-1 text-center ${box}`}
                  >
                    <div className="text-[10px] font-medium text-gray-400">
                      {WEEKDAY[p.dayIndex % 7]}
                    </div>
                    {off ? (
                      <div className="text-[10px] font-semibold text-gray-400">
                        휴무
                      </div>
                    ) : (
                      <div
                        className={`text-[10px] font-semibold ${txt} leading-tight`}
                      >
                        <div>{p.start}</div>
                        <div>~{p.end}</div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
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
  const hasMultiWeek =
    !!data &&
    (((data.currentShift?.cycleDays ?? 0) > 7) ||
      data.patterns.some((p) => p.cycleDays > 7));
  const hasNight =
    !!data &&
    ((data.currentShift?.schedule?.some(
      (p) => p.type === "night" || p.type === "half_day"
    ) ??
      false) ||
      data.patterns.some((p) =>
        p.schedule?.some((s) => s.type === "night" || s.type === "half_day")
      ));
  const selectedPattern =
    data?.patterns.find((p) => p.id === selectedId) ??
    (data?.currentShift && data.currentShift.id === selectedId
      ? data.currentShift
      : null);

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
          `‘${json.patternName}’ 시프트로 변경되었습니다. ${fmtMdDow(
            json.effectiveDate
          )}부터 적용됩니다.`
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
            {hasNight && (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-gray-500">
                <span className="flex items-center gap-1">
                  <span className="inline-block w-2.5 h-2.5 rounded bg-blue-50 border border-blue-200" />
                  주간
                </span>
                <span className="flex items-center gap-1">
                  <span className="inline-block w-2.5 h-2.5 rounded bg-indigo-50 border border-indigo-200" />
                  야간
                </span>
                <span className="flex items-center gap-1">
                  <span className="inline-block w-2.5 h-2.5 rounded bg-amber-50 border border-amber-200" />
                  반일
                </span>
                <span className="flex items-center gap-1">
                  <span className="inline-block w-2.5 h-2.5 rounded bg-gray-50 border border-gray-200" />
                  휴무
                </span>
              </div>
            )}
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
                    anchorDate={currentCycleMonday(
                      data.currentShift.startDate,
                      data.currentShift.cycleDays,
                      data.effectiveDate
                    )}
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
                오늘 이미 출근하셔서, 변경한 시프트는{" "}
                {fmtMdDow(data.effectiveDate)}부터 적용됩니다.
              </div>
            ) : (
              <div className="bg-blue-50 border border-blue-200 rounded-xl px-4 py-3 text-sm text-blue-700">
                선택한 시프트는 오늘({fmtMdDow(data.effectiveDate)})부터
                적용됩니다.
              </div>
            )}

            {hasMultiWeek && (
              <div className="text-[11px] leading-relaxed text-gray-500 bg-gray-50 rounded-lg px-3 py-2">
                ※ 교대(순환) 시프트의 <b>1주차는 “적용 시작일이 속한 주(월요일
                기준)”</b>이며 이후 자동으로 순환합니다. 달력상 몇째 주와 다를
                수 있으니, 각 주차 옆의 날짜로 확인하세요.
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
                          anchorDate={data.effectiveDate}
                        />
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {selectedPattern && selectedId !== currentId && (
              <div className="text-xs bg-blue-50 border border-blue-200 rounded-lg px-3 py-2 text-blue-800">
                적용일 <b>{fmtMdDow(data.effectiveDate)}</b>은{" "}
                {(() => {
                  const pt = pointForDate(
                    selectedPattern.schedule,
                    selectedPattern.cycleDays,
                    data.effectiveDate
                  );
                  const wk =
                    selectedPattern.cycleDays > 7
                      ? " · 1주차부터 순환 시작"
                      : "";
                  if (!pt || pt.type === "off")
                    return <>휴무입니다.{wk}</>;
                  const label =
                    pt.type === "night"
                      ? "야간"
                      : pt.type === "half_day"
                      ? "반일"
                      : "주간";
                  return (
                    <>
                      {label} {pt.start}~{pt.end}로 시작합니다.{wk}
                    </>
                  );
                })()}
              </div>
            )}

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

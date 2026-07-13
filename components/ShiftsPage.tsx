"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Search,
  Plus,
  Edit,
  Trash2,
  Loader2,
  X,
  Clock,
} from "lucide-react";
import { exportExcel } from "@/lib/excelUtils";
import ExcelButton from "@/components/ExcelButton";
import { todayYmd } from "@/lib/dateUtils";
import TimePicker, {
  normalizeTimeForDb,
  denormalizeTimeForDisplay,
  calcWorkMinutes,
  formatWorkDuration,
} from "@/components/TimePicker";

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
  isActive: boolean;
}

interface TypeLookup {
  id: number;
  code: string;
  label: string;
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const EMPTY_FORM = {
  name: "",
  description: "",
  cycleDays: 7,
  schedule: [] as SchedulePoint[],
};

// type별 미리보기 색상
const TYPE_BG: Record<string, string> = {
  day: "bg-blue-400",
  night: "bg-purple-500",
  off: "bg-gray-300",
  half_day: "bg-amber-400",
};

const getTypeBg = (code: string): string => TYPE_BG[code] || "bg-gray-200";

// Phase 6-2J: 라벨 배경 진한 + 흰 글자 (가독성 강화)
const TYPE_LABEL_CLASS: Record<string, string> = {
  day: "bg-blue-600 text-white",
  night: "bg-purple-600 text-white",
  off: "bg-gray-500 text-white",
  half_day: "bg-amber-600 text-white",
};
const getTypeLabelClass = (code: string): string =>
  TYPE_LABEL_CLASS[code] || "bg-gray-600 text-white";

export default function ShiftsPage() {
  const [patterns, setPatterns] = useState<ShiftPattern[]>([]);
  const [typeLookups, setTypeLookups] = useState<TypeLookup[]>([]); // shift_day_type 룩업
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [includeInactive, setIncludeInactive] = useState(false);

  const [showForm, setShowForm] = useState(false);
  const [editTarget, setEditTarget] = useState<ShiftPattern | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");
  const [toast, setToast] = useState("");

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(""), 2500);
  };

  // shift_day_type lookup 1회 로드
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(
          "/api/lookups?category=shift_day_type&includeInactive=false"
        );
        if (res.ok) {
          const data = await res.json();
          setTypeLookups(data);
        }
      } catch (e) {
        console.error("shift_day_type lookups fetch error:", e);
      }
    })();
  }, []);

  const fetchPatterns = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (search) params.set("search", search);
      if (includeInactive) params.set("includeInactive", "true");

      const res = await fetch(`/api/shifts?${params}`);
      if (res.ok) setPatterns(await res.json());
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, [search, includeInactive]);

  useEffect(() => {
    const t = setTimeout(fetchPatterns, 300);
    return () => clearTimeout(t);
  }, [fetchPatterns]);

  const getTypeLabel = (code: string): string => {
    const lookup = typeLookups.find((l) => l.code === code);
    return lookup ? lookup.label : code;
  };

  // 기본 type 코드 (typeLookups의 첫 번째, fallback "day")
  const defaultType = (): string => typeLookups[0]?.code || "day";

  // schedule 1행 새로 만들기
  const makeNewPoint = (dayIndex: number): SchedulePoint => ({
    dayIndex,
    start: "09:00",
    end: "18:00",
    type: defaultType(),
  });

  const openCreate = () => {
    setEditTarget(null);
    const cycleDays = 7;
    const schedule: SchedulePoint[] = [];
    for (let i = 0; i < cycleDays; i++) {
      schedule.push(makeNewPoint(i));
    }
    setForm({
      name: "",
      description: "",
      cycleDays,
      schedule,
    });
    setFormError("");
    setShowForm(true);
  };

  const openEdit = (p: ShiftPattern) => {
    setEditTarget(p);
    setForm({
      name: p.name,
      description: p.description || "",
      cycleDays: p.cycleDays,
      // schedule을 dayIndex 기준 정렬 후 복사 (방어적)
      // end가 23:59이면 화면에선 24:00으로 표시
      schedule: [...p.schedule]
        .sort((a, b) => a.dayIndex - b.dayIndex)
        .map((sp) => ({
          ...sp,
          end: sp.end ? denormalizeTimeForDisplay(sp.end) : sp.end,
        })),
    });
    setFormError("");
    setShowForm(true);
  };

  // 사이클 일수 변경 — schedule 자동 동기화
  const onCycleDaysChange = (raw: string) => {
    const newN = parseInt(raw) || 0;
    if (newN < 1) {
      setForm((f) => ({ ...f, cycleDays: newN }));
      return;
    }
    setForm((f) => {
      const current = f.schedule;
      if (newN > current.length) {
        const next = [...current];
        for (let i = current.length; i < newN; i++) {
          next.push(makeNewPoint(i));
        }
        return { ...f, cycleDays: newN, schedule: next };
      } else if (newN < current.length) {
        if (
          !confirm(
            `${newN + 1}일째 이후 입력이 삭제됩니다. 진행할까요?`
          )
        ) {
          return f;
        }
        return { ...f, cycleDays: newN, schedule: current.slice(0, newN) };
      }
      return { ...f, cycleDays: newN };
    });
  };

  // schedule 행의 type 변경
  const onScheduleTypeChange = (idx: number, newType: string) => {
    setForm((f) => {
      const next = [...f.schedule];
      const isOff = newType === "off";
      next[idx] = {
        ...next[idx],
        type: newType,
        start: isOff ? null : next[idx].start || "09:00",
        end: isOff ? null : next[idx].end || "18:00",
      };
      return { ...f, schedule: next };
    });
  };

  const onScheduleTimeChange = (
    idx: number,
    field: "start" | "end",
    value: string
  ) => {
    setForm((f) => {
      const next = [...f.schedule];
      next[idx] = { ...next[idx], [field]: value };
      return { ...f, schedule: next };
    });
  };

  // Phase 6-2J: 같은 주의 평일(월~금: idx % 7 < 5)에 type+시간 일괄 복사
  // 가정: idx 0 = 월요일(다른 패턴이면 사용자가 검토 후 사용).
  // 주말(토/일)은 유지. 본인 행도 그대로.
  const fillWeekdays = (sourceIdx: number) => {
    setForm((f) => {
      const source = f.schedule[sourceIdx];
      if (!source) return f;
      const weekStart = Math.floor(sourceIdx / 7) * 7;
      const weekEnd = Math.min(weekStart + 7, f.schedule.length);
      const next = [...f.schedule];
      for (let i = weekStart; i < weekEnd; i++) {
        if (i === sourceIdx) continue;
        if (i % 7 >= 5) continue; // 토(5)·일(6) 스킵
        next[i] = {
          ...next[i],
          type: source.type,
          start: source.start,
          end: source.end,
        };
      }
      return { ...f, schedule: next };
    });
  };

  // 클라이언트 검증
  const validateForm = (): string | null => {
    if (!form.name.trim()) return "이름은 필수입니다.";
    if (form.cycleDays < 1) return "사이클 일수는 1 이상이어야 합니다.";
    if (form.schedule.length !== form.cycleDays) {
      return `schedule 길이(${form.schedule.length})가 사이클 일수(${form.cycleDays})와 일치하지 않습니다.`;
    }
    for (let i = 0; i < form.schedule.length; i++) {
      const p = form.schedule[i];
      if (p.type === "off") continue;
      // 시작 시간: HH:MM (24:00 불허)
      if (!p.start || !TIME_RE.test(p.start)) {
        return `${i + 1}일째 시작 시간이 HH:MM 형식이 아닙니다.`;
      }
      // 종료 시간: HH:MM 또는 24:00 허용
      if (!p.end || (!TIME_RE.test(p.end) && p.end !== "24:00")) {
        return `${i + 1}일째 종료 시간이 HH:MM 형식이 아닙니다.`;
      }
    }
    return null;
  };

  const handleSave = async () => {
    const err = validateForm();
    if (err) {
      setFormError(err);
      return;
    }

    setFormError("");
    setSaving(true);
    try {
      const url = editTarget
        ? `/api/shifts?id=${editTarget.id}`
        : "/api/shifts";
      const method = editTarget ? "PUT" : "POST";

      // 24:00 가상 표기를 23:59로 정규화한 후 저장
      const normalizedSchedule = form.schedule.map((sp) => ({
        ...sp,
        start: sp.start ? normalizeTimeForDb(sp.start) : sp.start,
        end: sp.end ? normalizeTimeForDb(sp.end) : sp.end,
      }));

      const payload = {
        name: form.name.trim(),
        description: form.description.trim() || null,
        cycleDays: form.cycleDays,
        schedule: normalizedSchedule,
      };

      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) {
        setFormError(data.error || "저장 실패");
        return;
      }
      showToast("✅ " + (editTarget ? "수정되었습니다" : "추가되었습니다"));
      setShowForm(false);
      fetchPatterns();
    } catch {
      setFormError("네트워크 오류");
    } finally {
      setSaving(false);
    }
  };

  const handleToggleActive = async (p: ShiftPattern) => {
    try {
      const res = await fetch(`/api/shifts?id=${p.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: !p.isActive }),
      });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || "변경 실패");
        return;
      }
      showToast(`✅ ${p.isActive ? "비활성" : "활성"} 처리됨`);
      fetchPatterns();
    } catch {
      alert("네트워크 오류");
    }
  };

  const handleDelete = async (p: ShiftPattern) => {
    if (!confirm(`"${p.name}" 시프트 패턴을 삭제하시겠습니까?`)) return;
    try {
      const res = await fetch(`/api/shifts?id=${p.id}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || "삭제 실패");
        return;
      }
      showToast("✅ 삭제되었습니다");
      fetchPatterns();
    } catch {
      alert("네트워크 오류");
    }
  };

  const handleExportExcel = async () => {
    if (!patterns || patterns.length === 0) return;
    await exportExcel(
      ["이름", "설명", "사이클일수", "활성", "schedule(JSON)"],
      patterns.map((p) => [
        p.name,
        p.description ?? "",
        p.cycleDays,
        p.isActive ? "Y" : "N",
        JSON.stringify(p.schedule),
      ]),
      `시프트패턴_${todayYmd()}.xlsx`,
      "시프트패턴"
    );
  };

  return (
    <div className="p-4 sm:p-6 space-y-5">
      {/* 토스트 */}
      {toast && (
        <div className="fixed bottom-6 right-6 z-50 bg-gray-900 text-white text-sm font-medium px-5 py-3 rounded-xl shadow-lg">
          {toast}
        </div>
      )}

      {/* 헤더 */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold text-gray-900">
            시프트 패턴
          </h1>
          <p className="text-sm text-gray-500 mt-0.5">
            근무 패턴 (주야간 격주, 3교대 등) 라이브러리를 관리합니다
          </p>
        </div>
        <div className="flex items-center gap-2">
          <ExcelButton
            onClick={handleExportExcel}
            disabled={!patterns || patterns.length === 0}
          />
          <button
            onClick={openCreate}
            disabled={typeLookups.length === 0}
            className="flex items-center gap-2 px-4 py-2.5 text-sm font-bold text-white bg-blue-500 rounded-xl hover:bg-blue-600 shadow-sm disabled:opacity-50 disabled:cursor-not-allowed"
            title={
              typeLookups.length === 0
                ? "코드 룩업의 shift_day_type에 활성 코드가 없습니다"
                : ""
            }
          >
            <Plus size={16} />
            패턴 추가
          </button>
        </div>
      </div>

      {/* 등록 / 수정 폼 (인라인) */}
      {showForm && (
        <div className="bg-blue-50 border border-blue-200 rounded-2xl p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="font-bold text-blue-900">
              {editTarget ? "패턴 수정" : "패턴 추가"}
            </h2>
            <button
              onClick={() => setShowForm(false)}
              className="text-blue-400 hover:text-blue-700"
            >
              <X size={18} />
            </button>
          </div>

          {/* 기본 정보 */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="sm:col-span-2">
              <label className="block text-xs font-semibold text-blue-700 mb-1">
                이름 <span className="text-rose-500">*</span>
              </label>
              <input
                value={form.name}
                onChange={(e) =>
                  setForm((f) => ({ ...f, name: e.target.value }))
                }
                placeholder="예: 주야간 격주 2조"
                maxLength={100}
                className="w-full px-3 py-2.5 border border-blue-200 rounded-xl text-sm bg-white outline-none focus:ring-2 focus:ring-blue-400"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-blue-700 mb-1">
                사이클 일수 <span className="text-rose-500">*</span>
              </label>
              <input
                type="number"
                min="1"
                value={form.cycleDays}
                onChange={(e) => onCycleDaysChange(e.target.value)}
                className="w-full px-3 py-2.5 border border-blue-200 rounded-xl text-sm bg-white outline-none focus:ring-2 focus:ring-blue-400"
              />
            </div>

            <div className="sm:col-span-3">
              <label className="block text-xs font-semibold text-blue-700 mb-1">
                설명
              </label>
              <textarea
                value={form.description}
                onChange={(e) =>
                  setForm((f) => ({ ...f, description: e.target.value }))
                }
                placeholder="패턴의 의도, 적용 부서 등"
                rows={2}
                className="w-full px-3 py-2.5 border border-blue-200 rounded-xl text-sm bg-white outline-none focus:ring-2 focus:ring-blue-400 resize-none"
              />
            </div>
          </div>

          {/* schedule 입력 영역 */}
          <div>
            <label className="block text-xs font-semibold text-blue-700 mb-2">
              사이클별 근무 시간
            </label>
            <div className="bg-white border border-blue-200 rounded-xl divide-y divide-blue-100 max-h-96 overflow-y-auto">
              {form.schedule.map((p, idx) => {
                const isOff = p.type === "off";
                // 주차 구분선 (사이클 8일 이상일 때 7일마다)
                const showWeekDivider =
                  form.cycleDays >= 8 && idx > 0 && idx % 7 === 0;
                const weekNum = Math.floor(idx / 7) + 1;

                return (
                  <div key={idx}>
                    {showWeekDivider && (
                      <div className="px-3 py-1 bg-blue-50 border-t border-blue-200">
                        <p className="text-[10px] font-semibold text-blue-600 uppercase tracking-wider">
                          {weekNum}주차
                        </p>
                      </div>
                    )}
                    {idx === 0 && form.cycleDays >= 8 && (
                      <div className="px-3 py-1 bg-blue-50">
                        <p className="text-[10px] font-semibold text-blue-600 uppercase tracking-wider">
                          1주차
                        </p>
                      </div>
                    )}
                    <div className="grid grid-cols-12 items-center gap-2 px-3 py-2">
                      <span className="col-span-2 sm:col-span-1 text-xs font-semibold text-gray-600 font-mono">
                        {idx + 1}일째
                      </span>
                      <select
                        value={p.type}
                        onChange={(e) =>
                          onScheduleTypeChange(idx, e.target.value)
                        }
                        className="col-span-4 sm:col-span-3 px-2 py-1.5 border border-gray-200 rounded-lg text-xs bg-white outline-none focus:ring-2 focus:ring-blue-400"
                      >
                        {typeLookups.map((l) => (
                          <option key={l.code} value={l.code}>
                            {l.label}
                          </option>
                        ))}
                      </select>
                      <div className="col-span-3 sm:col-span-3">
                        <TimePicker
                          value={p.start ?? ""}
                          disabled={isOff}
                          placeholder="시작"
                          onChange={(val) =>
                            onScheduleTimeChange(idx, "start", val)
                          }
                        />
                      </div>
                      <span className="col-span-1 text-center text-gray-400 text-xs">
                        ~
                      </span>
                      <div className="col-span-3 sm:col-span-3">
                        <TimePicker
                          value={p.end ?? ""}
                          disabled={isOff}
                          placeholder="종료"
                          allowMidnight={true}
                          onChange={(val) =>
                            onScheduleTimeChange(idx, "end", val)
                          }
                        />
                      </div>
                      <div
                        className={`hidden sm:block sm:col-span-1 px-2 py-1 rounded-lg text-[10px] text-center font-semibold ${getTypeLabelClass(
                          p.type
                        )}`}
                      >
                        {getTypeLabel(p.type)}
                      </div>
                    </div>
                    {!isOff && p.start && p.end && (
                      <div className="px-3 pb-2 -mt-1 flex items-center justify-between gap-2">
                        <div className="text-[10px] text-gray-500 pl-[8.33%]">
                          근무 시간:{" "}
                          {formatWorkDuration(calcWorkMinutes(p.start, p.end))}
                        </div>
                        {/* Phase 6-2J: 주 일괄 적용 (같은 주 평일에 복사) */}
                        <button
                          type="button"
                          onClick={() => fillWeekdays(idx)}
                          className="text-[10px] text-blue-600 hover:text-blue-700 px-2 py-0.5 border border-blue-200 rounded hover:bg-blue-50 shrink-0"
                          title="이 시간으로 같은 주의 평일(월~금) 일괄 채우기"
                        >
                          📋 주 일괄 적용
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            <p className="text-[10px] text-gray-500 mt-1">
              "휴무"로 설정하면 시작/종료 시간이 비활성됩니다.
            </p>
          </div>

          {formError && (
            <p className="text-sm text-red-500 bg-red-50 px-3 py-2 rounded-xl">
              {formError}
            </p>
          )}

          <div className="flex gap-2">
            <button
              onClick={handleSave}
              disabled={saving}
              className="px-5 py-2.5 bg-blue-500 text-white rounded-xl text-sm font-semibold hover:bg-blue-600 disabled:opacity-60"
            >
              {saving ? "저장 중..." : editTarget ? "수정 저장" : "추가"}
            </button>
            <button
              onClick={() => setShowForm(false)}
              className="px-5 py-2.5 bg-white border border-blue-200 text-blue-700 rounded-xl text-sm font-medium hover:bg-blue-50"
            >
              취소
            </button>
          </div>
        </div>
      )}

      {/* 필터 */}
      <div className="bg-white rounded-2xl border border-gray-100 p-3 sm:p-4 space-y-3">
        <div className="relative">
          <Search
            size={16}
            className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-400"
          />
          <input
            type="text"
            placeholder="이름 또는 설명으로 검색"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-10 pr-4 py-2.5 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-blue-500 outline-none"
          />
        </div>

        <label className="flex items-center gap-2 text-sm text-gray-600 cursor-pointer w-fit">
          <input
            type="checkbox"
            checked={includeInactive}
            onChange={(e) => setIncludeInactive(e.target.checked)}
            className="rounded"
          />
          비활성 패턴 포함
        </label>
      </div>

      {/* 목록 */}
      {loading ? (
        <div className="flex items-center justify-center h-32">
          <Loader2 size={24} className="animate-spin text-blue-500" />
          <span className="ml-2 text-sm text-gray-500">로딩 중...</span>
        </div>
      ) : (
        <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
          <div className="hidden md:block overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-100">
                  <th className="text-left text-xs font-semibold text-gray-500 px-5 py-3">
                    이름
                  </th>
                  <th className="text-left text-xs font-semibold text-gray-500 px-5 py-3">
                    설명
                  </th>
                  <th className="text-center text-xs font-semibold text-gray-500 px-5 py-3">
                    사이클
                  </th>
                  <th className="text-left text-xs font-semibold text-gray-500 px-5 py-3">
                    요일 미리보기
                  </th>
                  <th className="text-center text-xs font-semibold text-gray-500 px-5 py-3">
                    상태
                  </th>
                  <th className="text-center text-xs font-semibold text-gray-500 px-5 py-3">
                    작업
                  </th>
                </tr>
              </thead>
              <tbody>
                {patterns.length === 0 ? (
                  <tr>
                    <td
                      colSpan={6}
                      className="px-5 py-12 text-center text-sm text-gray-400"
                    >
                      등록된 시프트 패턴이 없습니다
                    </td>
                  </tr>
                ) : (
                  patterns.map((p) => (
                    <tr
                      key={p.id}
                      className={`border-b border-gray-50 hover:bg-blue-50/30 group ${
                        !p.isActive ? "opacity-40" : ""
                      }`}
                    >
                      <td className="px-5 py-3 text-sm font-semibold text-gray-900">
                        <div className="flex items-center gap-2">
                          <Clock size={14} className="text-gray-400" />
                          {p.name}
                        </div>
                      </td>
                      <td className="px-5 py-3 text-sm text-gray-500 max-w-xs">
                        {p.description ? (
                          <p className="line-clamp-2" title={p.description}>
                            {p.description}
                          </p>
                        ) : (
                          <span className="text-gray-300">-</span>
                        )}
                      </td>
                      <td className="px-5 py-3 text-center text-sm text-gray-700">
                        {p.cycleDays}일
                      </td>
                      <td className="px-5 py-3">
                        <div className="flex flex-wrap items-center gap-1 max-w-md">
                          {[...p.schedule]
                            .sort((a, b) => a.dayIndex - b.dayIndex)
                            .map((sp) => (
                              <div
                                key={sp.dayIndex}
                                className={`w-3 h-3 rounded-full ${getTypeBg(
                                  sp.type
                                )}`}
                                title={`${sp.dayIndex + 1}일째: ${getTypeLabel(
                                  sp.type
                                )}${
                                  sp.start && sp.end
                                    ? ` (${sp.start}~${sp.end})`
                                    : ""
                                }`}
                              />
                            ))}
                        </div>
                      </td>
                      <td className="px-5 py-3 text-center">
                        <button
                          onClick={() => handleToggleActive(p)}
                          className={`text-xs font-semibold px-2 py-0.5 rounded-full hover:opacity-80 ${
                            p.isActive
                              ? "text-emerald-700 bg-emerald-50"
                              : "text-gray-400 bg-gray-100"
                          }`}
                          title="클릭하여 활성/비활성 토글"
                        >
                          {p.isActive ? "활성" : "비활성"}
                        </button>
                      </td>
                      <td className="px-5 py-3">
                        <div className="flex justify-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                          <button
                            onClick={() => openEdit(p)}
                            className="p-1.5 rounded-lg hover:bg-blue-100 text-gray-400 hover:text-blue-600"
                          >
                            <Edit size={15} />
                          </button>
                          <button
                            onClick={() => handleDelete(p)}
                            className="p-1.5 rounded-lg hover:bg-rose-100 text-gray-400 hover:text-rose-600"
                          >
                            <Trash2 size={15} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          {/* 모바일 */}
          <div className="md:hidden divide-y divide-gray-50">
            {patterns.length === 0 ? (
              <div className="px-4 py-12 text-center text-sm text-gray-400">
                등록된 시프트 패턴이 없습니다
              </div>
            ) : (
              patterns.map((p) => (
                <div
                  key={p.id}
                  className={`px-4 py-3 space-y-2 ${
                    !p.isActive ? "opacity-40" : ""
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 min-w-0">
                      <Clock size={14} className="text-gray-400 shrink-0" />
                      <span className="text-sm font-semibold text-gray-900 truncate">
                        {p.name}
                      </span>
                    </div>
                    <div className="flex gap-1 shrink-0">
                      <button
                        onClick={() => openEdit(p)}
                        className="p-1.5 rounded-lg hover:bg-blue-50 text-gray-400 hover:text-blue-600"
                      >
                        <Edit size={14} />
                      </button>
                      <button
                        onClick={() => handleDelete(p)}
                        className="p-1.5 rounded-lg hover:bg-rose-50 text-gray-400 hover:text-rose-600"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                  <p className="text-xs text-gray-400">
                    {p.cycleDays}일 사이클
                    {p.description && ` · ${p.description}`}
                  </p>
                  <div className="flex flex-wrap items-center gap-1">
                    {[...p.schedule]
                      .sort((a, b) => a.dayIndex - b.dayIndex)
                      .map((sp) => (
                        <div
                          key={sp.dayIndex}
                          className={`w-3 h-3 rounded-full ${getTypeBg(
                            sp.type
                          )}`}
                          title={`${sp.dayIndex + 1}일째: ${getTypeLabel(
                            sp.type
                          )}${
                            sp.start && sp.end
                              ? ` (${sp.start}~${sp.end})`
                              : ""
                          }`}
                        />
                      ))}
                  </div>
                </div>
              ))
            )}
          </div>

          {patterns.length > 0 && (
            <div className="px-5 py-3 border-t border-gray-100 bg-gray-50">
              <p className="text-xs font-semibold text-gray-700">
                총 {patterns.length}건
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

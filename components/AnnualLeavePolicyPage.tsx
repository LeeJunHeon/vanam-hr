"use client";

import { useState, useEffect, useCallback } from "react";
import { Loader2, CalendarDays, Save } from "lucide-react";

interface PolicyForm {
  baseDays: number;
  incrementStartYear: number;
  incrementCycleYears: number;
  incrementDays: number;
  maxDays: number;
  firstYearMonthly: boolean;
  firstYearMax: number;
  monthlyBasis: string; // 'month' | 'hire_day'
  grantBasis: string;   // 'fiscal_year' | 'hire_date'
  firstYearFixedDays: number;
}

const DEFAULTS: PolicyForm = {
  baseDays: 15, incrementStartYear: 3, incrementCycleYears: 2,
  incrementDays: 1, maxDays: 25,
  firstYearMonthly: true, firstYearMax: 11, monthlyBasis: "month",
  grantBasis: "fiscal_year", firstYearFixedDays: 0,
};

export default function AnnualLeavePolicyPage() {
  const [form, setForm] = useState<PolicyForm>(DEFAULTS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState("");

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(""), 2500);
  };

  const fetchPolicy = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/annual-leave/policy");
      if (res.ok) {
        const d = await res.json();
        setForm({
          baseDays: Number(d.baseDays),
          incrementStartYear: Number(d.incrementStartYear),
          incrementCycleYears: Number(d.incrementCycleYears),
          incrementDays: Number(d.incrementDays),
          maxDays: Number(d.maxDays),
          firstYearMonthly: Boolean(d.firstYearMonthly),
          firstYearMax: Number(d.firstYearMax),
          monthlyBasis: d.monthlyBasis === "hire_day" ? "hire_day" : "month",
          grantBasis: d.grantBasis === "hire_date" ? "hire_date" : "fiscal_year",
          firstYearFixedDays: Number(d.firstYearFixedDays ?? 0),
        });
      }
    } catch (e) {
      console.error("policy fetch error:", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchPolicy();
  }, [fetchPolicy]);

  const setNum = (key: keyof PolicyForm, val: string) => {
    const n = val === "" ? 0 : Number(val);
    if (!Number.isFinite(n)) return;
    setForm((prev) => ({ ...prev, [key]: n }));
  };

  const handleSave = async () => {
    // 간단 검증
    if (form.incrementCycleYears < 1) {
      showToast("증가 주기는 1 이상이어야 합니다.");
      return;
    }
    if ([form.baseDays, form.incrementStartYear, form.incrementCycleYears,
         form.incrementDays, form.maxDays, form.firstYearMax].some((v) => v < 0)) {
      showToast("값은 0 이상이어야 합니다.");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/annual-leave/policy", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      if (res.ok) {
        showToast("저장되었습니다.");
      } else {
        const err = await res.json().catch(() => ({}));
        showToast(err.error ?? "저장 실패");
      }
    } catch {
      showToast("네트워크 오류");
    } finally {
      setSaving(false);
    }
  };

  // 미리보기: 현재 설정으로 1~N년차 부여량 계산 (UI 참고용, 로컬 계산)
  const preview = (() => {
    const rows: { label: string; days: number }[] = [];
    // 1년 미만
    if (form.firstYearMonthly) {
      rows.push({ label: "입사 후 1개월", days: Math.min(1, form.firstYearMax) });
      rows.push({ label: "입사 후 6개월", days: Math.min(6, form.firstYearMax) });
      rows.push({ label: "입사 후 11개월", days: Math.min(11, form.firstYearMax) });
    } else {
      rows.push({ label: "1년 미만 (고정)", days: form.firstYearFixedDays });
    }
    // 1년 이상 연차
    const calcYear = (years: number) => {
      if (years < form.incrementStartYear) return form.baseDays;
      const cycles = Math.floor((years - form.incrementStartYear) / form.incrementCycleYears) + 1;
      return Math.min(form.baseDays + cycles * form.incrementDays, form.maxDays);
    };
    [1, 3, 5, 10].forEach((y) => rows.push({ label: `${y}년차`, days: calcYear(y) }));
    return rows;
  })();

  const numberField = (
    label: string,
    key: keyof PolicyForm,
    suffix: string,
    hint?: string
  ) => (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
      <div className="flex items-center gap-2">
        <input
          type="number"
          step="0.5"
          min="0"
          value={String(form[key])}
          onChange={(e) => setNum(key, e.target.value)}
          className="w-28 border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-200"
        />
        <span className="text-sm text-gray-500">{suffix}</span>
      </div>
      {hint && <p className="text-xs text-gray-400 mt-1">{hint}</p>}
    </div>
  );

  return (
    <div className="p-4 sm:p-6 space-y-5">
      {toast && (
        <div className="fixed bottom-6 right-6 z-50 bg-gray-900 text-white text-sm font-medium px-5 py-3 rounded-xl shadow-lg">
          {toast}
        </div>
      )}

      {/* 헤더 */}
      <div>
        <h1 className="text-xl sm:text-2xl font-bold text-gray-900 flex items-center gap-2">
          <CalendarDays size={20} />
          연차 정책
        </h1>
        <p className="text-sm text-gray-500 mt-0.5">
          연차 자동 부여 규칙을 설정합니다 (부여 기준 선택 가능)
        </p>
      </div>

      {loading ? (
        <div className="flex justify-center py-16">
          <Loader2 className="animate-spin text-gray-400" size={28} />
        </div>
      ) : (
        <>
          {/* 부여 기준 */}
          <div className="bg-white rounded-2xl border border-gray-100 p-5 space-y-4">
            <h2 className="text-sm font-bold text-gray-800">부여 기준</h2>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">연차 초기화 기준</label>
              <select
                value={form.grantBasis}
                onChange={(e) => setForm((p) => ({ ...p, grantBasis: e.target.value }))}
                className="w-full sm:w-80 border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-200"
              >
                <option value="fiscal_year">회계연도 기준 (매년 1월 1일 초기화)</option>
                <option value="hire_date">입사일 기준 (입사 기념일에 갱신)</option>
              </select>
              <p className="text-xs text-gray-400 mt-1">
                회계연도: 모든 직원이 매년 1/1에 그 해 근속연수로 갱신. 입사일: 각자 입사 기념일 기준.
              </p>
            </div>
          </div>

          {/* 1년 이후 연차 */}
          <div className="bg-white rounded-2xl border border-gray-100 p-5 space-y-4">
            <h2 className="text-sm font-bold text-gray-800">1년 이후 — 연차</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {numberField("기본 부여일수", "baseDays", "일", "입사 1년 시점 기본 연차")}
              {numberField("최대 상한", "maxDays", "일", "이 일수를 넘지 않음")}
              {numberField("증가 시작 연차", "incrementStartYear", "년차부터", "이 연차부터 증가 시작")}
              {numberField("증가 주기", "incrementCycleYears", "년마다", "몇 년마다 증가 (1 이상)")}
              {numberField("증가량", "incrementDays", "일씩", "주기마다 더해지는 일수")}
            </div>
          </div>

          {/* 1년 미만 (신입 첫 해) */}
          <div className="bg-white rounded-2xl border border-gray-100 p-5 space-y-4">
            <h2 className="text-sm font-bold text-gray-800">1년 미만 (신입 첫 해)</h2>
            <div className="flex items-center gap-3">
              <button
                onClick={() => setForm((p) => ({ ...p, firstYearMonthly: !p.firstYearMonthly }))}
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                  form.firstYearMonthly ? "bg-blue-600" : "bg-gray-300"
                }`}
                aria-pressed={form.firstYearMonthly}
              >
                <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                  form.firstYearMonthly ? "translate-x-6" : "translate-x-1"
                }`} />
              </button>
              <span className="text-sm text-gray-700">
                월차 방식 {form.firstYearMonthly ? "(켜짐 — 매월 1개씩)" : "(꺼짐 — 고정일수)"}
              </span>
            </div>

            {form.firstYearMonthly ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {numberField("월차 최대", "firstYearMax", "개", "1년 미만 최대 (보통 11)")}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">월차 계산 기준</label>
                  <select
                    value={form.monthlyBasis}
                    onChange={(e) => setForm((p) => ({ ...p, monthlyBasis: e.target.value }))}
                    className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-200"
                  >
                    <option value="month">월 단위 (다음 달 되면 +1)</option>
                    <option value="hire_day">입사일 기준 (입사일 지나면 +1)</option>
                  </select>
                </div>
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {numberField("고정 부여일수", "firstYearFixedDays", "일", "신입 첫 해 고정 연차 (예: 12)")}
              </div>
            )}
          </div>

          {/* 미리보기 */}
          <div className="bg-blue-50 border border-blue-200 rounded-2xl p-5">
            <h2 className="text-sm font-bold text-blue-900 mb-3">현재 설정 미리보기</h2>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {preview.map((r, i) => (
                <div key={i} className="bg-white rounded-xl px-3 py-2 text-center">
                  <div className="text-xs text-gray-500">{r.label}</div>
                  <div className="text-lg font-bold text-blue-700">{r.days}일</div>
                </div>
              ))}
            </div>
            <p className="text-xs text-blue-700 mt-2">* 미적용 미리보기입니다. 저장해야 실제 반영됩니다.</p>
          </div>

          {/* 저장 */}
          <div className="flex justify-end">
            <button
              onClick={handleSave}
              disabled={saving}
              className="inline-flex items-center gap-2 bg-blue-600 text-white text-sm font-semibold px-5 py-2.5 rounded-xl hover:bg-blue-700 disabled:opacity-50"
            >
              {saving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
              저장
            </button>
          </div>
        </>
      )}
    </div>
  );
}

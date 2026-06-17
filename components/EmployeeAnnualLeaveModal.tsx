"use client";

import { useState, useEffect, useCallback } from "react";
import { Loader2, X, Save, CalendarDays } from "lucide-react";

interface GrantInfo {
  employeeId: number;
  name: string;
  hiredAt: string | null;
  grantedDays: number;
  autoGrantedDays: number;
  initialUsedDays: number;
  systemUsedDays: number;
  remainingDays: number;
  hasGrantRow: boolean;
}

export default function EmployeeAnnualLeaveModal({
  employeeId,
  employeeName,
  year,
  onClose,
  onSaved,
}: {
  employeeId: number;
  employeeName: string;
  year: number;
  onClose: () => void;
  onSaved?: () => void;
}) {
  const [info, setInfo] = useState<GrantInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [grantedInput, setGrantedInput] = useState("");
  const [initialUsedInput, setInitialUsedInput] = useState("");
  const [note, setNote] = useState("");
  const [toast, setToast] = useState("");

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(""), 2000);
  };

  const fetchInfo = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/annual-leave/grants?year=${year}`);
      if (res.ok) {
        const data = await res.json();
        const found: GrantInfo | undefined = (data.employees ?? []).find(
          (e: GrantInfo) => e.employeeId === employeeId
        );
        if (found) {
          setInfo(found);
          setGrantedInput(String(found.grantedDays));
          setInitialUsedInput(String(found.initialUsedDays));
        }
      }
    } catch (e) {
      console.error("annual grant fetch error:", e);
    } finally {
      setLoading(false);
    }
  }, [employeeId, year]);

  useEffect(() => {
    fetchInfo();
  }, [fetchInfo]);

  // 입력값 기반 실시간 잔여 미리보기
  const previewRemaining = (() => {
    if (!info) return 0;
    const g = grantedInput === "" ? 0 : Number(grantedInput);
    const iu = initialUsedInput === "" ? 0 : Number(initialUsedInput);
    if (!Number.isFinite(g) || !Number.isFinite(iu)) return info.remainingDays;
    return g - iu - info.systemUsedDays;
  })();

  const handleSave = async () => {
    const g = grantedInput === "" ? 0 : Number(grantedInput);
    const iu = initialUsedInput === "" ? 0 : Number(initialUsedInput);
    if (!Number.isFinite(g) || g < 0 || !Number.isFinite(iu) || iu < 0) {
      showToast("0 이상의 숫자를 입력하세요.");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`/api/annual-leave/grants/${employeeId}?year=${year}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ grantedDays: g, initialUsedDays: iu, note: note || null }),
      });
      if (res.ok) {
        showToast("저장되었습니다.");
        await fetchInfo();
        onSaved?.();
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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md max-h-[90vh] overflow-y-auto">
        {toast && (
          <div className="fixed bottom-6 right-6 z-[60] bg-gray-900 text-white text-sm font-medium px-5 py-3 rounded-xl shadow-lg">
            {toast}
          </div>
        )}

        {/* 헤더 */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
          <h2 className="text-lg font-bold text-gray-900 flex items-center gap-2">
            <CalendarDays size={18} className="text-blue-600" />
            {employeeName} — {year}년 연차
          </h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700">
            <X size={20} />
          </button>
        </div>

        {loading ? (
          <div className="flex justify-center py-16">
            <Loader2 className="animate-spin text-gray-400" size={28} />
          </div>
        ) : !info ? (
          <div className="p-6 text-center text-sm text-gray-500">정보를 불러올 수 없습니다.</div>
        ) : (
          <div className="p-5 space-y-5">
            {/* 입사일 */}
            <div className="text-sm text-gray-500">
              입사일: {info.hiredAt ?? "미등록"}
              {info.hiredAt == null && (
                <span className="text-amber-600 ml-2">※ 입사일 없으면 자동계산 0</span>
              )}
            </div>

            {/* 현황 요약 카드 */}
            <div className="grid grid-cols-3 gap-2">
              <div className="bg-blue-50 rounded-xl px-3 py-2 text-center">
                <div className="text-xs text-gray-500">부여</div>
                <div className="text-lg font-bold text-blue-700">{info.grantedDays}</div>
              </div>
              <div className="bg-gray-50 rounded-xl px-3 py-2 text-center">
                <div className="text-xs text-gray-500">사용</div>
                <div className="text-lg font-bold text-gray-700">
                  {(info.initialUsedDays + info.systemUsedDays).toFixed(1)}
                </div>
              </div>
              <div className="bg-emerald-50 rounded-xl px-3 py-2 text-center">
                <div className="text-xs text-gray-500">잔여</div>
                <div className="text-lg font-bold text-emerald-700">{info.remainingDays.toFixed(1)}</div>
              </div>
            </div>

            {/* 사용 내역 분해 */}
            <div className="text-xs text-gray-500 bg-gray-50 rounded-xl px-3 py-2 space-y-1">
              <div className="flex justify-between">
                <span>도입 전 사용(수동)</span>
                <span>{info.initialUsedDays.toFixed(1)}일</span>
              </div>
              <div className="flex justify-between">
                <span>시스템 사용(승인 연차/반차)</span>
                <span>{info.systemUsedDays.toFixed(1)}일</span>
              </div>
              <div className="flex justify-between font-medium text-gray-700 pt-1 border-t border-gray-200">
                <span>자동계산 부여값(참고)</span>
                <span>{info.autoGrantedDays}일</span>
              </div>
            </div>

            {/* 입력 폼 */}
            <div className="space-y-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  부여일수
                  {!info.hasGrantRow && (
                    <span className="text-xs text-blue-500 ml-2">자동계산값 적용 중 (저장 시 고정)</span>
                  )}
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="number" step="0.5" min="0"
                    value={grantedInput}
                    onChange={(e) => setGrantedInput(e.target.value)}
                    className="w-32 border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-200"
                  />
                  <span className="text-sm text-gray-500">일</span>
                  <button
                    type="button"
                    onClick={() => setGrantedInput(String(info.autoGrantedDays))}
                    className="text-xs text-blue-600 hover:underline ml-1"
                  >
                    자동계산({info.autoGrantedDays}) 적용
                  </button>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  도입 전 사용일수
                  <span className="text-xs text-gray-400 ml-2">시스템 도입 전 이미 쓴 연차</span>
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="number" step="0.5" min="0"
                    value={initialUsedInput}
                    onChange={(e) => setInitialUsedInput(e.target.value)}
                    className="w-32 border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-200"
                  />
                  <span className="text-sm text-gray-500">일</span>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">메모 (선택)</label>
                <input
                  type="text"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="예: 2026년 중간 도입 초기값"
                  className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-200"
                />
              </div>

              {/* 입력 기반 잔여 미리보기 */}
              <div className="bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-3 flex items-center justify-between">
                <span className="text-sm text-emerald-800">저장 후 예상 잔여</span>
                <span className="text-xl font-bold text-emerald-700">{previewRemaining.toFixed(1)}일</span>
              </div>
            </div>

            {/* 저장 */}
            <div className="flex justify-end gap-2">
              <button onClick={onClose} className="px-4 py-2.5 bg-white border border-gray-200 text-gray-600 rounded-xl text-sm font-medium hover:bg-gray-50">
                닫기
              </button>
              <button
                onClick={handleSave}
                disabled={saving}
                className="inline-flex items-center gap-2 bg-blue-600 text-white text-sm font-semibold px-5 py-2.5 rounded-xl hover:bg-blue-700 disabled:opacity-50"
              >
                {saving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
                저장
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

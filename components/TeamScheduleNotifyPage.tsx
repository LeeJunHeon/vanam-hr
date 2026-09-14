"use client";

import { useState, useEffect } from "react";
import { Loader2, Users, Save } from "lucide-react";

interface CategoryRow {
  id: number;
  code: string;
  name: string;
  type: string;
}

interface SettingsForm {
  enabled: boolean;
  includeApprovers: boolean;
  categoryCodes: string[];
}

const TYPE_LABELS: Record<string, string> = {
  leave: "휴가 계열",
  work: "외근·출장 계열",
  correction: "정정",
};

// 토글 스위치 (AnnualLeavePolicyPage 와 동일 스타일)
function Switch({ on, onChange }: { on: boolean; onChange: () => void }) {
  return (
    <button
      onClick={onChange}
      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
        on ? "bg-blue-600" : "bg-gray-300"
      }`}
      aria-pressed={on}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
          on ? "translate-x-6" : "translate-x-1"
        }`}
      />
    </button>
  );
}

export default function TeamScheduleNotifyPage() {
  const [form, setForm] = useState<SettingsForm>({ enabled: true, includeApprovers: false, categoryCodes: [] });
  const [categories, setCategories] = useState<CategoryRow[]>([]);
  const [isDefault, setIsDefault] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState("");

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(""), 2500);
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/team-schedule-notify/policy");
        if (!res.ok || cancelled) return;
        const d = await res.json();
        if (cancelled) return;
        setForm({
          enabled: Boolean(d.enabled),
          includeApprovers: Boolean(d.includeApprovers),
          categoryCodes: Array.isArray(d.categoryCodes) ? d.categoryCodes : [],
        });
        setCategories(Array.isArray(d.categories) ? d.categories : []);
        setIsDefault(Boolean(d.isDefault));
      } catch (e) {
        console.error("team-schedule policy fetch error:", e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const toggleCode = (code: string) => {
    setForm((p) => ({
      ...p,
      categoryCodes: p.categoryCodes.includes(code)
        ? p.categoryCodes.filter((c) => c !== code)
        : [...p.categoryCodes, code],
    }));
    setIsDefault(false);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetch("/api/team-schedule-notify/policy", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      if (res.ok) {
        showToast("저장되었습니다.");
        setIsDefault(false);
      } else {
        const d = await res.json().catch(() => ({}));
        showToast(d.error || "저장 실패");
      }
    } catch {
      showToast("네트워크 오류");
    } finally {
      setSaving(false);
    }
  };

  // type 별 그룹 (표시 순서: leave → work → correction → 기타)
  const groupOrder = ["leave", "work", "correction"];
  const grouped = categories.reduce<Record<string, CategoryRow[]>>((acc, c) => {
    (acc[c.type] ??= []).push(c);
    return acc;
  }, {});
  const groupKeys = [
    ...groupOrder.filter((k) => grouped[k]),
    ...Object.keys(grouped).filter((k) => !groupOrder.includes(k)),
  ];

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
          <Users size={20} />
          팀 일정 알림
        </h1>
        <p className="text-sm text-gray-500 mt-0.5">
          팀원의 휴가·반차 등이 승인되면 같은 부서 동료에게 알립니다. 발송 채널(앱/이메일/푸시)은
          &apos;알림 설정&apos; 탭의 &apos;팀 일정 안내&apos; 항목에서 조정합니다.
        </p>
      </div>

      {loading ? (
        <div className="flex justify-center py-16">
          <Loader2 className="animate-spin text-gray-400" size={28} />
        </div>
      ) : (
        <>
          {/* 기본 설정 */}
          <div className="bg-white rounded-2xl border border-gray-100 p-5 space-y-4">
            <h2 className="text-sm font-bold text-gray-800">기본 설정</h2>
            <div className="flex items-center gap-3">
              <Switch on={form.enabled} onChange={() => setForm((p) => ({ ...p, enabled: !p.enabled }))} />
              <div>
                <p className="text-sm font-medium text-gray-700">기능 사용</p>
                <p className="text-xs text-gray-400">끄면 승인이 확정되어도 팀 일정 알림을 보내지 않습니다.</p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <Switch
                on={form.includeApprovers}
                onChange={() => setForm((p) => ({ ...p, includeApprovers: !p.includeApprovers }))}
              />
              <div>
                <p className="text-sm font-medium text-gray-700">결재자에게도 보내기</p>
                <p className="text-xs text-gray-400">끄면 부서 결재선에 등록된 사람은 제외됩니다.</p>
              </div>
            </div>
          </div>

          {/* 대상 카테고리 */}
          <div className="bg-white rounded-2xl border border-gray-100 p-5 space-y-4">
            <div>
              <h2 className="text-sm font-bold text-gray-800">알릴 카테고리</h2>
              <p className="text-xs text-gray-400 mt-0.5">
                체크된 근태 항목이 승인되면 알립니다. 아무것도 체크하지 않고 저장하면 기본 규칙으로 돌아갑니다.
              </p>
            </div>
            {isDefault && (
              <p className="text-xs text-blue-700 bg-blue-50 rounded-xl px-3 py-2">
                현재 기본 규칙(출장/외근 제외한 휴가 계열) 적용 중입니다. 저장하면 아래 선택 목록이 고정됩니다.
              </p>
            )}
            {groupKeys.map((type) => (
              <div key={type}>
                <p className="text-xs font-semibold text-gray-500 mb-2">{TYPE_LABELS[type] ?? type}</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {grouped[type].map((c) => {
                    const checked = form.categoryCodes.includes(c.code);
                    return (
                      <label
                        key={c.id}
                        className={`flex items-center gap-2 border rounded-xl px-3 py-2 text-sm cursor-pointer ${
                          checked ? "border-blue-300 bg-blue-50" : "border-gray-200 hover:bg-gray-50"
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleCode(c.code)}
                          className="accent-blue-600"
                        />
                        <span className="text-gray-800">{c.name}</span>
                        <span className="text-xs text-gray-400">({c.code})</span>
                      </label>
                    );
                  })}
                </div>
              </div>
            ))}
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

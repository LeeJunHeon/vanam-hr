"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Search,
  Edit,
  Loader2,
  X,
  Download,
  Eye,
  EyeOff,
  Settings,
  Clock,
  CheckCircle,
  Bell,
  Globe,
} from "lucide-react";
import { exportCSV } from "@/lib/csvUtils";
import { todayYmd } from "@/lib/dateUtils";

interface Policy {
  key: string;
  value: string;
  description: string | null;
  updatedAt: string;
}

// 비밀번호류 키 감지 — UI에서 마스킹 처리
const isSecretKey = (key: string): boolean => {
  return /(_key|_secret|_token|_password|_private)$/i.test(key);
};

// 키 prefix로 그룹 라벨 추정 (단순 표시용, 비즈니스 로직 없음)
const getGroupIcon = (key: string) => {
  if (key.startsWith("web_push_")) return Bell;
  if (key.startsWith("snmp_")) return Globe;
  if (key.startsWith("monthly_")) return CheckCircle;
  if (key.includes("hour") || key.includes("minute") || key.includes("delegate"))
    return Clock;
  return Settings;
};

export default function PoliciesPage() {
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [revealedKeys, setRevealedKeys] = useState<Set<string>>(new Set());

  const [editTarget, setEditTarget] = useState<Policy | null>(null);
  const [editValue, setEditValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");
  const [toast, setToast] = useState("");

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(""), 2500);
  };

  const fetchPolicies = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (search) params.set("search", search);

      const res = await fetch(`/api/policies?${params}`);
      if (res.ok) setPolicies(await res.json());
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, [search]);

  useEffect(() => {
    const t = setTimeout(fetchPolicies, 300);
    return () => clearTimeout(t);
  }, [fetchPolicies]);

  const openEdit = (p: Policy) => {
    setEditTarget(p);
    setEditValue(p.value);
    setFormError("");
  };

  const handleSave = async () => {
    if (!editTarget) return;
    setFormError("");
    setSaving(true);
    try {
      const res = await fetch(`/api/policies?key=${encodeURIComponent(editTarget.key)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: editValue }),
      });
      const data = await res.json();
      if (!res.ok) {
        setFormError(data.error || "저장 실패");
        return;
      }
      showToast("✅ 정책이 수정되었습니다");
      setEditTarget(null);
      fetchPolicies();
    } catch {
      setFormError("네트워크 오류");
    } finally {
      setSaving(false);
    }
  };

  const toggleReveal = (key: string) => {
    setRevealedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const handleExportCSV = () => {
    if (!policies || policies.length === 0) return;
    exportCSV(
      ["키", "값", "설명", "수정 일시"],
      policies.map((p) => [
        p.key,
        // 비밀 키는 값을 마스킹해서 export
        isSecretKey(p.key) && p.value ? "***" : p.value,
        p.description ?? "",
        new Date(p.updatedAt).toLocaleString("ko-KR"),
      ]),
      `정책설정_${todayYmd()}.csv`
    );
  };

  const formatValue = (p: Policy): string => {
    if (!p.value) return "(빈 값)";
    if (isSecretKey(p.key) && !revealedKeys.has(p.key)) {
      return "•".repeat(Math.min(p.value.length, 20));
    }
    return p.value;
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
            정책 설정
          </h1>
          <p className="text-sm text-gray-500 mt-0.5">
            시스템 동작에 사용되는 정책 값을 관리합니다
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleExportCSV}
            disabled={!policies || policies.length === 0}
            className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium bg-white border border-gray-200 text-gray-600 rounded-xl hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            <Download size={15} />
            CSV
          </button>
        </div>
      </div>

      {/* 안내 */}
      <div className="bg-amber-50 border border-amber-200 rounded-2xl px-4 py-3 text-sm text-amber-800">
        <strong>안내:</strong> 정책 키는 시스템 코드가 직접 참조합니다. 키 자체의 추가·삭제는 DB 직접 작업이 필요하며, 이 화면에서는 <strong>값(value)</strong>만 수정할 수 있습니다.
      </div>

      {/* 검색 */}
      <div className="bg-white rounded-2xl border border-gray-100 p-3 sm:p-4">
        <div className="relative">
          <Search
            size={16}
            className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-400"
          />
          <input
            type="text"
            placeholder="키 또는 설명으로 검색"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-10 pr-4 py-2.5 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-blue-500 outline-none"
          />
        </div>
      </div>

      {/* 목록 */}
      {loading ? (
        <div className="flex items-center justify-center h-32">
          <Loader2 size={24} className="animate-spin text-blue-500" />
          <span className="ml-2 text-sm text-gray-500">로딩 중...</span>
        </div>
      ) : (
        <div className="space-y-2">
          {policies.length === 0 ? (
            <div className="bg-white rounded-2xl border border-gray-100 px-5 py-12 text-center text-sm text-gray-400">
              데이터가 없습니다
            </div>
          ) : (
            policies.map((p) => {
              const Icon = getGroupIcon(p.key);
              const isSecret = isSecretKey(p.key);
              const isRevealed = revealedKeys.has(p.key);

              return (
                <div
                  key={p.key}
                  className="bg-white rounded-2xl border border-gray-100 p-4 sm:p-5 hover:border-blue-200 transition-colors group"
                >
                  <div className="flex items-start gap-3">
                    <div className="p-2 rounded-xl bg-blue-50 text-blue-500 shrink-0">
                      <Icon size={18} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0">
                          <code className="text-sm font-mono font-semibold text-gray-900 truncate">
                            {p.key}
                          </code>
                          {isSecret && (
                            <span className="text-[10px] font-semibold text-rose-600 bg-rose-50 px-2 py-0.5 rounded-full shrink-0">
                              SECRET
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          {isSecret && p.value && (
                            <button
                              onClick={() => toggleReveal(p.key)}
                              className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-700"
                              title={isRevealed ? "숨기기" : "값 보기"}
                            >
                              {isRevealed ? <EyeOff size={15} /> : <Eye size={15} />}
                            </button>
                          )}
                          <button
                            onClick={() => openEdit(p)}
                            className="p-1.5 rounded-lg hover:bg-blue-100 text-gray-400 hover:text-blue-600 opacity-0 group-hover:opacity-100 transition-opacity sm:opacity-100"
                            title="값 수정"
                          >
                            <Edit size={15} />
                          </button>
                        </div>
                      </div>
                      {p.description && (
                        <p className="text-xs text-gray-500 mt-1">
                          {p.description}
                        </p>
                      )}
                      <div className="mt-2 px-3 py-2 bg-gray-50 rounded-xl">
                        <p className="text-sm font-mono text-gray-900 break-all">
                          {formatValue(p)}
                        </p>
                      </div>
                      <p className="text-[10px] text-gray-400 mt-1">
                        최종 수정: {new Date(p.updatedAt).toLocaleString("ko-KR")}
                      </p>
                    </div>
                  </div>
                </div>
              );
            })
          )}

          {policies.length > 0 && (
            <p className="text-xs text-gray-400 text-center pt-2">
              총 {policies.length}건
            </p>
          )}
        </div>
      )}

      {/* 수정 모달 */}
      {editTarget && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ backgroundColor: "rgba(0,0,0,0.4)" }}
        >
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-bold text-gray-900">정책 수정</h3>
              <button
                onClick={() => setEditTarget(null)}
                className="text-gray-400 hover:text-gray-700"
              >
                <X size={18} />
              </button>
            </div>

            <div className="space-y-3">
              <div>
                <label className="block text-xs font-semibold text-gray-500 mb-1">
                  키
                </label>
                <code className="block px-3 py-2 bg-gray-50 rounded-xl text-sm font-mono text-gray-900">
                  {editTarget.key}
                </code>
              </div>

              {editTarget.description && (
                <div>
                  <label className="block text-xs font-semibold text-gray-500 mb-1">
                    설명
                  </label>
                  <p className="text-sm text-gray-700 bg-blue-50 px-3 py-2 rounded-xl">
                    {editTarget.description}
                  </p>
                </div>
              )}

              <div>
                <label className="block text-xs font-semibold text-gray-500 mb-1">
                  값 <span className="text-rose-500">*</span>
                </label>
                <input
                  type={isSecretKey(editTarget.key) ? "password" : "text"}
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  className="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm font-mono outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="값을 입력하세요"
                />
              </div>

              {formError && (
                <p className="text-sm text-red-500 bg-red-50 px-3 py-2 rounded-xl">
                  {formError}
                </p>
              )}
            </div>

            <div className="flex justify-end gap-2">
              <button
                onClick={() => setEditTarget(null)}
                className="px-4 py-2 text-sm font-medium text-gray-600 bg-gray-100 rounded-xl hover:bg-gray-200"
              >
                취소
              </button>
              <button
                onClick={handleSave}
                disabled={saving}
                className="px-4 py-2 text-sm font-semibold text-white bg-blue-500 rounded-xl hover:bg-blue-600 disabled:opacity-60"
              >
                {saving ? "저장 중..." : "저장"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

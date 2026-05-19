"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import {
  Search,
  Plus,
  Edit,
  Trash2,
  Loader2,
  X,
  Download,
  Shield,
} from "lucide-react";
import { exportCSV } from "@/lib/csvUtils";

interface Lookup {
  id: number;
  category: string;
  code: string;
  label: string;
  color: string | null;
  sortOrder: number;
  isSystem: boolean;
  isActive: boolean;
  description: string | null;
}

const EMPTY_FORM = {
  category: "",
  code: "",
  label: "",
  color: "",
  sortOrder: 0,
  description: "",
};

export default function LookupsPage() {
  const [lookups, setLookups] = useState<Lookup[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<string>("");
  const [includeInactive, setIncludeInactive] = useState(false);

  const [showForm, setShowForm] = useState(false);
  const [editTarget, setEditTarget] = useState<Lookup | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");
  const [toast, setToast] = useState("");

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(""), 2500);
  };

  const fetchLookups = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (categoryFilter) params.set("category", categoryFilter);
      if (search) params.set("search", search);
      if (includeInactive) params.set("includeInactive", "true");

      const res = await fetch(`/api/lookups?${params}`);
      if (res.ok) setLookups(await res.json());
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, [search, categoryFilter, includeInactive]);

  useEffect(() => {
    const t = setTimeout(fetchLookups, 300);
    return () => clearTimeout(t);
  }, [fetchLookups]);

  // 카테고리 목록 동적 추출 (서버에서 받은 데이터에서 distinct)
  const categories = useMemo(() => {
    const set = new Set(lookups.map((l) => l.category));
    return Array.from(set).sort();
  }, [lookups]);

  const openCreate = () => {
    setEditTarget(null);
    setForm({ ...EMPTY_FORM, category: categoryFilter });
    setFormError("");
    setShowForm(true);
  };

  const openEdit = (l: Lookup) => {
    setEditTarget(l);
    setForm({
      category: l.category,
      code: l.code,
      label: l.label,
      color: l.color || "",
      sortOrder: l.sortOrder,
      description: l.description || "",
    });
    setFormError("");
    setShowForm(true);
  };

  const handleSave = async () => {
    if (editTarget === null) {
      if (!form.category.trim() || !form.code.trim() || !form.label.trim()) {
        setFormError("카테고리, 코드, 라벨은 필수입니다.");
        return;
      }
    } else {
      if (!form.label.trim()) {
        setFormError("라벨은 필수입니다.");
        return;
      }
    }

    setFormError("");
    setSaving(true);
    try {
      const url = editTarget
        ? `/api/lookups?id=${editTarget.id}`
        : "/api/lookups";
      const method = editTarget ? "PUT" : "POST";

      const payload: any = {
        label: form.label.trim(),
        color: form.color.trim() || null,
        sortOrder: Number(form.sortOrder) || 0,
        description: form.description.trim() || null,
      };
      if (!editTarget) {
        payload.category = form.category.trim();
        payload.code = form.code.trim();
      }

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
      fetchLookups();
    } catch {
      setFormError("네트워크 오류");
    } finally {
      setSaving(false);
    }
  };

  const handleToggleActive = async (l: Lookup) => {
    try {
      const res = await fetch(`/api/lookups?id=${l.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: !l.isActive }),
      });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || "변경 실패");
        return;
      }
      showToast(`✅ ${l.isActive ? "비활성" : "활성"} 처리됨`);
      fetchLookups();
    } catch {
      alert("네트워크 오류");
    }
  };

  const handleDelete = async (l: Lookup) => {
    if (l.isSystem) {
      alert("시스템 룩업은 삭제할 수 없습니다. 비활성 처리를 사용하세요.");
      return;
    }
    if (!confirm(`"${l.category} / ${l.code}" 룩업을 삭제하시겠습니까?`)) return;
    try {
      const res = await fetch(`/api/lookups?id=${l.id}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || "삭제 실패");
        return;
      }
      showToast("✅ 삭제되었습니다");
      fetchLookups();
    } catch {
      alert("네트워크 오류");
    }
  };

  const handleExportCSV = () => {
    if (!lookups || lookups.length === 0) return;
    exportCSV(
      ["카테고리", "코드", "라벨", "색상", "정렬", "시스템", "활성", "설명"],
      lookups.map((l) => [
        l.category,
        l.code,
        l.label,
        l.color ?? "",
        l.sortOrder,
        l.isSystem ? "Y" : "N",
        l.isActive ? "Y" : "N",
        l.description ?? "",
      ]),
      `코드룩업_${new Date().toISOString().split("T")[0]}.csv`
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
            코드 룩업
          </h1>
          <p className="text-sm text-gray-500 mt-0.5">
            상태/유형의 라벨과 색상을 관리합니다
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleExportCSV}
            disabled={!lookups || lookups.length === 0}
            className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium bg-white border border-gray-200 text-gray-600 rounded-xl hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            <Download size={15} />
            CSV
          </button>
          <button
            onClick={openCreate}
            className="flex items-center gap-2 px-4 py-2.5 text-sm font-bold text-white bg-blue-500 rounded-xl hover:bg-blue-600 shadow-sm"
          >
            <Plus size={16} />
            룩업 추가
          </button>
        </div>
      </div>

      {/* 등록 / 수정 폼 */}
      {showForm && (
        <div className="bg-blue-50 border border-blue-200 rounded-2xl p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="font-bold text-blue-900">
              {editTarget ? "룩업 수정" : "룩업 추가"}
            </h2>
            <button
              onClick={() => setShowForm(false)}
              className="text-blue-400 hover:text-blue-700"
            >
              <X size={18} />
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {/* 카테고리 (수정 시 잠금) */}
            <div>
              <label className="block text-xs font-semibold text-blue-700 mb-1">
                카테고리 <span className="text-rose-500">*</span>
              </label>
              <input
                value={form.category}
                onChange={(e) =>
                  setForm((f) => ({ ...f, category: e.target.value }))
                }
                placeholder="예: device_type"
                disabled={!!editTarget}
                className="w-full px-3 py-2.5 border border-blue-200 rounded-xl text-sm bg-white outline-none focus:ring-2 focus:ring-blue-400 disabled:bg-gray-100 disabled:text-gray-500"
              />
            </div>

            {/* 코드 (수정 시 잠금) */}
            <div>
              <label className="block text-xs font-semibold text-blue-700 mb-1">
                코드 <span className="text-rose-500">*</span>
              </label>
              <input
                value={form.code}
                onChange={(e) =>
                  setForm((f) => ({ ...f, code: e.target.value }))
                }
                placeholder="예: laptop"
                disabled={!!editTarget}
                className="w-full px-3 py-2.5 border border-blue-200 rounded-xl text-sm bg-white outline-none focus:ring-2 focus:ring-blue-400 disabled:bg-gray-100 disabled:text-gray-500"
              />
            </div>

            {/* 라벨 */}
            <div>
              <label className="block text-xs font-semibold text-blue-700 mb-1">
                라벨 <span className="text-rose-500">*</span>
              </label>
              <input
                value={form.label}
                onChange={(e) =>
                  setForm((f) => ({ ...f, label: e.target.value }))
                }
                placeholder="예: 노트북"
                className="w-full px-3 py-2.5 border border-blue-200 rounded-xl text-sm bg-white outline-none focus:ring-2 focus:ring-blue-400"
              />
            </div>

            {/* 색상 */}
            <div>
              <label className="block text-xs font-semibold text-blue-700 mb-1">
                색상 (HEX 또는 Tailwind 클래스)
              </label>
              <div className="flex gap-2">
                <input
                  value={form.color}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, color: e.target.value }))
                  }
                  placeholder="예: #10b981"
                  className="flex-1 px-3 py-2.5 border border-blue-200 rounded-xl text-sm bg-white outline-none focus:ring-2 focus:ring-blue-400"
                />
                {form.color && form.color.startsWith("#") && (
                  <div
                    className="w-10 h-10 rounded-xl border border-blue-200"
                    style={{ backgroundColor: form.color }}
                    title="색상 미리보기"
                  />
                )}
              </div>
            </div>

            {/* 정렬 순서 */}
            <div>
              <label className="block text-xs font-semibold text-blue-700 mb-1">
                정렬 순서
              </label>
              <input
                type="number"
                value={form.sortOrder}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    sortOrder: parseInt(e.target.value) || 0,
                  }))
                }
                className="w-full px-3 py-2.5 border border-blue-200 rounded-xl text-sm bg-white outline-none focus:ring-2 focus:ring-blue-400"
              />
            </div>

            {/* 설명 */}
            <div className="sm:col-span-2">
              <label className="block text-xs font-semibold text-blue-700 mb-1">
                설명
              </label>
              <input
                value={form.description}
                onChange={(e) =>
                  setForm((f) => ({ ...f, description: e.target.value }))
                }
                className="w-full px-3 py-2.5 border border-blue-200 rounded-xl text-sm bg-white outline-none focus:ring-2 focus:ring-blue-400"
              />
            </div>
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
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {/* 카테고리 필터 */}
          <div>
            <label className="block text-xs font-semibold text-gray-500 mb-1">
              카테고리
            </label>
            <select
              value={categoryFilter}
              onChange={(e) => setCategoryFilter(e.target.value)}
              className="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm bg-white outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="">전체</option>
              {categories.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>

          {/* 검색 */}
          <div className="sm:col-span-2">
            <label className="block text-xs font-semibold text-gray-500 mb-1">
              검색
            </label>
            <div className="relative">
              <Search
                size={16}
                className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-400"
              />
              <input
                type="text"
                placeholder="코드 또는 라벨로 검색"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full pl-10 pr-4 py-2.5 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-blue-500 outline-none"
              />
            </div>
          </div>
        </div>

        {/* 비활성 포함 토글 */}
        <label className="flex items-center gap-2 text-sm text-gray-600 cursor-pointer w-fit">
          <input
            type="checkbox"
            checked={includeInactive}
            onChange={(e) => setIncludeInactive(e.target.checked)}
            className="rounded"
          />
          비활성 룩업 포함
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
                    카테고리
                  </th>
                  <th className="text-left text-xs font-semibold text-gray-500 px-5 py-3">
                    코드
                  </th>
                  <th className="text-left text-xs font-semibold text-gray-500 px-5 py-3">
                    라벨
                  </th>
                  <th className="text-center text-xs font-semibold text-gray-500 px-5 py-3">
                    색상
                  </th>
                  <th className="text-center text-xs font-semibold text-gray-500 px-5 py-3">
                    정렬
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
                {lookups.length === 0 ? (
                  <tr>
                    <td
                      colSpan={7}
                      className="px-5 py-12 text-center text-sm text-gray-400"
                    >
                      데이터가 없습니다
                    </td>
                  </tr>
                ) : (
                  lookups.map((l) => (
                    <tr
                      key={l.id}
                      className={`border-b border-gray-50 hover:bg-blue-50/30 group ${
                        !l.isActive ? "opacity-40" : ""
                      }`}
                    >
                      <td className="px-5 py-3 text-sm text-gray-600 font-mono">
                        {l.category}
                      </td>
                      <td className="px-5 py-3 text-sm text-gray-900 font-mono">
                        {l.code}
                      </td>
                      <td className="px-5 py-3 text-sm font-semibold text-gray-900">
                        <div className="flex items-center gap-2">
                          {l.label}
                          {l.isSystem && (
                            <span
                              title="시스템 룩업 (삭제 불가)"
                              className="text-gray-400"
                            >
                              <Shield size={12} />
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-5 py-3 text-center">
                        {l.color ? (
                          <div className="flex items-center justify-center gap-2">
                            {l.color.startsWith("#") && (
                              <div
                                className="w-5 h-5 rounded-full border border-gray-200"
                                style={{ backgroundColor: l.color }}
                              />
                            )}
                            <span className="text-xs font-mono text-gray-500">
                              {l.color}
                            </span>
                          </div>
                        ) : (
                          <span className="text-xs text-gray-300">-</span>
                        )}
                      </td>
                      <td className="px-5 py-3 text-center text-sm text-gray-500">
                        {l.sortOrder}
                      </td>
                      <td className="px-5 py-3 text-center">
                        <button
                          onClick={() => handleToggleActive(l)}
                          className={`text-xs font-semibold px-2 py-0.5 rounded-full hover:opacity-80 ${
                            l.isActive
                              ? "text-emerald-700 bg-emerald-50"
                              : "text-gray-400 bg-gray-100"
                          }`}
                          title="클릭하여 활성/비활성 토글"
                        >
                          {l.isActive ? "활성" : "비활성"}
                        </button>
                      </td>
                      <td className="px-5 py-3">
                        <div className="flex justify-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                          <button
                            onClick={() => openEdit(l)}
                            className="p-1.5 rounded-lg hover:bg-blue-100 text-gray-400 hover:text-blue-600"
                          >
                            <Edit size={15} />
                          </button>
                          <button
                            onClick={() => handleDelete(l)}
                            disabled={l.isSystem}
                            className="p-1.5 rounded-lg hover:bg-rose-100 text-gray-400 hover:text-rose-600 disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent"
                            title={
                              l.isSystem
                                ? "시스템 룩업은 삭제할 수 없습니다"
                                : "삭제"
                            }
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
            {lookups.map((l) => (
              <div
                key={l.id}
                className={`px-4 py-3 space-y-1 ${
                  !l.isActive ? "opacity-40" : ""
                }`}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    {l.color?.startsWith("#") && (
                      <div
                        className="w-4 h-4 rounded-full border border-gray-200"
                        style={{ backgroundColor: l.color }}
                      />
                    )}
                    <span className="text-sm font-semibold text-gray-900">
                      {l.label}
                    </span>
                    {l.isSystem && (
                      <span className="text-gray-400">
                        <Shield size={12} />
                      </span>
                    )}
                  </div>
                  <div className="flex gap-1">
                    <button
                      onClick={() => openEdit(l)}
                      className="p-1.5 rounded-lg hover:bg-blue-50 text-gray-400 hover:text-blue-600"
                    >
                      <Edit size={14} />
                    </button>
                    <button
                      onClick={() => handleDelete(l)}
                      disabled={l.isSystem}
                      className="p-1.5 rounded-lg hover:bg-rose-50 text-gray-400 hover:text-rose-600 disabled:opacity-30"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
                <p className="text-xs text-gray-400 font-mono">
                  {l.category} / {l.code}
                </p>
              </div>
            ))}
          </div>

          <div className="px-5 py-3 border-t border-gray-100 bg-gray-50">
            <p className="text-xs font-semibold text-gray-700">
              총 {lookups.length}건
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

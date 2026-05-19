"use client";

import { useState, useEffect, useCallback } from "react";
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

interface Category {
  id: number;
  code: string;
  name: string;
  type: string;
  annualLeaveDeduct: number | null;
  requireApproval: boolean;
  displayColor: string | null;
  isSystem: boolean;
  isActive: boolean;
  sortOrder: number;
  description: string | null;
}

interface TypeLookup {
  id: number;
  code: string;
  label: string;
}

const EMPTY_FORM = {
  code: "",
  name: "",
  type: "",
  annualLeaveDeduct: "" as "" | string, // "" or "0" or "0.5" or "1"
  requireApproval: true,
  displayColor: "",
  sortOrder: 0,
  description: "",
};

export default function CategoriesPage() {
  const [categories, setCategories] = useState<Category[]>([]);
  const [typeLookups, setTypeLookups] = useState<TypeLookup[]>([]); // category_type 룩업
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<string>("");
  const [includeInactive, setIncludeInactive] = useState(false);

  const [showForm, setShowForm] = useState(false);
  const [editTarget, setEditTarget] = useState<Category | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");
  const [toast, setToast] = useState("");

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(""), 2500);
  };

  // type 옵션을 code_lookups에서 동적 로드 (페이지 진입 시 1회)
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(
          "/api/lookups?category=category_type&includeInactive=false"
        );
        if (res.ok) {
          const data = await res.json();
          setTypeLookups(data);
        }
      } catch (e) {
        console.error("type lookups fetch error:", e);
      }
    })();
  }, []);

  const fetchCategories = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (typeFilter) params.set("type", typeFilter);
      if (search) params.set("search", search);
      if (includeInactive) params.set("includeInactive", "true");

      const res = await fetch(`/api/categories?${params}`);
      if (res.ok) setCategories(await res.json());
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, [search, typeFilter, includeInactive]);

  useEffect(() => {
    const t = setTimeout(fetchCategories, 300);
    return () => clearTimeout(t);
  }, [fetchCategories]);

  // type 라벨 가져오는 헬퍼 (코드 → 라벨 변환)
  const getTypeLabel = (code: string): string => {
    const lookup = typeLookups.find((l) => l.code === code);
    return lookup ? lookup.label : code; // 룩업 없으면 코드 그대로
  };

  const openCreate = () => {
    setEditTarget(null);
    setForm({
      ...EMPTY_FORM,
      type: typeLookups[0]?.code || "",
    });
    setFormError("");
    setShowForm(true);
  };

  const openEdit = (c: Category) => {
    setEditTarget(c);
    setForm({
      code: c.code,
      name: c.name,
      type: c.type,
      annualLeaveDeduct:
        c.annualLeaveDeduct === null ? "" : String(c.annualLeaveDeduct),
      requireApproval: c.requireApproval,
      displayColor: c.displayColor || "",
      sortOrder: c.sortOrder,
      description: c.description || "",
    });
    setFormError("");
    setShowForm(true);
  };

  const handleSave = async () => {
    if (editTarget === null) {
      if (!form.code.trim() || !form.name.trim() || !form.type.trim()) {
        setFormError("코드, 이름, 유형은 필수입니다.");
        return;
      }
    } else {
      if (!form.name.trim()) {
        setFormError("이름은 필수입니다.");
        return;
      }
    }

    setFormError("");
    setSaving(true);
    try {
      const url = editTarget
        ? `/api/categories?id=${editTarget.id}`
        : "/api/categories";
      const method = editTarget ? "PUT" : "POST";

      const payload: any = {
        name: form.name.trim(),
        annualLeaveDeduct: form.annualLeaveDeduct === "" ? null : form.annualLeaveDeduct,
        requireApproval: form.requireApproval,
        displayColor: form.displayColor.trim() || null,
        sortOrder: Number(form.sortOrder) || 0,
        description: form.description.trim() || null,
      };
      if (!editTarget) {
        payload.code = form.code.trim();
        payload.type = form.type.trim();
      } else if (!editTarget.isSystem) {
        // 시스템 항목 아니면 type도 변경 가능
        payload.type = form.type.trim();
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
      fetchCategories();
    } catch {
      setFormError("네트워크 오류");
    } finally {
      setSaving(false);
    }
  };

  const handleToggleActive = async (c: Category) => {
    try {
      const res = await fetch(`/api/categories?id=${c.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: !c.isActive }),
      });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || "변경 실패");
        return;
      }
      showToast(`✅ ${c.isActive ? "비활성" : "활성"} 처리됨`);
      fetchCategories();
    } catch {
      alert("네트워크 오류");
    }
  };

  const handleDelete = async (c: Category) => {
    if (c.isSystem) {
      alert("시스템 항목은 삭제할 수 없습니다. 비활성 처리를 사용하세요.");
      return;
    }
    if (!confirm(`"${c.name}" 항목을 삭제하시겠습니까?`)) return;
    try {
      const res = await fetch(`/api/categories?id=${c.id}`, {
        method: "DELETE",
      });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || "삭제 실패");
        return;
      }
      showToast("✅ 삭제되었습니다");
      fetchCategories();
    } catch {
      alert("네트워크 오류");
    }
  };

  const handleExportCSV = () => {
    if (!categories || categories.length === 0) return;
    exportCSV(
      ["코드", "이름", "유형", "연차차감", "결재필요", "색상", "정렬", "시스템", "활성", "설명"],
      categories.map((c) => [
        c.code,
        c.name,
        getTypeLabel(c.type),
        c.annualLeaveDeduct ?? "",
        c.requireApproval ? "Y" : "N",
        c.displayColor ?? "",
        c.sortOrder,
        c.isSystem ? "Y" : "N",
        c.isActive ? "Y" : "N",
        c.description ?? "",
      ]),
      `근태항목_${new Date().toISOString().split("T")[0]}.csv`
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
            근태 항목
          </h1>
          <p className="text-sm text-gray-500 mt-0.5">
            휴가, 외근, 정정 등 근태 항목을 관리합니다
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleExportCSV}
            disabled={!categories || categories.length === 0}
            className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium bg-white border border-gray-200 text-gray-600 rounded-xl hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            <Download size={15} />
            CSV
          </button>
          <button
            onClick={openCreate}
            disabled={typeLookups.length === 0}
            className="flex items-center gap-2 px-4 py-2.5 text-sm font-bold text-white bg-blue-500 rounded-xl hover:bg-blue-600 shadow-sm disabled:opacity-50 disabled:cursor-not-allowed"
            title={
              typeLookups.length === 0
                ? "코드 룩업의 category_type에 활성 코드가 없습니다"
                : ""
            }
          >
            <Plus size={16} />
            항목 추가
          </button>
        </div>
      </div>

      {/* 등록 / 수정 폼 */}
      {showForm && (
        <div className="bg-blue-50 border border-blue-200 rounded-2xl p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="font-bold text-blue-900">
              {editTarget ? "항목 수정" : "항목 추가"}
            </h2>
            <button
              onClick={() => setShowForm(false)}
              className="text-blue-400 hover:text-blue-700"
            >
              <X size={18} />
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {/* 코드 (수정 시 잠금) */}
            <div>
              <label className="block text-xs font-semibold text-blue-700 mb-1">
                코드 <span className="text-rose-500">*</span>
              </label>
              <input
                value={form.code}
                onChange={(e) =>
                  setForm((f) => ({ ...f, code: e.target.value.toUpperCase() }))
                }
                placeholder="예: SICK"
                disabled={!!editTarget}
                className="w-full px-3 py-2.5 border border-blue-200 rounded-xl text-sm bg-white outline-none focus:ring-2 focus:ring-blue-400 disabled:bg-gray-100 disabled:text-gray-500 font-mono"
              />
            </div>

            {/* 이름 */}
            <div>
              <label className="block text-xs font-semibold text-blue-700 mb-1">
                이름 <span className="text-rose-500">*</span>
              </label>
              <input
                value={form.name}
                onChange={(e) =>
                  setForm((f) => ({ ...f, name: e.target.value }))
                }
                placeholder="예: 병가"
                className="w-full px-3 py-2.5 border border-blue-200 rounded-xl text-sm bg-white outline-none focus:ring-2 focus:ring-blue-400"
              />
            </div>

            {/* 유형 (lookup 동적 select, 시스템 항목 수정 시 잠금) */}
            <div>
              <label className="block text-xs font-semibold text-blue-700 mb-1">
                유형 <span className="text-rose-500">*</span>
              </label>
              <select
                value={form.type}
                onChange={(e) =>
                  setForm((f) => ({ ...f, type: e.target.value }))
                }
                disabled={!!editTarget && editTarget.isSystem}
                className="w-full px-3 py-2.5 border border-blue-200 rounded-xl text-sm bg-white outline-none focus:ring-2 focus:ring-blue-400 disabled:bg-gray-100 disabled:text-gray-500"
              >
                <option value="">선택</option>
                {typeLookups.map((l) => (
                  <option key={l.code} value={l.code}>
                    {l.label} ({l.code})
                  </option>
                ))}
              </select>
              {editTarget?.isSystem && (
                <p className="text-[10px] text-gray-400 mt-1">
                  시스템 항목 — 유형 변경 불가
                </p>
              )}
            </div>

            {/* 연차 차감 */}
            <div>
              <label className="block text-xs font-semibold text-blue-700 mb-1">
                연차 차감 (일)
              </label>
              <input
                type="number"
                step="0.5"
                min="0"
                value={form.annualLeaveDeduct}
                onChange={(e) =>
                  setForm((f) => ({ ...f, annualLeaveDeduct: e.target.value }))
                }
                placeholder="예: 1 / 0.5 / 0 (빈 값=NULL)"
                className="w-full px-3 py-2.5 border border-blue-200 rounded-xl text-sm bg-white outline-none focus:ring-2 focus:ring-blue-400"
              />
              <p className="text-[10px] text-gray-500 mt-1">
                빈 값은 미적용. 0은 차감 없음 표시.
              </p>
            </div>

            {/* 결재 필요 */}
            <div>
              <label className="block text-xs font-semibold text-blue-700 mb-1">
                결재 필요
              </label>
              <label className="flex items-center gap-2 px-3 py-2.5 bg-white border border-blue-200 rounded-xl cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.requireApproval}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, requireApproval: e.target.checked }))
                  }
                  className="rounded"
                />
                <span className="text-sm text-gray-700">
                  결재선을 거쳐야 함
                </span>
              </label>
            </div>

            {/* 색상 */}
            <div>
              <label className="block text-xs font-semibold text-blue-700 mb-1">
                표시 색상 (HEX)
              </label>
              <div className="flex gap-2">
                <input
                  value={form.displayColor}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, displayColor: e.target.value }))
                  }
                  placeholder="예: #3b82f6"
                  className="flex-1 px-3 py-2.5 border border-blue-200 rounded-xl text-sm bg-white outline-none focus:ring-2 focus:ring-blue-400"
                />
                {form.displayColor && form.displayColor.startsWith("#") && (
                  <div
                    className="w-10 h-10 rounded-xl border border-blue-200"
                    style={{ backgroundColor: form.displayColor }}
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
          {/* 유형 필터 */}
          <div>
            <label className="block text-xs font-semibold text-gray-500 mb-1">
              유형
            </label>
            <select
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value)}
              className="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm bg-white outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="">전체</option>
              {typeLookups.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.label}
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
                placeholder="코드 또는 이름으로 검색"
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
          비활성 항목 포함
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
                    코드
                  </th>
                  <th className="text-left text-xs font-semibold text-gray-500 px-5 py-3">
                    이름
                  </th>
                  <th className="text-left text-xs font-semibold text-gray-500 px-5 py-3">
                    유형
                  </th>
                  <th className="text-center text-xs font-semibold text-gray-500 px-5 py-3">
                    연차차감
                  </th>
                  <th className="text-center text-xs font-semibold text-gray-500 px-5 py-3">
                    결재
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
                {categories.length === 0 ? (
                  <tr>
                    <td
                      colSpan={9}
                      className="px-5 py-12 text-center text-sm text-gray-400"
                    >
                      데이터가 없습니다
                    </td>
                  </tr>
                ) : (
                  categories.map((c) => (
                    <tr
                      key={c.id}
                      className={`border-b border-gray-50 hover:bg-blue-50/30 group ${
                        !c.isActive ? "opacity-40" : ""
                      }`}
                    >
                      <td className="px-5 py-3 text-sm text-gray-900 font-mono">
                        {c.code}
                      </td>
                      <td className="px-5 py-3 text-sm font-semibold text-gray-900">
                        <div className="flex items-center gap-2">
                          {c.name}
                          {c.isSystem && (
                            <span
                              title="시스템 항목 (삭제 불가)"
                              className="text-gray-400"
                            >
                              <Shield size={12} />
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-5 py-3 text-sm text-gray-500">
                        <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-600">
                          {getTypeLabel(c.type)}
                        </span>
                      </td>
                      <td className="px-5 py-3 text-center text-sm text-gray-500">
                        {c.annualLeaveDeduct === null
                          ? "-"
                          : c.annualLeaveDeduct === 0
                          ? "0"
                          : `${c.annualLeaveDeduct}일`}
                      </td>
                      <td className="px-5 py-3 text-center">
                        {c.requireApproval ? (
                          <span className="text-xs text-blue-600">필요</span>
                        ) : (
                          <span className="text-xs text-gray-400">자동</span>
                        )}
                      </td>
                      <td className="px-5 py-3 text-center">
                        {c.displayColor ? (
                          <div className="flex items-center justify-center gap-2">
                            {c.displayColor.startsWith("#") && (
                              <div
                                className="w-5 h-5 rounded-full border border-gray-200"
                                style={{ backgroundColor: c.displayColor }}
                              />
                            )}
                            <span className="text-xs font-mono text-gray-500">
                              {c.displayColor}
                            </span>
                          </div>
                        ) : (
                          <span className="text-xs text-gray-300">-</span>
                        )}
                      </td>
                      <td className="px-5 py-3 text-center text-sm text-gray-500">
                        {c.sortOrder}
                      </td>
                      <td className="px-5 py-3 text-center">
                        <button
                          onClick={() => handleToggleActive(c)}
                          className={`text-xs font-semibold px-2 py-0.5 rounded-full hover:opacity-80 ${
                            c.isActive
                              ? "text-emerald-700 bg-emerald-50"
                              : "text-gray-400 bg-gray-100"
                          }`}
                          title="클릭하여 활성/비활성 토글"
                        >
                          {c.isActive ? "활성" : "비활성"}
                        </button>
                      </td>
                      <td className="px-5 py-3">
                        <div className="flex justify-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                          <button
                            onClick={() => openEdit(c)}
                            className="p-1.5 rounded-lg hover:bg-blue-100 text-gray-400 hover:text-blue-600"
                          >
                            <Edit size={15} />
                          </button>
                          <button
                            onClick={() => handleDelete(c)}
                            disabled={c.isSystem}
                            className="p-1.5 rounded-lg hover:bg-rose-100 text-gray-400 hover:text-rose-600 disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent"
                            title={
                              c.isSystem
                                ? "시스템 항목은 삭제할 수 없습니다"
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
            {categories.map((c) => (
              <div
                key={c.id}
                className={`px-4 py-3 space-y-1 ${
                  !c.isActive ? "opacity-40" : ""
                }`}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    {c.displayColor?.startsWith("#") && (
                      <div
                        className="w-4 h-4 rounded-full border border-gray-200"
                        style={{ backgroundColor: c.displayColor }}
                      />
                    )}
                    <span className="text-sm font-semibold text-gray-900">
                      {c.name}
                    </span>
                    {c.isSystem && (
                      <span className="text-gray-400">
                        <Shield size={12} />
                      </span>
                    )}
                  </div>
                  <div className="flex gap-1">
                    <button
                      onClick={() => openEdit(c)}
                      className="p-1.5 rounded-lg hover:bg-blue-50 text-gray-400 hover:text-blue-600"
                    >
                      <Edit size={14} />
                    </button>
                    <button
                      onClick={() => handleDelete(c)}
                      disabled={c.isSystem}
                      className="p-1.5 rounded-lg hover:bg-rose-50 text-gray-400 hover:text-rose-600 disabled:opacity-30"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
                <p className="text-xs text-gray-400">
                  {c.code} · {getTypeLabel(c.type)}
                  {c.annualLeaveDeduct !== null &&
                    ` · 차감 ${c.annualLeaveDeduct}일`}
                </p>
              </div>
            ))}
          </div>

          <div className="px-5 py-3 border-t border-gray-100 bg-gray-50">
            <p className="text-xs font-semibold text-gray-700">
              총 {categories.length}건
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

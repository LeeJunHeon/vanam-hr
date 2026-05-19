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
  Building2,
} from "lucide-react";
import { exportCSV } from "@/lib/csvUtils";

interface Department {
  id: number;
  code: string;
  name: string;
  parentId: number | null;
  parentCode: string | null;
  parentName: string | null;
  sortOrder: number;
  isActive: boolean;
}

const EMPTY_FORM = {
  code: "",
  name: "",
  parentId: "" as string, // "" or "1" — number 변환은 저장 시점
  sortOrder: 0,
};

export default function DepartmentsSection() {
  const [departments, setDepartments] = useState<Department[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [includeInactive, setIncludeInactive] = useState(false);

  const [showForm, setShowForm] = useState(false);
  const [editTarget, setEditTarget] = useState<Department | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");
  const [toast, setToast] = useState("");

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(""), 2500);
  };

  const fetchDepartments = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (search) params.set("search", search);
      if (includeInactive) params.set("includeInactive", "true");

      const res = await fetch(`/api/departments?${params}`);
      if (res.ok) setDepartments(await res.json());
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, [search, includeInactive]);

  useEffect(() => {
    const t = setTimeout(fetchDepartments, 300);
    return () => clearTimeout(t);
  }, [fetchDepartments]);

  // 부모 select 옵션: 활성 부서 중 자기 자신 제외
  const parentOptions = useMemo(() => {
    return departments.filter(
      (d) => d.isActive && (!editTarget || d.id !== editTarget.id)
    );
  }, [departments, editTarget]);

  const openCreate = () => {
    setEditTarget(null);
    setForm(EMPTY_FORM);
    setFormError("");
    setShowForm(true);
  };

  const openEdit = (d: Department) => {
    setEditTarget(d);
    setForm({
      code: d.code,
      name: d.name,
      parentId: d.parentId === null ? "" : String(d.parentId),
      sortOrder: d.sortOrder,
    });
    setFormError("");
    setShowForm(true);
  };

  const handleSave = async () => {
    if (editTarget === null) {
      if (!form.code.trim() || !form.name.trim()) {
        setFormError("코드, 이름은 필수입니다.");
        return;
      }
    } else {
      if (!form.name.trim()) {
        setFormError("이름은 필수입니다.");
        return;
      }
    }

    // 자기 자신을 parent로 차단 (2차 방어)
    if (
      editTarget &&
      form.parentId !== "" &&
      Number(form.parentId) === editTarget.id
    ) {
      setFormError("자기 자신을 상위 부서로 설정할 수 없습니다.");
      return;
    }

    setFormError("");
    setSaving(true);
    try {
      const url = editTarget
        ? `/api/departments?id=${editTarget.id}`
        : "/api/departments";
      const method = editTarget ? "PUT" : "POST";

      const payload: any = {
        name: form.name.trim(),
        parentId: form.parentId === "" ? null : Number(form.parentId),
        sortOrder: Number(form.sortOrder) || 0,
      };
      if (!editTarget) {
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
      fetchDepartments();
    } catch {
      setFormError("네트워크 오류");
    } finally {
      setSaving(false);
    }
  };

  const handleToggleActive = async (d: Department) => {
    try {
      const res = await fetch(`/api/departments?id=${d.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: !d.isActive }),
      });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || "변경 실패");
        return;
      }
      showToast(`✅ ${d.isActive ? "비활성" : "활성"} 처리됨`);
      fetchDepartments();
    } catch {
      alert("네트워크 오류");
    }
  };

  const handleDelete = async (d: Department) => {
    if (!confirm(`"${d.name}" 부서를 삭제하시겠습니까?`)) return;
    try {
      const res = await fetch(`/api/departments?id=${d.id}`, {
        method: "DELETE",
      });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || "삭제 실패");
        return;
      }
      showToast("✅ 삭제되었습니다");
      fetchDepartments();
    } catch {
      alert("네트워크 오류");
    }
  };

  const handleExportCSV = () => {
    if (!departments || departments.length === 0) return;
    exportCSV(
      ["코드", "이름", "상위부서코드", "상위부서명", "정렬", "활성"],
      departments.map((d) => [
        d.code,
        d.name,
        d.parentCode ?? "",
        d.parentName ?? "",
        d.sortOrder,
        d.isActive ? "Y" : "N",
      ]),
      `부서_${new Date().toISOString().split("T")[0]}.csv`
    );
  };

  return (
    <div className="space-y-5">
      {/* 토스트 */}
      {toast && (
        <div className="fixed bottom-6 right-6 z-50 bg-gray-900 text-white text-sm font-medium px-5 py-3 rounded-xl shadow-lg">
          {toast}
        </div>
      )}

      {/* 액션 */}
      <div className="flex items-center justify-end gap-2">
        <button
          onClick={handleExportCSV}
          disabled={!departments || departments.length === 0}
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
          부서 추가
        </button>
      </div>

      {/* 등록 / 수정 폼 */}
      {showForm && (
        <div className="bg-blue-50 border border-blue-200 rounded-2xl p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="font-bold text-blue-900">
              {editTarget ? "부서 수정" : "부서 추가"}
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
                placeholder="예: DEV"
                disabled={!!editTarget}
                maxLength={50}
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
                placeholder="예: 개발팀"
                maxLength={100}
                className="w-full px-3 py-2.5 border border-blue-200 rounded-xl text-sm bg-white outline-none focus:ring-2 focus:ring-blue-400"
              />
            </div>

            {/* 상위 부서 */}
            <div>
              <label className="block text-xs font-semibold text-blue-700 mb-1">
                상위 부서
              </label>
              <select
                value={form.parentId}
                onChange={(e) =>
                  setForm((f) => ({ ...f, parentId: e.target.value }))
                }
                className="w-full px-3 py-2.5 border border-blue-200 rounded-xl text-sm bg-white outline-none focus:ring-2 focus:ring-blue-400"
              >
                <option value="">(최상위)</option>
                {parentOptions.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name} ({d.code})
                  </option>
                ))}
              </select>
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
            placeholder="코드 또는 이름으로 검색"
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
          비활성 부서 포함
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
                    상위 부서
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
                {departments.length === 0 ? (
                  <tr>
                    <td
                      colSpan={6}
                      className="px-5 py-12 text-center text-sm text-gray-400"
                    >
                      등록된 부서가 없습니다
                    </td>
                  </tr>
                ) : (
                  departments.map((d) => (
                    <tr
                      key={d.id}
                      className={`border-b border-gray-50 hover:bg-blue-50/30 group ${
                        !d.isActive ? "opacity-40" : ""
                      }`}
                    >
                      <td className="px-5 py-3 text-sm text-gray-900 font-mono">
                        {d.code}
                      </td>
                      <td className="px-5 py-3 text-sm font-semibold text-gray-900">
                        <div className="flex items-center gap-2">
                          <Building2 size={14} className="text-gray-400" />
                          {d.name}
                        </div>
                      </td>
                      <td className="px-5 py-3 text-sm text-gray-500">
                        {d.parentName ? (
                          <span>
                            {d.parentName}
                            <span className="text-xs text-gray-400 ml-1 font-mono">
                              ({d.parentCode})
                            </span>
                          </span>
                        ) : (
                          <span className="text-xs text-gray-300">(최상위)</span>
                        )}
                      </td>
                      <td className="px-5 py-3 text-center text-sm text-gray-500">
                        {d.sortOrder}
                      </td>
                      <td className="px-5 py-3 text-center">
                        <button
                          onClick={() => handleToggleActive(d)}
                          className={`text-xs font-semibold px-2 py-0.5 rounded-full hover:opacity-80 ${
                            d.isActive
                              ? "text-emerald-700 bg-emerald-50"
                              : "text-gray-400 bg-gray-100"
                          }`}
                        >
                          {d.isActive ? "활성" : "비활성"}
                        </button>
                      </td>
                      <td className="px-5 py-3">
                        <div className="flex justify-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                          <button
                            onClick={() => openEdit(d)}
                            className="p-1.5 rounded-lg hover:bg-blue-100 text-gray-400 hover:text-blue-600"
                          >
                            <Edit size={15} />
                          </button>
                          <button
                            onClick={() => handleDelete(d)}
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
            {departments.length === 0 ? (
              <div className="px-4 py-12 text-center text-sm text-gray-400">
                등록된 부서가 없습니다
              </div>
            ) : (
              departments.map((d) => (
                <div
                  key={d.id}
                  className={`px-4 py-3 space-y-1 ${
                    !d.isActive ? "opacity-40" : ""
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 min-w-0">
                      <Building2 size={14} className="text-gray-400 shrink-0" />
                      <span className="text-sm font-semibold text-gray-900 truncate">
                        {d.name}
                      </span>
                    </div>
                    <div className="flex gap-1 shrink-0">
                      <button
                        onClick={() => openEdit(d)}
                        className="p-1.5 rounded-lg hover:bg-blue-50 text-gray-400 hover:text-blue-600"
                      >
                        <Edit size={14} />
                      </button>
                      <button
                        onClick={() => handleDelete(d)}
                        className="p-1.5 rounded-lg hover:bg-rose-50 text-gray-400 hover:text-rose-600"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                  <p className="text-xs text-gray-400 font-mono">
                    {d.code}
                    {d.parentName && ` · 상위: ${d.parentName}`}
                  </p>
                </div>
              ))
            )}
          </div>

          {departments.length > 0 && (
            <div className="px-5 py-3 border-t border-gray-100 bg-gray-50">
              <p className="text-xs font-semibold text-gray-700">
                총 {departments.length}건
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

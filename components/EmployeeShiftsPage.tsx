"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Plus,
  Edit,
  Trash2,
  Loader2,
  X,
  Clock,
  User,
  AlertCircle,
} from "lucide-react";
import DatePicker from "@/components/DatePicker";
import { todayYmd } from "@/lib/dateUtils";

interface Assignment {
  id: number;
  employeeId: number;
  employeeNo: string | null;
  employeeName: string;
  departmentName: string | null;
  patternId: number;
  patternName: string;
  patternDescription: string | null;
  patternIsActive: boolean;
  startDate: string;
  endDate: string | null;
}

interface EmployeeOption {
  id: number;
  employeeNo: string | null;
  name: string;
  departmentName: string | null;
}

interface PatternOption {
  id: number;
  name: string;
  description: string | null;
  cycleDays: number;
}


const EMPTY_FORM = {
  employeeId: "",
  patternId: "",
  startDate: todayYmd(),
  endDate: "",
};

export default function EmployeeShiftsPage() {
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [employees, setEmployees] = useState<EmployeeOption[]>([]);
  const [patterns, setPatterns] = useState<PatternOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeOnly, setActiveOnly] = useState(true);

  const [showForm, setShowForm] = useState(false);
  const [editTarget, setEditTarget] = useState<Assignment | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");
  const [toast, setToast] = useState("");

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(""), 2500);
  };

  // 마스터 로드 (직원 + 시프트 패턴)
  useEffect(() => {
    (async () => {
      try {
        const [empRes, patRes] = await Promise.all([
          fetch("/api/employees?includeInactive=false"),
          fetch("/api/shifts?includeInactive=false"),
        ]);
        if (empRes.ok) {
          const data = await empRes.json();
          setEmployees(
            data.map((e: {
              id: number;
              employeeNo: string | null;
              name: string;
              departmentName: string | null;
            }) => ({
              id: e.id,
              employeeNo: e.employeeNo,
              name: e.name,
              departmentName: e.departmentName,
            }))
          );
        }
        if (patRes.ok) setPatterns(await patRes.json());
      } catch (e) {
        console.error("masters fetch error:", e);
      }
    })();
  }, []);

  const fetchAssignments = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (activeOnly) params.set("activeOnly", "true");
      const res = await fetch(`/api/employee-shifts?${params}`);
      if (res.ok) setAssignments(await res.json());
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, [activeOnly]);

  useEffect(() => {
    fetchAssignments();
  }, [fetchAssignments]);

  const openCreate = () => {
    setEditTarget(null);
    setForm({ ...EMPTY_FORM, startDate: todayYmd() });
    setFormError("");
    setShowForm(true);
  };

  const openEdit = (a: Assignment) => {
    setEditTarget(a);
    setForm({
      employeeId: String(a.employeeId),
      patternId: String(a.patternId),
      startDate: a.startDate,
      endDate: a.endDate ?? "",
    });
    setFormError("");
    setShowForm(true);
  };

  const handleSave = async () => {
    if (!form.employeeId || !form.patternId || !form.startDate) {
      setFormError("직원, 시프트 패턴, 시작일은 필수입니다.");
      return;
    }
    if (form.endDate && form.endDate < form.startDate) {
      setFormError("종료일은 시작일 이후여야 합니다.");
      return;
    }

    setFormError("");
    setSaving(true);
    try {
      const url = editTarget
        ? `/api/employee-shifts?id=${editTarget.id}`
        : "/api/employee-shifts";
      const method = editTarget ? "PUT" : "POST";

      // POST는 employeeId 포함, PUT은 employeeId 변경 불가 (스키마상)
      const payload = editTarget
        ? {
            patternId: Number(form.patternId),
            startDate: form.startDate,
            endDate: form.endDate || null,
          }
        : {
            employeeId: Number(form.employeeId),
            patternId: Number(form.patternId),
            startDate: form.startDate,
            endDate: form.endDate || null,
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
      fetchAssignments();
    } catch {
      setFormError("네트워크 오류");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (a: Assignment) => {
    if (
      !confirm(
        `"${a.employeeName}"의 "${a.patternName}" 시프트 배정을 삭제하시겠습니까?`
      )
    )
      return;
    try {
      const res = await fetch(`/api/employee-shifts?id=${a.id}`, {
        method: "DELETE",
      });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || "삭제 실패");
        return;
      }
      showToast("✅ 삭제되었습니다");
      fetchAssignments();
    } catch {
      alert("네트워크 오류");
    }
  };

  // 시프트 미배정 직원 목록 (활성 직원 중 현재 시프트가 없는 직원)
  const unassignedEmployees = employees.filter(
    (e) => !assignments.some((a) => a.employeeId === e.id)
  );

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
            직원별 시프트
          </h1>
          <p className="text-sm text-gray-500 mt-0.5">
            직원에게 시프트 패턴을 배정합니다 (지각/조퇴 판정 기준)
          </p>
        </div>
        <button
          onClick={openCreate}
          disabled={patterns.length === 0 || employees.length === 0}
          className="flex items-center gap-2 px-4 py-2.5 text-sm font-bold text-white bg-blue-500 rounded-xl hover:bg-blue-600 shadow-sm disabled:opacity-50 disabled:cursor-not-allowed"
          title={
            patterns.length === 0
              ? "먼저 시프트 패턴을 만드세요"
              : employees.length === 0
              ? "활성 직원이 없습니다"
              : ""
          }
        >
          <Plus size={16} />
          배정 추가
        </button>
      </div>

      {/* 미배정 직원 안내 */}
      {unassignedEmployees.length > 0 && !loading && (
        <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4 flex items-start gap-2.5">
          <AlertCircle size={16} className="text-amber-500 shrink-0 mt-0.5" />
          <div className="flex-1">
            <p className="text-xs font-semibold text-amber-800 mb-1">
              시프트 미배정 직원 {unassignedEmployees.length}명
            </p>
            <p className="text-xs text-amber-700 leading-relaxed">
              시프트가 배정되지 않은 직원은 지각/조퇴 판정 없이 단순 &apos;normal&apos; /
              &apos;absent&apos; 로 처리됩니다.
            </p>
            <p className="text-[11px] text-amber-600 mt-2">
              {unassignedEmployees
                .slice(0, 5)
                .map((e) => e.name)
                .join(", ")}
              {unassignedEmployees.length > 5 &&
                ` 외 ${unassignedEmployees.length - 5}명`}
            </p>
          </div>
        </div>
      )}

      {/* 등록 / 수정 폼 */}
      {showForm && (
        <div className="bg-blue-50 border border-blue-200 rounded-2xl p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="font-bold text-blue-900">
              {editTarget ? "배정 수정" : "배정 추가"}
            </h2>
            <button
              onClick={() => setShowForm(false)}
              className="text-blue-400 hover:text-blue-700"
            >
              <X size={18} />
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {/* 직원 */}
            <div className="sm:col-span-2">
              <label className="block text-xs font-semibold text-blue-700 mb-1">
                직원 <span className="text-rose-500">*</span>
              </label>
              <select
                value={form.employeeId}
                onChange={(e) =>
                  setForm((f) => ({ ...f, employeeId: e.target.value }))
                }
                disabled={!!editTarget}
                className="w-full px-3 py-2.5 border border-blue-200 rounded-xl text-sm bg-white outline-none focus:ring-2 focus:ring-blue-400 disabled:bg-gray-100 disabled:text-gray-700"
              >
                <option value="">(직원 선택)</option>
                {employees.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}
                    {e.employeeNo && ` (${e.employeeNo})`}
                    {e.departmentName && ` · ${e.departmentName}`}
                  </option>
                ))}
              </select>
              {editTarget && (
                <p className="text-[10px] text-gray-500 mt-1">
                  직원 변경 불가. 새 직원에게 배정하려면 추가 버튼을 사용하세요.
                </p>
              )}
            </div>

            {/* 시프트 패턴 */}
            <div className="sm:col-span-2">
              <label className="block text-xs font-semibold text-blue-700 mb-1">
                시프트 패턴 <span className="text-rose-500">*</span>
              </label>
              <select
                value={form.patternId}
                onChange={(e) =>
                  setForm((f) => ({ ...f, patternId: e.target.value }))
                }
                className="w-full px-3 py-2.5 border border-blue-200 rounded-xl text-sm bg-white outline-none focus:ring-2 focus:ring-blue-400"
              >
                <option value="">(시프트 선택)</option>
                {patterns.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.cycleDays}일 사이클)
                    {p.description && ` · ${p.description}`}
                  </option>
                ))}
              </select>
            </div>

            {/* 시작일 */}
            <div>
              <label className="block text-xs font-semibold text-blue-700 mb-1">
                시작일 <span className="text-rose-500">*</span>
              </label>
              <DatePicker
                value={form.startDate}
                placeholder="시작일 선택"
                onChange={(val) => setForm((f) => ({ ...f, startDate: val }))}
              />
              <p className="text-[10px] text-gray-500 mt-1">
                시프트 사이클의 첫 날 (dayIndex 0 시작 기준일)
              </p>
            </div>

            {/* 종료일 */}
            <div>
              <label className="block text-xs font-semibold text-blue-700 mb-1">
                종료일
              </label>
              <DatePicker
                value={form.endDate}
                min={form.startDate || undefined}
                placeholder="종료일 선택"
                onChange={(val) => setForm((f) => ({ ...f, endDate: val }))}
              />
              <p className="text-[10px] text-gray-500 mt-1">
                비우면 무기한 (현재 시프트)
              </p>
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
      <div className="bg-white rounded-2xl border border-gray-100 p-3 sm:p-4">
        <label className="flex items-center gap-2 text-sm text-gray-600 cursor-pointer w-fit">
          <input
            type="checkbox"
            checked={activeOnly}
            onChange={(e) => setActiveOnly(e.target.checked)}
            className="rounded"
          />
          현재 활성 배정만 (오늘 기준)
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
          {/* 데스크탑 테이블 */}
          <div className="hidden md:block overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-100">
                  <th className="text-left text-xs font-semibold text-gray-500 px-5 py-3">
                    직원
                  </th>
                  <th className="text-left text-xs font-semibold text-gray-500 px-5 py-3">
                    부서
                  </th>
                  <th className="text-left text-xs font-semibold text-gray-500 px-5 py-3">
                    시프트 패턴
                  </th>
                  <th className="text-left text-xs font-semibold text-gray-500 px-5 py-3">
                    시작일
                  </th>
                  <th className="text-left text-xs font-semibold text-gray-500 px-5 py-3">
                    종료일
                  </th>
                  <th className="text-center text-xs font-semibold text-gray-500 px-5 py-3">
                    작업
                  </th>
                </tr>
              </thead>
              <tbody>
                {assignments.length === 0 ? (
                  <tr>
                    <td
                      colSpan={6}
                      className="px-5 py-12 text-center text-sm text-gray-400"
                    >
                      등록된 시프트 배정이 없습니다
                    </td>
                  </tr>
                ) : (
                  assignments.map((a) => (
                    <tr
                      key={a.id}
                      className="border-b border-gray-50 hover:bg-blue-50/30 group"
                    >
                      <td className="px-5 py-3 text-sm font-semibold text-gray-900">
                        <div className="flex items-center gap-2">
                          <User size={14} className="text-gray-400" />
                          {a.employeeName}
                          {a.employeeNo && (
                            <span className="text-xs text-gray-400 font-mono">
                              ({a.employeeNo})
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-5 py-3 text-sm text-gray-500">
                        {a.departmentName ?? "-"}
                      </td>
                      <td className="px-5 py-3 text-sm text-gray-900">
                        <div className="flex items-center gap-2">
                          <Clock size={14} className="text-gray-400" />
                          {a.patternName}
                          {!a.patternIsActive && (
                            <span className="text-[10px] text-rose-600 bg-rose-50 px-1.5 py-0.5 rounded">
                              비활성 패턴
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-5 py-3 text-sm text-gray-500 font-mono">
                        {a.startDate}
                      </td>
                      <td className="px-5 py-3 text-sm text-gray-500 font-mono">
                        {a.endDate ?? (
                          <span className="text-xs text-emerald-600">진행 중</span>
                        )}
                      </td>
                      <td className="px-5 py-3">
                        <div className="flex justify-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                          <button
                            onClick={() => openEdit(a)}
                            className="p-1.5 rounded-lg hover:bg-blue-100 text-gray-400 hover:text-blue-600"
                          >
                            <Edit size={15} />
                          </button>
                          <button
                            onClick={() => handleDelete(a)}
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
            {assignments.length === 0 ? (
              <div className="px-4 py-12 text-center text-sm text-gray-400">
                등록된 시프트 배정이 없습니다
              </div>
            ) : (
              assignments.map((a) => (
                <div key={a.id} className="px-4 py-3 space-y-1">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 min-w-0">
                      <User size={14} className="text-gray-400 shrink-0" />
                      <span className="text-sm font-semibold text-gray-900 truncate">
                        {a.employeeName}
                      </span>
                      {a.employeeNo && (
                        <span className="text-xs text-gray-400 font-mono shrink-0">
                          ({a.employeeNo})
                        </span>
                      )}
                    </div>
                    <div className="flex gap-1 shrink-0">
                      <button
                        onClick={() => openEdit(a)}
                        className="p-1.5 rounded-lg hover:bg-blue-50 text-gray-400 hover:text-blue-600"
                      >
                        <Edit size={14} />
                      </button>
                      <button
                        onClick={() => handleDelete(a)}
                        className="p-1.5 rounded-lg hover:bg-rose-50 text-gray-400 hover:text-rose-600"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                  <p className="text-xs text-gray-500">
                    <Clock
                      size={11}
                      className="inline -translate-y-px mr-1 text-gray-400"
                    />
                    {a.patternName}
                    {a.departmentName && ` · ${a.departmentName}`}
                  </p>
                  <p className="text-[11px] text-gray-400 font-mono">
                    {a.startDate} ~ {a.endDate ?? "진행 중"}
                  </p>
                </div>
              ))
            )}
          </div>

          {assignments.length > 0 && (
            <div className="px-5 py-3 border-t border-gray-100 bg-gray-50">
              <p className="text-xs font-semibold text-gray-700">
                총 {assignments.length}건
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

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
  Users,
  Clock,
  ArrowRight,
} from "lucide-react";
import { exportCSV } from "@/lib/csvUtils";
import { todayYmd } from "@/lib/dateUtils";

interface ApprovalLine {
  id: number;
  departmentId: number;
  departmentCode: string;
  departmentName: string;
  primaryApproverId: number;
  primaryApproverNo: string;
  primaryApproverName: string;
  deputyApproverId: number | null;
  deputyApproverNo: string | null;
  deputyApproverName: string | null;
  autoDelegateHours: number;
}

interface DeptOption {
  id: number;
  code: string;
  name: string;
}

interface EmpOption {
  id: number;
  employeeNo: string;
  name: string;
  departmentName: string | null;
}

const EMPTY_FORM = {
  departmentId: "" as "" | string,
  primaryApproverId: "" as "" | string,
  deputyApproverId: "" as "" | string,
  autoDelegateHours: "24",
};

export default function ApprovalLinesPage() {
  const [lines, setLines] = useState<ApprovalLine[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");

  // 외부 참조
  const [availableDepartments, setAvailableDepartments] = useState<DeptOption[]>(
    []
  );
  const [employees, setEmployees] = useState<EmpOption[]>([]);

  const [showForm, setShowForm] = useState(false);
  const [editTarget, setEditTarget] = useState<ApprovalLine | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");
  const [toast, setToast] = useState("");

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(""), 2500);
  };

  // 직원 1회 로드
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/employees?includeInactive=false");
        if (res.ok) {
          const data = await res.json();
          setEmployees(
            data.map((e: any) => ({
              id: e.id,
              employeeNo: e.employeeNo,
              name: e.name,
              departmentName: e.departmentName,
            }))
          );
        }
      } catch (e) {
        console.error("employees fetch error:", e);
      }
    })();
  }, []);

  const fetchLines = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (search) params.set("search", search);

      const res = await fetch(`/api/approval-lines?${params}`);
      if (res.ok) setLines(await res.json());
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, [search]);

  useEffect(() => {
    const t = setTimeout(fetchLines, 300);
    return () => clearTimeout(t);
  }, [fetchLines]);

  const loadAvailableDepartments = useCallback(async () => {
    try {
      const res = await fetch("/api/approval-lines/available-departments");
      if (res.ok) setAvailableDepartments(await res.json());
    } catch (e) {
      console.error("available departments fetch error:", e);
      setAvailableDepartments([]);
    }
  }, []);

  // 폼이 닫혔거나 lines 변경 후 가용 부서 재계산
  useEffect(() => {
    loadAvailableDepartments();
  }, [lines, loadAvailableDepartments]);

  const openCreate = () => {
    setEditTarget(null);
    setForm(EMPTY_FORM);
    setFormError("");
    setShowForm(true);
    loadAvailableDepartments();
  };

  const openEdit = (l: ApprovalLine) => {
    setEditTarget(l);
    setForm({
      departmentId: String(l.departmentId),
      primaryApproverId: String(l.primaryApproverId),
      deputyApproverId: l.deputyApproverId === null ? "" : String(l.deputyApproverId),
      autoDelegateHours: String(l.autoDelegateHours),
    });
    setFormError("");
    setShowForm(true);
  };

  // 대리 결재자 select 옵션 (메인 제외)
  const deputyOptions = useMemo(() => {
    const primaryId = Number(form.primaryApproverId);
    return employees.filter((e) => e.id !== primaryId);
  }, [employees, form.primaryApproverId]);

  const handleSave = async () => {
    if (!editTarget && !form.departmentId) {
      setFormError("부서를 선택하세요.");
      return;
    }
    if (!form.primaryApproverId) {
      setFormError("메인 결재자를 선택하세요.");
      return;
    }
    if (
      form.deputyApproverId !== "" &&
      Number(form.deputyApproverId) === Number(form.primaryApproverId)
    ) {
      setFormError("메인과 대리 결재자는 같을 수 없습니다.");
      return;
    }
    const hours = Number(form.autoDelegateHours);
    if (!Number.isInteger(hours) || hours < 1) {
      setFormError("자동 위임 시간은 1 이상 정수여야 합니다.");
      return;
    }

    setFormError("");
    setSaving(true);
    try {
      const url = editTarget
        ? `/api/approval-lines?id=${editTarget.id}`
        : "/api/approval-lines";
      const method = editTarget ? "PUT" : "POST";

      const payload: any = {
        primaryApproverId: Number(form.primaryApproverId),
        deputyApproverId:
          form.deputyApproverId === "" ? null : Number(form.deputyApproverId),
        autoDelegateHours: hours,
      };
      if (!editTarget) {
        payload.departmentId = Number(form.departmentId);
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
      fetchLines();
    } catch {
      setFormError("네트워크 오류");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (l: ApprovalLine) => {
    if (
      !confirm(
        `"${l.departmentName}" 부서의 결재선을 삭제하시겠습니까?\n진행 중인 결재 요청에는 영향이 없습니다.`
      )
    )
      return;
    try {
      const res = await fetch(`/api/approval-lines?id=${l.id}`, {
        method: "DELETE",
      });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || "삭제 실패");
        return;
      }
      showToast("✅ 삭제되었습니다");
      fetchLines();
    } catch {
      alert("네트워크 오류");
    }
  };

  const handleExportCSV = () => {
    if (!lines || lines.length === 0) return;
    exportCSV(
      [
        "부서코드",
        "부서명",
        "메인결재자사번",
        "메인결재자명",
        "대리결재자사번",
        "대리결재자명",
        "자동위임시간",
      ],
      lines.map((l) => [
        l.departmentCode,
        l.departmentName,
        l.primaryApproverNo,
        l.primaryApproverName,
        l.deputyApproverNo ?? "",
        l.deputyApproverName ?? "",
        l.autoDelegateHours,
      ]),
      `결재선_${todayYmd()}.csv`
    );
  };

  const canAdd = availableDepartments.length > 0;

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
            결재선 설정
          </h1>
          <p className="text-sm text-gray-500 mt-0.5">
            부서별 메인/대리 결재자와 자동 위임 시간을 관리합니다 (부서당 1개)
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleExportCSV}
            disabled={!lines || lines.length === 0}
            className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium bg-white border border-gray-200 text-gray-600 rounded-xl hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            <Download size={15} />
            CSV
          </button>
          <button
            onClick={openCreate}
            disabled={!canAdd || employees.length === 0}
            className="flex items-center gap-2 px-4 py-2.5 text-sm font-bold text-white bg-blue-500 rounded-xl hover:bg-blue-600 shadow-sm disabled:opacity-50 disabled:cursor-not-allowed"
            title={
              employees.length === 0
                ? "먼저 직원을 등록하세요"
                : !canAdd
                ? "모든 활성 부서에 결재선이 등록되어 있습니다"
                : ""
            }
          >
            <Plus size={16} />
            결재선 추가
          </button>
        </div>
      </div>

      {/* 등록 / 수정 폼 */}
      {showForm && (
        <div className="bg-blue-50 border border-blue-200 rounded-2xl p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="font-bold text-blue-900">
              {editTarget ? "결재선 수정" : "결재선 추가"}
            </h2>
            <button
              onClick={() => setShowForm(false)}
              className="text-blue-400 hover:text-blue-700"
            >
              <X size={18} />
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {/* 부서 */}
            <div>
              <label className="block text-xs font-semibold text-blue-700 mb-1">
                부서 <span className="text-rose-500">*</span>
              </label>
              {editTarget ? (
                <input
                  disabled
                  value={`${editTarget.departmentName} (${editTarget.departmentCode})`}
                  className="w-full px-3 py-2.5 border border-blue-200 rounded-xl text-sm bg-gray-100 text-gray-500 outline-none"
                />
              ) : (
                <select
                  value={form.departmentId}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, departmentId: e.target.value }))
                  }
                  disabled={availableDepartments.length === 0}
                  className="w-full px-3 py-2.5 border border-blue-200 rounded-xl text-sm bg-white outline-none focus:ring-2 focus:ring-blue-400 disabled:bg-gray-100 disabled:text-gray-400"
                >
                  <option value="">(선택)</option>
                  {availableDepartments.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name} ({d.code})
                    </option>
                  ))}
                </select>
              )}
              {editTarget && (
                <p className="text-[10px] text-gray-400 mt-1">
                  부서 변경 불가 — 옮기려면 삭제 후 재생성
                </p>
              )}
            </div>

            {/* 메인 결재자 */}
            <div>
              <label className="block text-xs font-semibold text-blue-700 mb-1">
                메인 결재자 <span className="text-rose-500">*</span>
              </label>
              <select
                value={form.primaryApproverId}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    primaryApproverId: e.target.value,
                    // 메인이 대리와 같아지면 대리 해제
                    deputyApproverId:
                      e.target.value === f.deputyApproverId
                        ? ""
                        : f.deputyApproverId,
                  }))
                }
                className="w-full px-3 py-2.5 border border-blue-200 rounded-xl text-sm bg-white outline-none focus:ring-2 focus:ring-blue-400"
              >
                <option value="">(선택)</option>
                {employees.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name} ({e.employeeNo}) -{" "}
                    {e.departmentName ?? "부서 미지정"}
                  </option>
                ))}
              </select>
            </div>

            {/* 대리 결재자 */}
            <div>
              <label className="block text-xs font-semibold text-blue-700 mb-1">
                대리 결재자
              </label>
              <select
                value={form.deputyApproverId}
                onChange={(e) =>
                  setForm((f) => ({ ...f, deputyApproverId: e.target.value }))
                }
                className="w-full px-3 py-2.5 border border-blue-200 rounded-xl text-sm bg-white outline-none focus:ring-2 focus:ring-blue-400"
              >
                <option value="">(없음)</option>
                {deputyOptions.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name} ({e.employeeNo}) -{" "}
                    {e.departmentName ?? "부서 미지정"}
                  </option>
                ))}
              </select>
            </div>

            {/* 자동 위임 시간 */}
            <div>
              <label className="block text-xs font-semibold text-blue-700 mb-1">
                자동 위임 시간 (시간)
              </label>
              <input
                type="number"
                min="1"
                value={form.autoDelegateHours}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    autoDelegateHours: e.target.value,
                  }))
                }
                className="w-full px-3 py-2.5 border border-blue-200 rounded-xl text-sm bg-white outline-none focus:ring-2 focus:ring-blue-400"
              />
              <p className="text-[10px] text-gray-500 mt-1">
                메인 결재자가 N시간 무응답 시 대리에게 자동 위임됩니다
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

      {/* 검색 */}
      <div className="bg-white rounded-2xl border border-gray-100 p-3 sm:p-4">
        <div className="relative">
          <Search
            size={16}
            className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-400"
          />
          <input
            type="text"
            placeholder="부서명 또는 메인 결재자명으로 검색"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-10 pr-4 py-2.5 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-blue-500 outline-none"
          />
        </div>
      </div>

      {/* 카드 리스트 */}
      {loading ? (
        <div className="flex items-center justify-center h-32">
          <Loader2 size={24} className="animate-spin text-blue-500" />
          <span className="ml-2 text-sm text-gray-500">로딩 중...</span>
        </div>
      ) : lines.length === 0 ? (
        <div className="bg-white rounded-2xl border border-gray-100 px-5 py-12 text-center text-sm text-gray-400">
          등록된 결재선이 없습니다. 부서를 먼저 등록한 후 결재선을 추가하세요.
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {lines.map((l) => (
              <div
                key={l.id}
                className="bg-white rounded-2xl border border-gray-100 p-5 hover:border-blue-200 transition-colors group"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-start gap-3 min-w-0 flex-1">
                    <div className="p-2 rounded-xl bg-blue-50 text-blue-500 shrink-0">
                      <Users size={18} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-2">
                        <h3 className="text-base font-bold text-gray-900 truncate">
                          {l.departmentName}
                        </h3>
                        <span className="text-xs font-mono text-gray-400 shrink-0">
                          {l.departmentCode}
                        </span>
                      </div>

                      {/* 결재선 흐름 */}
                      <div className="mt-3 space-y-2">
                        <div className="flex items-center gap-2 text-sm">
                          <span className="text-xs font-semibold text-blue-600 bg-blue-50 px-2 py-0.5 rounded-full shrink-0">
                            메인
                          </span>
                          <span className="font-semibold text-gray-900 truncate">
                            {l.primaryApproverName}
                          </span>
                          <span className="text-xs text-gray-400 font-mono shrink-0">
                            {l.primaryApproverNo}
                          </span>
                        </div>

                        <div className="flex items-center gap-2 text-sm">
                          <span className="text-xs font-semibold text-amber-600 bg-amber-50 px-2 py-0.5 rounded-full shrink-0">
                            대리
                          </span>
                          {l.deputyApproverName ? (
                            <>
                              <span className="font-semibold text-gray-700 truncate">
                                {l.deputyApproverName}
                              </span>
                              <span className="text-xs text-gray-400 font-mono shrink-0">
                                {l.deputyApproverNo}
                              </span>
                            </>
                          ) : (
                            <span className="text-sm text-gray-400">
                              (없음)
                            </span>
                          )}
                        </div>

                        <div className="flex items-center gap-2 text-xs text-gray-500 pt-1">
                          <Clock size={13} className="text-gray-400" />
                          <span>
                            메인 무응답 시{" "}
                            <strong className="text-gray-700">
                              {l.autoDelegateHours}시간
                            </strong>{" "}
                            후 대리에게 자동 위임
                            {!l.deputyApproverName && (
                              <span className="text-amber-600 ml-1">
                                (대리 미지정 — 위임 미동작)
                              </span>
                            )}
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="flex gap-1 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button
                      onClick={() => openEdit(l)}
                      className="p-1.5 rounded-lg hover:bg-blue-100 text-gray-400 hover:text-blue-600"
                    >
                      <Edit size={15} />
                    </button>
                    <button
                      onClick={() => handleDelete(l)}
                      className="p-1.5 rounded-lg hover:bg-rose-100 text-gray-400 hover:text-rose-600"
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>

          <p className="text-xs text-gray-400 text-center pt-2">
            총 {lines.length}건
          </p>
        </>
      )}
    </div>
  );
}

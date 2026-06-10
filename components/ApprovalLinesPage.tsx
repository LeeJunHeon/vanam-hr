"use client";

import { useState, useEffect, useCallback } from "react";
import { Search, Plus, Edit, Trash2, Loader2, X, Download, Users, UserCog } from "lucide-react";
import { exportCSV } from "@/lib/csvUtils";
import { todayYmd } from "@/lib/dateUtils";

interface ApproverBrief { id: number; employeeNo: string | null; name: string | null; }
interface ApprovalLine {
  id: number;
  departmentId: number;
  departmentCode: string;
  departmentName: string;
  approverIds: number[];
  approvalMode: string;
  approvers: ApproverBrief[];
  deputyApproverId: number | null;
  deputyApproverName: string | null;
  autoDelegateHours: number;
}
interface DeptOption { id: number; code: string; name: string; }
interface EmpOption { id: number; employeeNo: string; name: string; departmentName: string | null; positionCode: string | null; }
interface FallbackInfo { employeeId: number | null; employeeNo: string | null; name: string | null; isActive: boolean; }

const EMPTY_FORM = {
  departmentId: "" as "" | string,
  approverIds: [] as number[],
  approvalMode: "all" as "all" | "any",
  deputyApproverId: null as number | null,
  autoDelegateHours: 24,
};

export default function ApprovalLinesPage() {
  const [lines, setLines] = useState<ApprovalLine[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");

  const [availableDepartments, setAvailableDepartments] = useState<DeptOption[]>([]);
  const [employees, setEmployees] = useState<EmpOption[]>([]);

  const [showForm, setShowForm] = useState(false);
  const [editTarget, setEditTarget] = useState<ApprovalLine | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");
  const [toast, setToast] = useState("");

  const [fallback, setFallback] = useState<FallbackInfo | null>(null);
  const [fbEditing, setFbEditing] = useState(false);
  const [fbValue, setFbValue] = useState("");
  const [fbSaving, setFbSaving] = useState(false);

  const showToast = (msg: string) => { setToast(msg); setTimeout(() => setToast(""), 2500); };

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/employees?includeInactive=false");
        if (res.ok) {
          const data = await res.json();
          setEmployees(data.map((e: any) => ({ id: e.id, employeeNo: e.employeeNo, name: e.name, departmentName: e.departmentName, positionCode: e.positionCode ?? null })));
        }
      } catch (e) { console.error("employees fetch error:", e); }
    })();
  }, []);

  const fetchFallback = useCallback(async () => {
    try {
      const res = await fetch("/api/policy/fallback-approver");
      if (res.ok) setFallback(await res.json());
    } catch (e) { console.error("fallback fetch error:", e); }
  }, []);
  useEffect(() => { fetchFallback(); }, [fetchFallback]);

  const fetchLines = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (search) params.set("search", search);
      const res = await fetch(`/api/approval-lines?${params}`);
      if (res.ok) setLines(await res.json());
    } catch (e) { console.error(e); }
    finally { setLoading(false); }
  }, [search]);

  useEffect(() => {
    const t = setTimeout(fetchLines, 300);
    return () => clearTimeout(t);
  }, [fetchLines]);

  const loadAvailableDepartments = useCallback(async () => {
    try {
      const res = await fetch("/api/approval-lines/available-departments");
      if (res.ok) setAvailableDepartments(await res.json());
    } catch (e) { console.error("available departments fetch error:", e); setAvailableDepartments([]); }
  }, []);

  useEffect(() => { loadAvailableDepartments(); }, [lines, loadAvailableDepartments]);

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
      approverIds: l.approverIds ?? [],
      approvalMode: l.approvalMode === "any" ? "any" : "all",
      deputyApproverId: l.deputyApproverId ?? null,
      autoDelegateHours: l.autoDelegateHours ?? 24,
    });
    setFormError("");
    setShowForm(true);
  };

  const toggleApprover = (id: number) => {
    setForm((f) => ({
      ...f,
      approverIds: f.approverIds.includes(id) ? f.approverIds.filter((x) => x !== id) : [...f.approverIds, id],
    }));
  };

  const handleSave = async () => {
    if (!editTarget && !form.departmentId) { setFormError("부서를 선택하세요."); return; }
    if (form.approverIds.length === 0) { setFormError("결재자를 1명 이상 선택하세요."); return; }
    setFormError("");
    setSaving(true);
    try {
      const url = editTarget ? `/api/approval-lines?id=${editTarget.id}` : "/api/approval-lines";
      const method = editTarget ? "PUT" : "POST";
      const payload: any = {
        approverIds: form.approverIds,
        approvalMode: form.approvalMode,
        deputyApproverId: form.deputyApproverId ?? null,
        autoDelegateHours: form.autoDelegateHours,
      };
      if (!editTarget) payload.departmentId = Number(form.departmentId);
      const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const data = await res.json();
      if (!res.ok) { setFormError(data.error || "저장 실패"); return; }
      showToast("✅ " + (editTarget ? "수정되었습니다" : "추가되었습니다"));
      setShowForm(false);
      fetchLines();
    } catch { setFormError("네트워크 오류"); }
    finally { setSaving(false); }
  };

  const handleDelete = async (l: ApprovalLine) => {
    if (!confirm(`"${l.departmentName}" 부서의 결재선을 삭제하시겠습니까?\n진행 중인 결재 요청에는 영향이 없습니다.`)) return;
    try {
      const res = await fetch(`/api/approval-lines?id=${l.id}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) { alert(data.error || "삭제 실패"); return; }
      showToast("✅ 삭제되었습니다");
      fetchLines();
    } catch { alert("네트워크 오류"); }
  };

  const saveFallback = async () => {
    const empId = Number(fbValue);
    if (!Number.isInteger(empId)) { showToast("직원을 선택하세요"); return; }
    setFbSaving(true);
    try {
      const res = await fetch("/api/policy/fallback-approver", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ employeeId: empId }),
      });
      const data = await res.json();
      if (!res.ok) { alert(data.error || "변경 실패"); return; }
      setFallback(data);
      setFbEditing(false);
      showToast("✅ 대체 결재자가 변경되었습니다");
    } catch { alert("네트워크 오류"); }
    finally { setFbSaving(false); }
  };

  const handleExportCSV = () => {
    if (!lines || lines.length === 0) return;
    exportCSV(
      ["부서코드", "부서명", "결재자", "승인방식", "대리결재자", "자동위임(h)"],
      lines.map((l) => [
        l.departmentCode,
        l.departmentName,
        (l.approvers ?? []).map((a) => a.name).join(" / "),
        l.approvalMode === "any" ? "한 명만(OR)" : "전원(AND)",
        l.deputyApproverName ?? "",
        String(l.autoDelegateHours ?? ""),
      ]),
      `결재선_${todayYmd()}.csv`
    );
  };

  const canAdd = availableDepartments.length > 0;
  const modeLabel = (m: string) => (m === "any" ? "한 명만" : "전원");

  return (
    <div className="p-4 sm:p-6 space-y-5">
      {toast && (<div className="fixed bottom-6 right-6 z-50 bg-gray-900 text-white text-sm font-medium px-5 py-3 rounded-xl shadow-lg">{toast}</div>)}

      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold text-gray-900">결재라인 설정</h1>
          <p className="text-sm text-gray-500 mt-0.5">부서별 결재자(여러 명)와 승인 방식을 관리합니다 (부서당 1개)</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={handleExportCSV} disabled={!lines || lines.length === 0}
            className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium bg-white border border-gray-200 text-gray-600 rounded-xl hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
            <Download size={15} /> CSV
          </button>
          <button onClick={openCreate} disabled={!canAdd || employees.length === 0}
            className="flex items-center gap-2 px-4 py-2.5 text-sm font-bold text-white bg-blue-500 rounded-xl hover:bg-blue-600 shadow-sm disabled:opacity-50 disabled:cursor-not-allowed"
            title={employees.length === 0 ? "먼저 직원을 등록하세요" : !canAdd ? "모든 활성 부서에 결재선이 등록되어 있습니다" : ""}>
            <Plus size={16} /> 결재선 추가
          </button>
        </div>
      </div>

      <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4 sm:p-5">
        <div className="flex items-start gap-3">
          <UserCog size={18} className="text-amber-600 mt-0.5 shrink-0" />
          <div className="flex-1 min-w-0">
            <h2 className="font-bold text-amber-900 text-sm">대체 결재자</h2>
            <p className="text-xs text-amber-700/80 mt-0.5">부서 결재선이 없거나 부서가 없는 신청자의 단독 결재자입니다.</p>
            {!fbEditing ? (
              <div className="flex items-center gap-3 mt-2">
                <span className="text-sm font-semibold text-gray-800">
                  {fallback?.name ? `${fallback.name}${fallback.employeeNo ? ` (${fallback.employeeNo})` : ""}` : "미설정"}
                  {fallback && fallback.isActive === false && <span className="ml-1 text-xs text-rose-500">(비활성)</span>}
                </span>
                <button onClick={() => { setFbValue(fallback?.employeeId ? String(fallback.employeeId) : ""); setFbEditing(true); }}
                  className="text-xs font-semibold text-amber-700 hover:text-amber-900 underline">변경</button>
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-2 mt-2">
                <select value={fbValue} onChange={(e) => setFbValue(e.target.value)}
                  className="px-3 py-2 border border-amber-300 rounded-xl text-sm bg-white outline-none focus:ring-2 focus:ring-amber-400">
                  <option value="">(선택)</option>
                  {employees.map((e) => (<option key={e.id} value={e.id}>{e.name} ({e.employeeNo})</option>))}
                </select>
                <button onClick={saveFallback} disabled={fbSaving || !fbValue}
                  className="px-3 py-2 bg-amber-500 text-white rounded-xl text-sm font-semibold hover:bg-amber-600 disabled:opacity-60">{fbSaving ? "저장 중..." : "저장"}</button>
                <button onClick={() => setFbEditing(false)}
                  className="px-3 py-2 bg-white border border-amber-300 text-amber-700 rounded-xl text-sm font-medium hover:bg-amber-100">취소</button>
              </div>
            )}
          </div>
        </div>
      </div>

      {showForm && (
        <div className="bg-blue-50 border border-blue-200 rounded-2xl p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="font-bold text-blue-900">{editTarget ? "결재선 수정" : "결재선 추가"}</h2>
            <button onClick={() => setShowForm(false)} className="text-blue-400 hover:text-blue-700"><X size={18} /></button>
          </div>

          <div>
            <label className="block text-xs font-semibold text-blue-700 mb-1">부서 <span className="text-rose-500">*</span></label>
            {editTarget ? (
              <input disabled value={`${editTarget.departmentName} (${editTarget.departmentCode})`}
                className="w-full px-3 py-2.5 border border-blue-200 rounded-xl text-sm bg-gray-100 text-gray-500 outline-none" />
            ) : (
              <select value={form.departmentId} onChange={(e) => setForm((f) => ({ ...f, departmentId: e.target.value }))}
                disabled={availableDepartments.length === 0}
                className="w-full px-3 py-2.5 border border-blue-200 rounded-xl text-sm bg-white outline-none focus:ring-2 focus:ring-blue-400 disabled:bg-gray-100 disabled:text-gray-400">
                <option value="">(선택)</option>
                {availableDepartments.map((d) => (<option key={d.id} value={d.id}>{d.name} ({d.code})</option>))}
              </select>
            )}
            {editTarget && <p className="text-[10px] text-gray-400 mt-1">부서 변경 불가 — 옮기려면 삭제 후 재생성</p>}
          </div>

          <div>
            <label className="block text-xs font-semibold text-blue-700 mb-1">
              결재자 <span className="text-rose-500">*</span>
              <span className="ml-1 font-normal text-blue-500">({form.approverIds.length}명 선택됨)</span>
            </label>
            <div className="max-h-52 overflow-y-auto border border-blue-200 rounded-xl bg-white divide-y divide-blue-50">
              {employees.length === 0 ? (
                <div className="px-3 py-4 text-sm text-gray-400 text-center">직원이 없습니다</div>
              ) : (
                employees.map((e) => {
                  const checked = form.approverIds.includes(e.id);
                  return (
                    <label key={e.id} className={`flex items-center gap-2.5 px-3 py-2 text-sm cursor-pointer ${checked ? "bg-blue-50" : "hover:bg-gray-50"}`}>
                      <input type="checkbox" checked={checked} onChange={() => toggleApprover(e.id)} className="accent-blue-600 w-4 h-4" />
                      <span className="font-medium text-gray-800">{e.name}</span>
                      <span className="text-xs text-gray-400">({e.employeeNo}) · {e.departmentName ?? "부서 미지정"}</span>
                    </label>
                  );
                })
              )}
            </div>
            <p className="text-[10px] text-gray-500 mt-1">※ CEO는 결재자로 지정할 수 없습니다.</p>
          </div>

          <div>
            <label className="block text-xs font-semibold text-blue-700 mb-1">승인 방식</label>
            <div className="inline-flex rounded-xl border border-blue-200 overflow-hidden">
              {([["all", "전원 승인 (AND)"], ["any", "한 명만 승인 (OR)"]] as const).map(([v, label]) => (
                <button key={v} type="button" onClick={() => setForm((f) => ({ ...f, approvalMode: v }))}
                  className={`px-3.5 py-2 text-sm ${form.approvalMode === v ? "bg-blue-500 text-white font-semibold" : "bg-white text-gray-600 hover:bg-blue-50"}`}>{label}</button>
              ))}
            </div>
            <p className="text-[10px] text-gray-500 mt-1">
              {form.approvalMode === "all" ? "선택한 결재자 전원이 승인해야 최종 승인됩니다." : "선택한 결재자 중 한 명만 승인하면 최종 승인됩니다."}
            </p>
          </div>

          <div>
            <label className="block text-xs font-semibold text-blue-700 mb-1">대리 결재자 (선택)</label>
            <select
              value={form.deputyApproverId ?? ""}
              onChange={(e) => setForm((f) => ({ ...f, deputyApproverId: e.target.value === "" ? null : Number(e.target.value) }))}
              className="w-full px-3 py-2.5 border border-blue-200 rounded-xl text-sm bg-white outline-none focus:ring-2 focus:ring-blue-400">
              <option value="">없음</option>
              {employees
                .filter((e) => e.positionCode !== "CEO" && !form.approverIds.includes(e.id))
                .map((e) => (<option key={e.id} value={e.id}>{e.name} ({e.employeeNo})</option>))}
            </select>
          </div>

          <div>
            <label className="block text-xs font-semibold text-blue-700 mb-1">자동 위임 시간 (시간)</label>
            <input
              type="number"
              min={1}
              value={form.autoDelegateHours}
              onChange={(e) => setForm((f) => ({ ...f, autoDelegateHours: Math.max(1, Number(e.target.value) || 1) }))}
              className="w-full px-3 py-2.5 border border-blue-200 rounded-xl text-sm bg-white outline-none focus:ring-2 focus:ring-blue-400" />
            <p className="text-[10px] text-gray-500 mt-1">메인이 이 시간 내 미처리 시 대리가 결재 가능합니다. (대리 결재자가 없으면 의미 없음)</p>
          </div>

          {formError && <p className="text-sm text-red-500 bg-red-50 px-3 py-2 rounded-xl">{formError}</p>}

          <div className="flex gap-2">
            <button onClick={handleSave} disabled={saving}
              className="px-5 py-2.5 bg-blue-500 text-white rounded-xl text-sm font-semibold hover:bg-blue-600 disabled:opacity-60">{saving ? "저장 중..." : editTarget ? "수정 저장" : "추가"}</button>
            <button onClick={() => setShowForm(false)}
              className="px-5 py-2.5 bg-white border border-blue-200 text-blue-700 rounded-xl text-sm font-medium hover:bg-blue-50">취소</button>
          </div>
        </div>
      )}

      <div className="bg-white rounded-2xl border border-gray-100 p-3 sm:p-4">
        <div className="relative">
          <Search size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-400" />
          <input type="text" placeholder="부서명 또는 결재자명으로 검색" value={search} onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-10 pr-4 py-2.5 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-blue-500 outline-none" />
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center h-32">
          <Loader2 size={24} className="animate-spin text-blue-500" />
          <span className="ml-2 text-sm text-gray-500">로딩 중...</span>
        </div>
      ) : lines.length === 0 ? (
        <div className="bg-white rounded-2xl border border-gray-100 px-5 py-12 text-center text-sm text-gray-400">등록된 결재선이 없습니다. 부서를 먼저 등록한 후 결재선을 추가하세요.</div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 sm:gap-4">
          {lines.map((l) => (
            <div key={l.id} className="bg-white rounded-2xl border border-gray-100 p-4 sm:p-5">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <h3 className="text-base font-bold text-gray-900 truncate">{l.departmentName}</h3>
                  <span className="text-xs text-gray-400">{l.departmentCode}</span>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${l.approvalMode === "any" ? "bg-violet-50 text-violet-700" : "bg-emerald-50 text-emerald-700"}`}>{modeLabel(l.approvalMode)} 승인</span>
                  <button onClick={() => openEdit(l)} className="p-1.5 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg"><Edit size={15} /></button>
                  <button onClick={() => handleDelete(l)} className="p-1.5 text-gray-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg"><Trash2 size={15} /></button>
                </div>
              </div>
              <div className="mt-3 flex items-start gap-2">
                <Users size={15} className="text-gray-400 mt-0.5 shrink-0" />
                <div className="flex flex-wrap gap-1.5">
                  {(l.approvers ?? []).length === 0 ? (
                    <span className="text-sm text-gray-400">결재자 없음</span>
                  ) : (
                    (l.approvers ?? []).map((a) => (
                      <span key={a.id} className="text-xs font-medium px-2 py-0.5 rounded-lg bg-gray-100 text-gray-700">{a.name}{a.employeeNo ? ` (${a.employeeNo})` : ""}</span>
                    ))
                  )}
                </div>
              </div>
              <div className="mt-2 flex items-center gap-2 text-xs text-gray-500">
                <UserCog size={14} className="text-gray-400 shrink-0" />
                <span>{l.deputyApproverName ? `대리: ${l.deputyApproverName}` : "—"}</span>
                {l.deputyApproverName && (
                  <span className="text-gray-400">· 자동위임 {l.autoDelegateHours ?? 24}h</span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

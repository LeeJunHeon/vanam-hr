"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import {
  Plus,
  Edit,
  X,
  ClipboardList,
  Calendar,
  Clock,
  AlertCircle,
  Loader2,
  CheckCircle,
  XCircle,
  Download,
  FileText,
} from "lucide-react";
import { useCurrentEmployee } from "@/lib/useCurrentEmployee";
import { exportCSV } from "@/lib/csvUtils";

interface AttendanceRequest {
  id: number;
  employeeId: number;
  categoryId: number;
  categoryCode: string;
  categoryName: string;
  categoryType: string;
  categoryColor: string | null;
  requestType: string;
  startDate: string;
  endDate: string;
  reason: string | null;
  correctedCheckIn: string | null;
  correctedCheckOut: string | null;
  status: string;
  primaryApproverId: number | null;
  primaryApproverName: string | null;
  deputyApproverId: number | null;
  deputyApproverName: string | null;
  approvedById: number | null;
  approvedByName: string | null;
  approvedAt: string | null;
  rejectReason: string | null;
  requestedAt: string;
}

interface CategoryOption {
  id: number;
  code: string;
  name: string;
  type: string;
  displayColor: string | null;
  requireApproval: boolean;
}

interface StatusLookup {
  code: string;
  label: string;
  color: string | null;
}

function pad2(n: number) {
  return String(n).padStart(2, "0");
}

function todayYmd(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function formatDateTime(iso: string | null): string {
  if (!iso) return "-";
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(
    d.getDate()
  )} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

// datetime-local input value 변환 (ISO → "YYYY-MM-DDTHH:MM")
function isoToLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(
    d.getDate()
  )}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

const EMPTY_FORM = {
  categoryId: "" as "" | string,
  startDate: todayYmd(),
  endDate: todayYmd(),
  reason: "",
  correctedCheckIn: "",
  correctedCheckOut: "",
};

export default function RequestPage() {
  const { currentId, current, loading: empLoading } = useCurrentEmployee();

  const [requests, setRequests] = useState<AttendanceRequest[]>([]);
  const [loading, setLoading] = useState(false);
  const [statusFilter, setStatusFilter] = useState<string>("");

  const [categories, setCategories] = useState<CategoryOption[]>([]);
  const [statusLookups, setStatusLookups] = useState<StatusLookup[]>([]);

  const [showForm, setShowForm] = useState(false);
  const [editTarget, setEditTarget] = useState<AttendanceRequest | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");
  const [toast, setToast] = useState("");

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(""), 2500);
  };

  // 마스터 1회 로드
  useEffect(() => {
    (async () => {
      try {
        const [cRes, sRes] = await Promise.all([
          fetch("/api/categories?includeInactive=false"),
          fetch("/api/lookups?category=request_status&includeInactive=false"),
        ]);
        if (cRes.ok) {
          const data = await cRes.json();
          setCategories(
            data.map((c: any) => ({
              id: c.id,
              code: c.code,
              name: c.name,
              type: c.type,
              displayColor: c.displayColor,
              requireApproval: c.requireApproval,
            }))
          );
        }
        if (sRes.ok) setStatusLookups(await sRes.json());
      } catch (e) {
        console.error("masters fetch error:", e);
      }
    })();
  }, []);

  const fetchRequests = useCallback(async () => {
    if (!currentId) {
      setRequests([]);
      return;
    }
    setLoading(true);
    try {
      const params = new URLSearchParams();
      params.set("employeeId", String(currentId));
      if (statusFilter) params.set("status", statusFilter);
      const res = await fetch(`/api/attendance-requests?${params}`);
      if (res.ok) setRequests(await res.json());
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, [currentId, statusFilter]);

  useEffect(() => {
    fetchRequests();
  }, [fetchRequests]);

  // status / category helper
  const getStatusLabel = (code: string): string => {
    const lookup = statusLookups.find((l) => l.code === code);
    return lookup ? lookup.label : code;
  };
  const getStatusColor = (code: string): string | null => {
    const lookup = statusLookups.find((l) => l.code === code);
    return lookup?.color ?? null;
  };

  const selectedCategory = useMemo(
    () =>
      categories.find((c) => c.id === Number(form.categoryId)) ?? null,
    [categories, form.categoryId]
  );

  const openCreate = () => {
    setEditTarget(null);
    setForm(EMPTY_FORM);
    setFormError("");
    setShowForm(true);
  };

  const openEdit = (r: AttendanceRequest) => {
    if (r.status !== "pending") return;
    setEditTarget(r);
    setForm({
      categoryId: String(r.categoryId),
      startDate: r.startDate,
      endDate: r.endDate,
      reason: r.reason || "",
      correctedCheckIn: isoToLocalInput(r.correctedCheckIn),
      correctedCheckOut: isoToLocalInput(r.correctedCheckOut),
    });
    setFormError("");
    setShowForm(true);
  };

  const handleSave = async () => {
    if (!currentId) return;
    if (!form.categoryId) {
      setFormError("근태 항목을 선택하세요.");
      return;
    }
    if (!form.startDate || !form.endDate) {
      setFormError("시작일과 종료일을 입력하세요.");
      return;
    }
    if (form.endDate < form.startDate) {
      setFormError("종료일은 시작일 이후여야 합니다.");
      return;
    }
    if (selectedCategory?.type === "correction") {
      if (!form.correctedCheckIn || !form.correctedCheckOut) {
        setFormError("근태정정은 정정 출근/퇴근 시각이 모두 필요합니다.");
        return;
      }
      if (form.correctedCheckOut <= form.correctedCheckIn) {
        setFormError("정정 퇴근 시각은 정정 출근 시각 이후여야 합니다.");
        return;
      }
    }

    setFormError("");
    setSaving(true);
    try {
      const url = editTarget
        ? `/api/attendance-requests?id=${editTarget.id}`
        : "/api/attendance-requests";
      const method = editTarget ? "PUT" : "POST";

      const payload: any = {
        employeeId: currentId,
        categoryId: Number(form.categoryId),
        startDate: form.startDate,
        endDate: form.endDate,
        reason: form.reason.trim() || null,
      };
      if (selectedCategory?.type === "correction") {
        payload.correctedCheckIn = form.correctedCheckIn || null;
        payload.correctedCheckOut = form.correctedCheckOut || null;
      } else {
        payload.correctedCheckIn = null;
        payload.correctedCheckOut = null;
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
      showToast(
        "✅ " +
          (editTarget
            ? "수정되었습니다"
            : data.status === "auto_approved"
            ? "자동 승인 완료"
            : "신청되었습니다")
      );
      setShowForm(false);
      fetchRequests();
    } catch {
      setFormError("네트워크 오류");
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = async (r: AttendanceRequest) => {
    if (!currentId) return;
    if (
      !confirm(
        `"${r.categoryName}" 결재 요청을 취소하시겠습니까?\n취소 후에는 복구할 수 없습니다.`
      )
    )
      return;
    try {
      const res = await fetch(`/api/attendance-requests?id=${r.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ employeeId: currentId, action: "cancel" }),
      });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || "취소 실패");
        return;
      }
      showToast("✅ 취소되었습니다");
      fetchRequests();
    } catch {
      alert("네트워크 오류");
    }
  };

  const handleExportCSV = () => {
    if (!requests || requests.length === 0) return;
    exportCSV(
      ["근태항목", "유형", "시작일", "종료일", "사유", "상태", "결재자", "등록일"],
      requests.map((r) => [
        r.categoryName,
        r.categoryType,
        r.startDate,
        r.endDate,
        r.reason ?? "",
        getStatusLabel(r.status),
        r.approvedByName ??
          r.primaryApproverName ??
          (r.status === "auto_approved" ? "자동 승인" : ""),
        new Date(r.requestedAt).toLocaleString("ko-KR"),
      ]),
      `결재요청_${new Date().toISOString().split("T")[0]}.csv`
    );
  };

  // status 배지 스타일
  function statusBadge(code: string) {
    const color = getStatusColor(code);
    if (color && color.startsWith("#")) {
      return {
        backgroundColor: `${color}20`,
        color,
      };
    }
    return { backgroundColor: "#f3f4f6", color: "#4b5563" };
  }

  const canRequest = currentId !== null;

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
            휴가/근태 신청
          </h1>
          <p className="text-sm text-gray-500 mt-0.5">
            {current
              ? `${current.name} 님의 결재 요청`
              : "본인을 선택하세요"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleExportCSV}
            disabled={!requests || requests.length === 0}
            className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium bg-white border border-gray-200 text-gray-600 rounded-xl hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            <Download size={15} />
            CSV
          </button>
          <button
            onClick={openCreate}
            disabled={!canRequest || categories.length === 0}
            className="flex items-center gap-2 px-4 py-2.5 text-sm font-bold text-white bg-blue-500 rounded-xl hover:bg-blue-600 shadow-sm disabled:opacity-50 disabled:cursor-not-allowed"
            title={
              !canRequest
                ? "본인을 선택하세요"
                : categories.length === 0
                ? "활성 근태 항목이 없습니다"
                : ""
            }
          >
            <Plus size={16} />
            결재 신청
          </button>
        </div>
      </div>

      {/* 본인 없음 */}
      {empLoading ? (
        <div className="flex items-center justify-center h-32">
          <Loader2 size={24} className="animate-spin text-blue-500" />
          <span className="ml-2 text-sm text-gray-500">로딩 중...</span>
        </div>
      ) : !currentId ? (
        <div className="bg-white rounded-2xl border border-gray-100 p-8 text-center text-sm text-gray-400 flex flex-col items-center gap-3">
          <AlertCircle size={24} className="text-gray-300" />
          본인을 선택하세요
        </div>
      ) : (
        <>
          {/* 등록 / 수정 폼 */}
          {showForm && (
            <div className="bg-blue-50 border border-blue-200 rounded-2xl p-5 space-y-4">
              <div className="flex items-center justify-between">
                <h2 className="font-bold text-blue-900">
                  {editTarget ? "결재 요청 수정" : "결재 신청"}
                </h2>
                <button
                  onClick={() => setShowForm(false)}
                  className="text-blue-400 hover:text-blue-700"
                >
                  <X size={18} />
                </button>
              </div>

              {/* 근태 항목 */}
              <div>
                <label className="block text-xs font-semibold text-blue-700 mb-1">
                  근태 항목 <span className="text-rose-500">*</span>
                </label>
                <select
                  value={form.categoryId}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, categoryId: e.target.value }))
                  }
                  className="w-full px-3 py-2.5 border border-blue-200 rounded-xl text-sm bg-white outline-none focus:ring-2 focus:ring-blue-400"
                >
                  <option value="">(선택)</option>
                  {categories.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name} ({c.code})
                    </option>
                  ))}
                </select>
              </div>

              {/* 자동 승인 안내 */}
              {selectedCategory && (
                <div
                  className={`px-3 py-2 rounded-xl text-xs ${
                    selectedCategory.requireApproval
                      ? "bg-blue-100 text-blue-800"
                      : "bg-amber-50 border border-amber-200 text-amber-800"
                  }`}
                >
                  {selectedCategory.requireApproval ? (
                    <>
                      <CheckCircle size={12} className="inline mr-1 -translate-y-px" />
                      이 항목은 결재가 필요합니다. 신청 후 결재자 승인 대기 상태가 됩니다.
                    </>
                  ) : (
                    <>
                      <AlertCircle size={12} className="inline mr-1 -translate-y-px" />
                      이 항목은 자동 승인됩니다. 결재 절차 없이 즉시 등록됩니다.
                    </>
                  )}
                </div>
              )}

              {/* 기간 */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-blue-700 mb-1">
                    시작일 <span className="text-rose-500">*</span>
                  </label>
                  <input
                    type="date"
                    value={form.startDate}
                    onChange={(e) =>
                      setForm((f) => ({
                        ...f,
                        startDate: e.target.value,
                        // 종료가 시작보다 이전이면 동기화
                        endDate:
                          f.endDate < e.target.value ? e.target.value : f.endDate,
                      }))
                    }
                    className="w-full px-3 py-2.5 border border-blue-200 rounded-xl text-sm bg-white outline-none focus:ring-2 focus:ring-blue-400"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-blue-700 mb-1">
                    종료일 <span className="text-rose-500">*</span>
                  </label>
                  <input
                    type="date"
                    value={form.endDate}
                    min={form.startDate || undefined}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, endDate: e.target.value }))
                    }
                    className="w-full px-3 py-2.5 border border-blue-200 rounded-xl text-sm bg-white outline-none focus:ring-2 focus:ring-blue-400"
                  />
                </div>
              </div>

              {/* 정정 시각 (correction 타입만) */}
              {selectedCategory?.type === "correction" && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 bg-white border border-blue-200 rounded-xl p-3">
                  <div className="sm:col-span-2 text-[10px] text-blue-700">
                    근태정정은 정정 시각이 필수입니다
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-blue-700 mb-1">
                      정정 출근 <span className="text-rose-500">*</span>
                    </label>
                    <input
                      type="datetime-local"
                      value={form.correctedCheckIn}
                      onChange={(e) =>
                        setForm((f) => ({
                          ...f,
                          correctedCheckIn: e.target.value,
                        }))
                      }
                      className="w-full px-3 py-2 border border-blue-200 rounded-xl text-sm bg-white outline-none focus:ring-2 focus:ring-blue-400"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-blue-700 mb-1">
                      정정 퇴근 <span className="text-rose-500">*</span>
                    </label>
                    <input
                      type="datetime-local"
                      value={form.correctedCheckOut}
                      min={form.correctedCheckIn || undefined}
                      onChange={(e) =>
                        setForm((f) => ({
                          ...f,
                          correctedCheckOut: e.target.value,
                        }))
                      }
                      className="w-full px-3 py-2 border border-blue-200 rounded-xl text-sm bg-white outline-none focus:ring-2 focus:ring-blue-400"
                    />
                  </div>
                </div>
              )}

              {/* 사유 */}
              <div>
                <label className="block text-xs font-semibold text-blue-700 mb-1">
                  사유
                </label>
                <textarea
                  value={form.reason}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, reason: e.target.value }))
                  }
                  rows={2}
                  className="w-full px-3 py-2.5 border border-blue-200 rounded-xl text-sm bg-white outline-none focus:ring-2 focus:ring-blue-400 resize-none"
                />
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
                  {saving
                    ? "저장 중..."
                    : editTarget
                    ? "수정 저장"
                    : "신청"}
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
            <label className="block text-xs font-semibold text-gray-500 mb-1">
              상태
            </label>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="w-full sm:w-64 px-3 py-2.5 border border-gray-200 rounded-xl text-sm bg-white outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="">전체</option>
              {statusLookups.map((s) => (
                <option key={s.code} value={s.code}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>

          {/* 목록 */}
          {loading ? (
            <div className="flex items-center justify-center h-32">
              <Loader2 size={24} className="animate-spin text-blue-500" />
              <span className="ml-2 text-sm text-gray-500">로딩 중...</span>
            </div>
          ) : requests.length === 0 ? (
            <div className="bg-white rounded-2xl border border-gray-100 px-5 py-12 text-center text-sm text-gray-400 flex flex-col items-center gap-3">
              <ClipboardList size={24} className="text-gray-300" />
              신청한 결재가 없습니다. 좌상단 '결재 신청' 버튼으로 새 결재를 만드세요.
            </div>
          ) : (
            <>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                {requests.map((r) => {
                  const isPending = r.status === "pending";
                  const isRejected = r.status === "rejected";
                  const catColor = r.categoryColor;

                  return (
                    <div
                      key={r.id}
                      className="bg-white rounded-2xl border border-gray-100 p-4 sm:p-5 hover:border-blue-200 transition-colors group"
                    >
                      {/* 상단: 카테고리 + 상태 */}
                      <div className="flex items-start justify-between gap-2 mb-3">
                        <div className="flex items-center gap-2 min-w-0">
                          {catColor && catColor.startsWith("#") && (
                            <div
                              className="w-3 h-3 rounded-full border border-gray-200 shrink-0"
                              style={{ backgroundColor: catColor }}
                            />
                          )}
                          <h3 className="text-base font-bold text-gray-900 truncate">
                            {r.categoryName}
                          </h3>
                        </div>
                        <span
                          className="text-xs font-semibold px-2 py-0.5 rounded-full shrink-0"
                          style={statusBadge(r.status)}
                        >
                          {getStatusLabel(r.status)}
                        </span>
                      </div>

                      {/* 기간 */}
                      <div className="flex items-center gap-2 text-sm text-gray-700 mb-2">
                        <Calendar size={13} className="text-gray-400" />
                        <span className="font-mono">
                          {r.startDate}
                          {r.endDate !== r.startDate && ` ~ ${r.endDate}`}
                        </span>
                      </div>

                      {/* 사유 */}
                      {r.reason && (
                        <div className="flex items-start gap-2 text-sm text-gray-600 mb-2">
                          <FileText
                            size={13}
                            className="text-gray-400 mt-0.5 shrink-0"
                          />
                          <span className="line-clamp-2">{r.reason}</span>
                        </div>
                      )}

                      {/* 정정 시각 */}
                      {r.categoryType === "correction" &&
                        (r.correctedCheckIn || r.correctedCheckOut) && (
                          <div className="flex items-center gap-2 text-xs text-gray-500 mb-2 font-mono">
                            <Clock size={13} className="text-gray-400" />
                            <span>
                              정정: {formatDateTime(r.correctedCheckIn)}
                              {r.correctedCheckOut &&
                                ` ~ ${formatDateTime(r.correctedCheckOut)}`}
                            </span>
                          </div>
                        )}

                      {/* 결재자 */}
                      <div className="text-xs text-gray-500 space-y-0.5 mb-2">
                        {r.status === "auto_approved" ? (
                          <p className="text-emerald-600 font-medium">
                            <CheckCircle
                              size={11}
                              className="inline mr-1 -translate-y-px"
                            />
                            자동 승인 ·{" "}
                            {r.approvedAt &&
                              new Date(r.approvedAt).toLocaleString("ko-KR")}
                          </p>
                        ) : (
                          <>
                            {r.primaryApproverName && (
                              <p>
                                <span className="text-blue-600 font-semibold">메인</span>:{" "}
                                {r.primaryApproverName}
                              </p>
                            )}
                            {r.deputyApproverName && (
                              <p>
                                <span className="text-amber-600 font-semibold">대리</span>:{" "}
                                {r.deputyApproverName}
                              </p>
                            )}
                            {r.approvedByName && (
                              <p className="text-emerald-600">
                                <CheckCircle
                                  size={11}
                                  className="inline mr-1 -translate-y-px"
                                />
                                승인자: {r.approvedByName} ·{" "}
                                {r.approvedAt &&
                                  new Date(r.approvedAt).toLocaleString(
                                    "ko-KR"
                                  )}
                              </p>
                            )}
                          </>
                        )}
                      </div>

                      {/* 반려 사유 */}
                      {isRejected && r.rejectReason && (
                        <div className="bg-rose-50 border border-rose-200 rounded-xl px-3 py-2 text-xs text-rose-700 flex items-start gap-2 mb-2">
                          <XCircle
                            size={13}
                            className="shrink-0 mt-0.5 text-rose-500"
                          />
                          <div>
                            <p className="font-semibold">반려 사유</p>
                            <p className="mt-0.5">{r.rejectReason}</p>
                          </div>
                        </div>
                      )}

                      {/* 등록 시각 + 작업 버튼 */}
                      <div className="flex items-center justify-between pt-2 border-t border-gray-50">
                        <p className="text-[10px] text-gray-400">
                          신청: {new Date(r.requestedAt).toLocaleString("ko-KR")}
                        </p>
                        {isPending && (
                          <div className="flex gap-1">
                            <button
                              onClick={() => openEdit(r)}
                              className="p-1.5 rounded-lg hover:bg-blue-100 text-gray-400 hover:text-blue-600"
                              title="수정"
                            >
                              <Edit size={14} />
                            </button>
                            <button
                              onClick={() => handleCancel(r)}
                              className="p-1.5 rounded-lg hover:bg-rose-100 text-gray-400 hover:text-rose-600"
                              title="취소"
                            >
                              <X size={14} />
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>

              <p className="text-xs text-gray-400 text-center pt-2">
                총 {requests.length}건
              </p>
            </>
          )}
        </>
      )}
    </div>
  );
}

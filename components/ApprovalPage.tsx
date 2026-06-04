"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import {
  ClipboardCheck,
  CheckCircle,
  XCircle,
  Calendar,
  Clock,
  FileText,
  AlertCircle,
  Loader2,
  User,
  Shield,
  X,
  Plane,
  Filter,
  Users as UsersIcon,
  MapPin,
} from "lucide-react";
import { useCurrentEmployee } from "@/lib/useCurrentEmployee";

// Phase 7 3단계: 결재함이 attendance + trip 두 종류를 모두 다룸.
// 응답에 kind 필드가 추가됨 — 'attendance' or 'trip'.

interface ApprovalItem {
  kind?: "attendance"; // 신규 — 미지정 시 attendance(레거시 호환)
  id: number;
  employeeId: number;
  employeeNo: string;
  employeeName: string;
  departmentName: string | null;
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
  approvedAt: string | null;
  rejectReason: string | null;
  requestedAt: string;
  myRole: "primary" | "deputy" | null;
  autoDelegateHours: number;
  delegated: boolean;
  hoursLeft: number;
  canApprove: boolean;
  isSelfRequest: boolean;
  // Phase 6-2E 캘린더 등록 정보
  calendarSourceId: number | null;
  calendarEventTitle: string | null;
  calendarEventDescription: string | null;
  externalSource: string | null;
  externalEventId: string | null;
}

// Phase 7 3단계: 출장 결재 항목
interface TripPendingParticipant {
  participantId: number;
  employeeId: number;
  employeeName: string;
  employeeNo: string | null;
  departmentName: string | null;
  inviteStatus: string;
  approvalStatus: string;
  approvedById: number | null;
  approvedByName: string | null;
  approvedAt: string | null;
  rejectReason: string | null;
  dates: Array<{
    attendDate: string;
    startTime: string | null;
    endTime: string | null;
  }>;
}
interface TripApprovalItem {
  kind: "trip";
  id: number;
  categoryCode: string;
  categoryName: string;
  categoryType: string;
  categoryColor: string | null;
  status: string;
  startDate: string;
  endDate: string;
  requestedAt: string;
  employeeId: number;
  employeeName: string | null;
  isSelfRequest: boolean;
  tripEventId: number;
  eventName: string;
  location: string | null;
  eventStartDate: string;
  eventEndDate: string;
  pendingCount: number;
  pendingParticipants: TripPendingParticipant[];
  approvedAt: string | null;
}

type AnyApprovalItem = ApprovalItem | TripApprovalItem;
function isTrip(it: AnyApprovalItem): it is TripApprovalItem {
  return it.kind === "trip";
}

interface CalendarSourceOption {
  id: number;
  calendarId: string;
  calendarName: string;
  defaultCategoryId: number;
  description: string | null;
}

// 결재자가 카드에서 수정한 캘린더 정보를 일시 저장 (request id → 수정값)
interface EditedCalendar {
  sourceId?: number | null;
  title?: string;
  description?: string;
}

interface StatusLookup {
  code: string;
  label: string;
  color: string | null;
}

type Tab = "pending" | "history";

function pad2(n: number) {
  return String(n).padStart(2, "0");
}

function formatDateTime(iso: string | null): string {
  if (!iso) return "-";
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(
    d.getDate()
  )} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

interface RejectModalState {
  item: ApprovalItem | null;
  reason: string;
  saving: boolean;
}

const EMPTY_REJECT: RejectModalState = {
  item: null,
  reason: "",
  saving: false,
};

export default function ApprovalPage() {
  const { currentId, current, me, loading: empLoading } = useCurrentEmployee();

  const [tab, setTab] = useState<Tab>("pending");
  const [approvals, setApprovals] = useState<AnyApprovalItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [statusLookups, setStatusLookups] = useState<StatusLookup[]>([]);
  const [rejectModal, setRejectModal] = useState<RejectModalState>(EMPTY_REJECT);
  const [toast, setToast] = useState("");
  // Phase 6-2E 캘린더 옵션 + 결재자 인라인 수정값
  const [calendarSources, setCalendarSources] = useState<CalendarSourceOption[]>([]);
  const [editedCalendar, setEditedCalendar] = useState<Record<number, EditedCalendar>>({});
  // Phase 7 3단계: 카테고리 필터(categoryCode 기준, "all" = 전체) + 출장 결재 팝업 대상
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [openTripItem, setOpenTripItem] = useState<TripApprovalItem | null>(null);

  const updateEditedCalendar = (
    reqId: number,
    field: keyof EditedCalendar,
    value: number | null | string
  ) => {
    setEditedCalendar((prev) => ({
      ...prev,
      [reqId]: { ...(prev[reqId] ?? {}), [field]: value },
    }));
  };

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(""), 2500);
  };

  // status lookup 1회
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(
          "/api/lookups?category=request_status&includeInactive=false"
        );
        if (res.ok) setStatusLookups(await res.json());
      } catch (e) {
        console.error("status lookups fetch error:", e);
      }
    })();
  }, []);

  // Phase 6-2E 캘린더 소스 로드 (1회)
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/calendar-sources");
        if (res.ok) setCalendarSources(await res.json());
      } catch (e) {
        console.error("calendar-sources fetch error:", e);
      }
    })();
  }, []);

  const fetchApprovals = useCallback(async () => {
    if (!currentId) {
      setApprovals([]);
      return;
    }
    setLoading(true);
    try {
      const params = new URLSearchParams();
      params.set("approverId", String(currentId));
      params.set("status", tab === "pending" ? "pending" : "all");
      const res = await fetch(`/api/approvals?${params}`);
      if (res.ok) setApprovals(await res.json());
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, [currentId, tab]);

  useEffect(() => {
    fetchApprovals();
  }, [fetchApprovals]);

  // 카테고리 필터 적용
  const filteredApprovals = useMemo(() => {
    if (categoryFilter === "all") return approvals;
    return approvals.filter((it) => it.categoryCode === categoryFilter);
  }, [approvals, categoryFilter]);

  const getStatusLabel = (code: string): string => {
    const lookup = statusLookups.find((l) => l.code === code);
    return lookup ? lookup.label : code;
  };
  const getStatusColor = (code: string): string | null => {
    const lookup = statusLookups.find((l) => l.code === code);
    return lookup?.color ?? null;
  };

  function statusBadge(code: string) {
    const color = getStatusColor(code);
    if (color && color.startsWith("#")) {
      return { backgroundColor: `${color}20`, color };
    }
    return { backgroundColor: "#f3f4f6", color: "#4b5563" };
  }

  const handleApprove = async (item: ApprovalItem) => {
    if (!currentId) return;
    if (
      !confirm(
        `${item.employeeName} 님의 "${item.categoryName}" 요청을 승인하시겠습니까?`
      )
    )
      return;
    try {
      // Phase 6-2E: 결재자가 카드 내에서 수정한 캘린더 정보 같이 전송
      // (없으면 undefined → API에서 미변경, 기존 값 그대로 유지)
      const edited = editedCalendar[item.id];
      const payload: Record<string, unknown> = {
        approverId: currentId,
        action: "approve",
      };
      if (edited) {
        if (edited.sourceId !== undefined) {
          payload.calendarSourceId = edited.sourceId;
        }
        if (edited.title !== undefined) {
          payload.calendarEventTitle = edited.title;
        }
        if (edited.description !== undefined) {
          payload.calendarEventDescription = edited.description;
        }
      }
      const res = await fetch(`/api/approvals?id=${item.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || "승인 실패");
        return;
      }
      // 캘린더 등록 결과 알림 (있을 때만)
      const calNote = data.calendarEventId
        ? ` (캘린더 등록 완료)`
        : "";
      showToast("✅ 승인되었습니다" + calNote);
      // 편집 상태 초기화
      setEditedCalendar((prev) => {
        const next = { ...prev };
        delete next[item.id];
        return next;
      });
      fetchApprovals();
    } catch {
      alert("네트워크 오류");
    }
  };

  const openReject = (item: ApprovalItem) => {
    setRejectModal({ item, reason: "", saving: false });
  };

  const closeReject = () => setRejectModal(EMPTY_REJECT);

  const handleRejectConfirm = async () => {
    if (!currentId || !rejectModal.item) return;
    if (!rejectModal.reason.trim()) {
      alert("반려 사유를 입력하세요.");
      return;
    }
    setRejectModal((m) => ({ ...m, saving: true }));
    try {
      const res = await fetch(`/api/approvals?id=${rejectModal.item.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          approverId: currentId,
          action: "reject",
          rejectReason: rejectModal.reason.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || "반려 실패");
        setRejectModal((m) => ({ ...m, saving: false }));
        return;
      }
      showToast("✅ 반려 처리되었습니다");
      closeReject();
      fetchApprovals();
    } catch {
      alert("네트워크 오류");
      setRejectModal((m) => ({ ...m, saving: false }));
    }
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
      <div>
        <h1 className="text-xl sm:text-2xl font-bold text-gray-900">결재함</h1>
        <p className="text-sm text-gray-500 mt-0.5">
          {current
            ? `${current.name} 님이 결재할 요청과 처리 이력`
            : "본인을 선택하세요"}
        </p>
      </div>

      {/* 탭 */}
      <div className="flex gap-1 bg-gray-100 p-1 rounded-xl w-fit">
        <button
          onClick={() => setTab("pending")}
          className={`flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg transition-all ${
            tab === "pending"
              ? "bg-white text-blue-600 shadow-sm"
              : "text-gray-500 hover:text-gray-700"
          }`}
        >
          <ClipboardCheck size={16} /> 결재 대기
        </button>
        <button
          onClick={() => setTab("history")}
          className={`flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg transition-all ${
            tab === "history"
              ? "bg-white text-blue-600 shadow-sm"
              : "text-gray-500 hover:text-gray-700"
          }`}
        >
          <CheckCircle size={16} /> 처리 완료
        </button>
      </div>

      {/* 본인 없음 / 로딩 / 목록 */}
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
      ) : loading ? (
        <div className="flex items-center justify-center h-32">
          <Loader2 size={24} className="animate-spin text-blue-500" />
          <span className="ml-2 text-sm text-gray-500">로딩 중...</span>
        </div>
      ) : approvals.length === 0 ? (
        <div className="bg-white rounded-2xl border border-gray-100 px-5 py-12 text-center text-sm text-gray-400 flex flex-col items-center gap-3">
          <ClipboardCheck size={24} className="text-gray-300" />
          {tab === "pending"
            ? "결재할 요청이 없습니다."
            : "처리한 결재 이력이 없습니다."}
        </div>
      ) : (
        <>
          {/* 카테고리 필터 — 출장 포함, 보이는 항목들에서 동적으로 추출 */}
          <CategoryFilterBar
            items={approvals}
            value={categoryFilter}
            onChange={setCategoryFilter}
          />

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {filteredApprovals.map((item) =>
              isTrip(item) ? (
                <TripApprovalCard
                  key={`trip-${item.tripEventId}`}
                  item={item}
                  tab={tab}
                  getStatusLabel={getStatusLabel}
                  statusBadge={statusBadge}
                  onOpen={() => setOpenTripItem(item)}
                />
              ) : (
                <ApprovalCard
                  key={`att-${item.id}`}
                  item={item}
                  tab={tab}
                  viewerRole={me?.role ?? null}
                  getStatusLabel={getStatusLabel}
                  statusBadge={statusBadge}
                  onApprove={() => handleApprove(item)}
                  onReject={() => openReject(item)}
                  calendarSources={calendarSources}
                  edited={editedCalendar[item.id]}
                  onEditCalendar={(field, value) =>
                    updateEditedCalendar(item.id, field, value)
                  }
                />
              )
            )}
          </div>

          <p className="text-xs text-gray-400 text-center pt-2">
            총 {filteredApprovals.length}건
            {filteredApprovals.length !== approvals.length &&
              ` / 전체 ${approvals.length}건`}
          </p>
        </>
      )}

      {/* 출장 결재 팝업 */}
      {openTripItem && (
        <TripApprovalModal
          item={openTripItem}
          tab={tab}
          onClose={() => setOpenTripItem(null)}
          onProcessed={() => {
            setOpenTripItem(null);
            fetchApprovals();
          }}
          showToast={showToast}
        />
      )}

      {/* 반려 모달 */}
      {rejectModal.item && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-bold text-gray-900 flex items-center gap-2">
                <XCircle size={20} className="text-rose-500" />
                결재 반려
              </h3>
              <button
                onClick={closeReject}
                className="text-gray-400 hover:text-gray-700"
              >
                <X size={18} />
              </button>
            </div>

            {/* 신청 정보 요약 */}
            <div className="bg-gray-50 rounded-xl p-3 space-y-1">
              <p className="text-sm">
                <span className="font-semibold text-gray-900">
                  {rejectModal.item.employeeName}
                </span>{" "}
                <span className="text-xs text-gray-400 font-mono">
                  ({rejectModal.item.employeeNo})
                </span>
              </p>
              <p className="text-sm text-gray-700">
                {rejectModal.item.categoryName} · {rejectModal.item.startDate}
                {rejectModal.item.endDate !== rejectModal.item.startDate &&
                  ` ~ ${rejectModal.item.endDate}`}
              </p>
            </div>

            <div>
              <label className="block text-xs font-semibold text-gray-500 mb-1">
                반려 사유 <span className="text-rose-500">*</span>
              </label>
              <textarea
                value={rejectModal.reason}
                onChange={(e) =>
                  setRejectModal((m) => ({ ...m, reason: e.target.value }))
                }
                rows={4}
                placeholder="신청자에게 표시됩니다"
                className="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-rose-400 resize-none"
              />
            </div>

            <div className="flex justify-end gap-2">
              <button
                onClick={closeReject}
                disabled={rejectModal.saving}
                className="px-4 py-2 text-sm font-medium text-gray-600 bg-gray-100 rounded-xl hover:bg-gray-200 disabled:opacity-60"
              >
                취소
              </button>
              <button
                onClick={handleRejectConfirm}
                disabled={rejectModal.saving}
                className="px-4 py-2 text-sm font-bold text-white bg-rose-500 rounded-xl hover:bg-rose-600 disabled:opacity-60"
              >
                {rejectModal.saving ? "처리 중..." : "반려 확정"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ===================== 카드 컴포넌트 =====================

interface ApprovalCardProps {
  item: ApprovalItem;
  tab: Tab;
  viewerRole: string | null;
  getStatusLabel: (code: string) => string;
  statusBadge: (code: string) => React.CSSProperties;
  onApprove: () => void;
  onReject: () => void;
  // Phase 6-2E 캘린더
  calendarSources: CalendarSourceOption[];
  edited: EditedCalendar | undefined;
  onEditCalendar: (
    field: keyof EditedCalendar,
    value: number | null | string
  ) => void;
}

function ApprovalCard({
  item,
  tab,
  viewerRole,
  getStatusLabel,
  statusBadge,
  onApprove,
  onReject,
  calendarSources,
  edited,
  onEditCalendar,
}: ApprovalCardProps) {
  // Phase 6-2J: ADMIN/CEO는 본인 신청도 결재 가능
  const isAdminOrCeo = viewerRole === "admin" || viewerRole === "ceo";
  const isPending = item.status === "pending";
  const isRejected = item.status === "rejected";
  const isHistory = tab === "history";

  return (
    <div className="bg-white rounded-2xl border border-gray-100 p-4 sm:p-5 hover:border-blue-200 transition-colors">
      {/* 신청자 */}
      <div className="flex items-center gap-2 text-xs text-gray-500 mb-2">
        <User size={12} className="text-gray-400" />
        <span className="font-semibold text-gray-700">{item.employeeName}</span>
        <span className="font-mono text-gray-400">({item.employeeNo})</span>
        {item.departmentName && (
          <>
            <span className="text-gray-300">·</span>
            <span>{item.departmentName}</span>
          </>
        )}
      </div>

      {/* 카테고리 + 상태 */}
      <div className="flex items-start justify-between gap-2 mb-3">
        <div className="flex items-center gap-2 min-w-0">
          {item.categoryColor && item.categoryColor.startsWith("#") && (
            <div
              className="w-3 h-3 rounded-full border border-gray-200 shrink-0"
              style={{ backgroundColor: item.categoryColor }}
            />
          )}
          <h3 className="text-base font-bold text-gray-900 truncate">
            {item.categoryName}
          </h3>
        </div>
        <span
          className="text-xs font-semibold px-2 py-0.5 rounded-full shrink-0"
          style={statusBadge(item.status)}
        >
          {getStatusLabel(item.status)}
        </span>
      </div>

      {/* 기간 */}
      <div className="flex items-center gap-2 text-sm text-gray-700 mb-2">
        <Calendar size={13} className="text-gray-400" />
        <span className="font-mono">
          {item.startDate}
          {item.endDate !== item.startDate && ` ~ ${item.endDate}`}
        </span>
      </div>

      {/* 사유 */}
      {item.reason && (
        <div className="flex items-start gap-2 text-sm text-gray-600 mb-2">
          <FileText size={13} className="text-gray-400 mt-0.5 shrink-0" />
          <span className="line-clamp-2">{item.reason}</span>
        </div>
      )}

      {/* 정정 시각 */}
      {item.categoryType === "correction" &&
        (item.correctedCheckIn || item.correctedCheckOut) && (
          <div className="flex items-center gap-2 text-xs text-gray-500 mb-2 font-mono">
            <Clock size={13} className="text-gray-400" />
            <span>
              정정: {formatDateTime(item.correctedCheckIn)}
              {item.correctedCheckOut &&
                ` ~ ${formatDateTime(item.correctedCheckOut)}`}
            </span>
          </div>
        )}

      {/* Phase 6-2J: 캘린더 등록 정보 — 다른 카드와 동일한 디자인 (둥근 모서리 + 일관 색감) */}
      {item.calendarSourceId !== null && (() => {
        const isEditable = item.status === "pending" && tab === "pending";
        return (
          <div className="mt-3 mb-3 bg-blue-50 border border-blue-100 rounded-xl p-3 sm:p-4">
            <div className="flex items-center gap-1.5 mb-2">
              <Calendar size={14} className="text-blue-600" />
              <h4 className="text-xs font-semibold text-blue-700">
                캘린더 등록 정보
                {isEditable && (
                  <span className="ml-1 font-normal text-blue-500/70">
                    (결재 시 수정 가능)
                  </span>
                )}
                {item.externalEventId && (
                  <span className="ml-1 font-normal text-emerald-600">
                    · ✓ 등록됨
                  </span>
                )}
              </h4>
            </div>

            <div className="space-y-2">
              {/* 캘린더 */}
              <div className="flex items-start gap-2">
                <label className="text-xs text-gray-600 w-12 shrink-0 pt-1">
                  캘린더
                </label>
                {isEditable ? (
                  <select
                    value={
                      edited?.sourceId !== undefined
                        ? edited.sourceId ?? ""
                        : item.calendarSourceId ?? ""
                    }
                    onChange={(e) =>
                      onEditCalendar(
                        "sourceId",
                        e.target.value ? Number(e.target.value) : null
                      )
                    }
                    className="flex-1 border border-gray-200 bg-white rounded-lg px-2 py-1 text-xs"
                  >
                    <option value="">— 등록 안 함 —</option>
                    {calendarSources.map((cs) => (
                      <option key={cs.id} value={cs.id}>
                        {cs.calendarName}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span className="flex-1 text-xs text-gray-700 pt-1">
                    {calendarSources.find(
                      (cs) => cs.id === item.calendarSourceId
                    )?.calendarName ?? "—"}
                  </span>
                )}
              </div>

              {/* 제목 */}
              <div className="flex items-start gap-2">
                <label className="text-xs text-gray-600 w-12 shrink-0 pt-1">
                  제목
                </label>
                {isEditable ? (
                  <input
                    type="text"
                    value={edited?.title ?? item.calendarEventTitle ?? ""}
                    onChange={(e) => onEditCalendar("title", e.target.value)}
                    className="flex-1 border border-gray-200 bg-white rounded-lg px-2 py-1 text-xs min-w-0"
                  />
                ) : (
                  <span className="flex-1 text-xs text-gray-700 pt-1 truncate">
                    {item.calendarEventTitle || "—"}
                  </span>
                )}
              </div>

              {/* 설명 */}
              <div className="flex items-start gap-2">
                <label className="text-xs text-gray-600 w-12 shrink-0 pt-1">
                  설명
                </label>
                {isEditable ? (
                  <textarea
                    value={
                      edited?.description ??
                      item.calendarEventDescription ??
                      ""
                    }
                    onChange={(e) =>
                      onEditCalendar("description", e.target.value)
                    }
                    rows={4}
                    className="flex-1 border border-gray-200 bg-white rounded-lg px-2 py-1.5 text-xs font-mono resize-none"
                  />
                ) : (
                  <pre className="flex-1 text-xs text-gray-700 whitespace-pre-wrap font-mono bg-white border border-gray-200 rounded-lg p-2">
                    {item.calendarEventDescription || "—"}
                  </pre>
                )}
              </div>
            </div>
          </div>
        );
      })()}

      {/* 본인 역할 (pending 탭에서만 의미 있음) */}
      {!isHistory && item.myRole && (
        <div className="mb-2 space-y-1">
          {item.myRole === "primary" ? (
            <span className="inline-flex items-center gap-1 text-xs font-semibold text-blue-700 bg-blue-50 px-2 py-0.5 rounded-full">
              <Shield size={11} />
              메인 결재자
            </span>
          ) : (
            <div className="flex items-center gap-2 flex-wrap">
              <span className="inline-flex items-center gap-1 text-xs font-semibold text-amber-700 bg-amber-50 px-2 py-0.5 rounded-full">
                <Shield size={11} />
                대리 결재자
              </span>
              {item.delegated ? (
                <span className="text-[10px] text-emerald-700 font-medium">
                  <CheckCircle
                    size={10}
                    className="inline mr-0.5 -translate-y-px"
                  />
                  메인 무응답 → 위임 가능
                </span>
              ) : (
                <span className="text-[10px] text-gray-500">
                  <Clock
                    size={10}
                    className="inline mr-0.5 -translate-y-px"
                  />
                  메인 응답 대기 ({item.hoursLeft.toFixed(1)}시간 남음)
                </span>
              )}
            </div>
          )}
          {/* Phase 6-2J: ADMIN/CEO는 본인 결재 허용 → 메시지 숨김 */}
          {item.isSelfRequest && !isAdminOrCeo && (
            <p className="text-[10px] text-gray-400">
              ⚠ 본인의 신청은 결재할 수 없습니다
            </p>
          )}
          {item.isSelfRequest && isAdminOrCeo && (
            <p className="text-[10px] text-amber-600">
              ⓘ 본인 신청 — 관리자 권한으로 결재 가능
            </p>
          )}
        </div>
      )}

      {/* 처리 완료 정보 (history 탭) */}
      {isHistory && item.approvedAt && (
        <div className="text-xs text-gray-500 mb-2">
          <CheckCircle
            size={11}
            className="inline mr-1 -translate-y-px text-emerald-500"
          />
          {new Date(item.approvedAt).toLocaleString("ko-KR")}에 처리
        </div>
      )}

      {/* 반려 사유 */}
      {isRejected && item.rejectReason && (
        <div className="bg-rose-50 border border-rose-200 rounded-xl px-3 py-2 text-xs text-rose-700 flex items-start gap-2 mb-2">
          <XCircle size={13} className="shrink-0 mt-0.5 text-rose-500" />
          <div>
            <p className="font-semibold">반려 사유</p>
            <p className="mt-0.5">{item.rejectReason}</p>
          </div>
        </div>
      )}

      {/* 신청 시각 + 액션 버튼 */}
      <div className="flex items-center justify-between pt-2 border-t border-gray-50">
        <p className="text-[10px] text-gray-400">
          신청: {new Date(item.requestedAt).toLocaleString("ko-KR")}
        </p>
        {isPending && item.canApprove && (
          <div className="flex gap-2">
            <button
              onClick={onApprove}
              className="flex items-center gap-1 px-3 py-1.5 text-xs font-bold text-white bg-emerald-500 rounded-lg hover:bg-emerald-600"
            >
              <CheckCircle size={13} />
              승인
            </button>
            <button
              onClick={onReject}
              className="flex items-center gap-1 px-3 py-1.5 text-xs font-bold text-white bg-rose-500 rounded-lg hover:bg-rose-600"
            >
              <XCircle size={13} />
              반려
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ===================== Phase 7 3단계: 카테고리 필터 바 =====================
function CategoryFilterBar({
  items,
  value,
  onChange,
}: {
  items: AnyApprovalItem[];
  value: string;
  onChange: (v: string) => void;
}) {
  // 보이는 항목들에서 등장한 categoryCode 모음 → 칩 버튼으로 노출
  const options = useMemo(() => {
    const seen = new Map<string, { code: string; name: string; color: string | null }>();
    for (const it of items) {
      if (!seen.has(it.categoryCode)) {
        seen.set(it.categoryCode, {
          code: it.categoryCode,
          name: it.categoryName,
          color: it.categoryColor ?? null,
        });
      }
    }
    return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name, "ko"));
  }, [items]);

  if (options.length <= 1) return null;

  return (
    <div className="flex items-center gap-2 flex-wrap text-sm">
      <span className="inline-flex items-center gap-1 text-xs text-gray-500 font-semibold">
        <Filter size={12} />
        카테고리
      </span>
      <button
        onClick={() => onChange("all")}
        className={`px-3 py-1 text-xs font-medium rounded-full border transition-colors ${
          value === "all"
            ? "bg-gray-900 text-white border-gray-900"
            : "bg-white text-gray-600 border-gray-200 hover:bg-gray-50"
        }`}
      >
        전체
      </button>
      {options.map((o) => {
        const selected = value === o.code;
        return (
          <button
            key={o.code}
            onClick={() => onChange(o.code)}
            className={`inline-flex items-center gap-1 px-3 py-1 text-xs font-medium rounded-full border transition-colors ${
              selected
                ? "bg-gray-900 text-white border-gray-900"
                : "bg-white text-gray-600 border-gray-200 hover:bg-gray-50"
            }`}
          >
            {o.color && o.color.startsWith("#") && (
              <span
                className="w-2 h-2 rounded-full border border-white/70"
                style={{ backgroundColor: o.color }}
              />
            )}
            {o.name}
          </button>
        );
      })}
    </div>
  );
}

// ===================== Phase 7 3단계: 출장 결재 카드 =====================
function TripApprovalCard({
  item,
  tab,
  getStatusLabel,
  statusBadge,
  onOpen,
}: {
  item: TripApprovalItem;
  tab: Tab;
  getStatusLabel: (code: string) => string;
  statusBadge: (code: string) => React.CSSProperties;
  onOpen: () => void;
}) {
  const isPending = item.status === "pending";
  return (
    <button
      onClick={onOpen}
      className="bg-white rounded-2xl border border-gray-100 p-4 sm:p-5 hover:border-blue-200 transition-colors text-left w-full"
    >
      {/* 카테고리(출장) + 상태 */}
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="flex items-center gap-2 min-w-0">
          {item.categoryColor && item.categoryColor.startsWith("#") && (
            <div
              className="w-3 h-3 rounded-full border border-gray-200 shrink-0"
              style={{ backgroundColor: item.categoryColor }}
            />
          )}
          <h3 className="text-base font-bold text-gray-900 truncate inline-flex items-center gap-1.5">
            <Plane size={14} className="text-amber-600 shrink-0" />
            {item.categoryName} — {item.eventName}
          </h3>
        </div>
        <span
          className="text-xs font-semibold px-2 py-0.5 rounded-full shrink-0"
          style={statusBadge(item.status)}
        >
          {getStatusLabel(item.status)}
        </span>
      </div>

      {/* 기간 */}
      <div className="flex items-center gap-2 text-sm text-gray-700 mb-1.5">
        <Calendar size={13} className="text-gray-400" />
        <span className="font-mono">
          {item.eventStartDate}
          {item.eventEndDate !== item.eventStartDate && ` ~ ${item.eventEndDate}`}
        </span>
      </div>

      {/* 장소 */}
      {item.location && (
        <div className="flex items-center gap-2 text-sm text-gray-600 mb-1.5">
          <MapPin size={13} className="text-gray-400" />
          <span className="truncate">{item.location}</span>
        </div>
      )}

      {/* 대기/처리 인원 + 액션 안내 */}
      <div className="flex items-center justify-between pt-2 border-t border-gray-50 mt-2">
        <span className="inline-flex items-center gap-1 text-xs text-amber-700 font-semibold">
          <UsersIcon size={12} />
          {isPending
            ? `대기 ${item.pendingCount}명`
            : `${tab === "history" ? "처리" : "대상"} ${item.pendingCount}명`}
        </span>
        <span className="text-[11px] text-blue-600 font-semibold">
          {isPending ? "결재 처리 →" : "상세 보기 →"}
        </span>
      </div>
    </button>
  );
}

// ===================== Phase 7 3단계: 출장 결재 팝업 =====================
function TripApprovalModal({
  item,
  tab,
  onClose,
  onProcessed,
  showToast,
}: {
  item: TripApprovalItem;
  tab: Tab;
  onClose: () => void;
  onProcessed: () => void;
  showToast: (msg: string) => void;
}) {
  const [selectedIds, setSelectedIds] = useState<Set<number>>(
    () => new Set(item.pendingParticipants.map((p) => p.participantId))
  );
  const [rejectReason, setRejectReason] = useState("");
  const [showRejectInput, setShowRejectInput] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const isPendingTab = tab === "pending" && item.status === "pending";

  // pending 참석자만 선택/처리 대상이 됨 (history 탭에선 readonly)
  const selectablePids = useMemo(
    () =>
      item.pendingParticipants
        .filter((p) => p.approvalStatus === "pending")
        .map((p) => p.participantId),
    [item]
  );

  const toggleAll = () => {
    if (selectedIds.size === selectablePids.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(selectablePids));
    }
  };
  const toggleOne = (pid: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(pid)) next.delete(pid);
      else next.add(pid);
      return next;
    });
  };

  const submit = async (action: "approve" | "reject") => {
    if (action === "reject" && !rejectReason.trim()) {
      alert("반려 사유를 입력하세요.");
      return;
    }
    if (selectedIds.size === 0) {
      alert("처리할 참석자를 선택하세요.");
      return;
    }
    if (
      action === "approve" &&
      !confirm(`선택된 ${selectedIds.size}명을 승인하시겠습니까?`)
    )
      return;

    setSubmitting(true);
    try {
      const res = await fetch(`/api/approvals`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "trip",
          tripEventId: item.tripEventId,
          action,
          rejectReason: action === "reject" ? rejectReason.trim() : undefined,
          participantIds: [...selectedIds],
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || `처리 실패 (${res.status})`);
        setSubmitting(false);
        return;
      }
      showToast(
        action === "approve"
          ? `✅ ${data.processedCount}명 승인되었습니다`
          : `✅ ${data.processedCount}명 반려되었습니다`
      );
      onProcessed();
    } catch (e) {
      console.error("trip approval PUT error:", e);
      alert("네트워크 오류");
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ backgroundColor: "rgba(0,0,0,0.4)" }}
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl p-5 sm:p-6 space-y-4 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-bold text-gray-900 flex items-center gap-2 truncate">
            <Plane size={18} className="text-amber-600" />
            <span className="truncate">출장 결재 — {item.eventName}</span>
          </h3>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400">
            <X size={18} />
          </button>
        </div>

        {/* 이벤트 정보 */}
        <div className="bg-gray-50 rounded-xl p-3 text-sm space-y-1">
          <div className="flex items-center gap-2 text-gray-700">
            <Calendar size={13} className="text-gray-400" />
            <span className="font-mono text-xs">
              {item.eventStartDate}
              {item.eventEndDate !== item.eventStartDate && ` ~ ${item.eventEndDate}`}
            </span>
          </div>
          {item.location && (
            <div className="flex items-center gap-2 text-gray-700">
              <MapPin size={13} className="text-gray-400" />
              {item.location}
            </div>
          )}
          {item.employeeName && (
            <div className="flex items-center gap-2 text-gray-500">
              <User size={13} className="text-gray-400" />
              <span className="text-xs">생성자: {item.employeeName}</span>
            </div>
          )}
        </div>

        {/* 참석자 목록 */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <h4 className="text-sm font-bold text-gray-700 flex items-center gap-1.5">
              <UsersIcon size={14} />
              {isPendingTab ? "결재 대상 참석자" : "처리된 참석자"} {item.pendingCount}명
            </h4>
            {isPendingTab && selectablePids.length > 0 && (
              <button
                onClick={toggleAll}
                className="text-xs text-blue-600 hover:text-blue-700 font-medium"
              >
                {selectedIds.size === selectablePids.length ? "전체 해제" : "전체 선택"}
              </button>
            )}
          </div>
          <div className="space-y-2 max-h-72 overflow-y-auto">
            {item.pendingParticipants.map((p) => {
              const checked = selectedIds.has(p.participantId);
              const isPending = p.approvalStatus === "pending";
              return (
                <div
                  key={p.participantId}
                  className="border border-gray-100 rounded-xl p-3 flex items-start gap-2"
                >
                  {isPendingTab && isPending && (
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleOne(p.participantId)}
                      className="mt-1"
                    />
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-semibold text-gray-900">
                        {p.employeeName}
                      </span>
                      {p.employeeNo && (
                        <span className="text-[10px] text-gray-400 font-mono">
                          {p.employeeNo}
                        </span>
                      )}
                      <span
                        className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${
                          p.approvalStatus === "pending"
                            ? "bg-amber-50 text-amber-700"
                            : p.approvalStatus === "approved"
                            ? "bg-emerald-50 text-emerald-700"
                            : "bg-rose-50 text-rose-700"
                        }`}
                      >
                        {p.approvalStatus === "pending"
                          ? "결재대기"
                          : p.approvalStatus === "approved"
                          ? "승인"
                          : "반려"}
                      </span>
                    </div>
                    {p.departmentName && (
                      <div className="text-xs text-gray-500 mt-0.5">
                        {p.departmentName}
                      </div>
                    )}
                    {p.dates.length > 0 && (
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {p.dates.map((d, idx) => (
                          <span
                            key={`${d.attendDate}-${idx}`}
                            className="text-[11px] font-mono bg-gray-50 text-gray-700 px-1.5 py-0.5 rounded"
                          >
                            {d.attendDate}
                            {d.startTime || d.endTime
                              ? ` ${d.startTime ?? "-"}~${d.endTime ?? "-"}`
                              : " 종일"}
                          </span>
                        ))}
                      </div>
                    )}
                    {p.rejectReason && (
                      <div className="mt-1.5 text-xs text-rose-600">
                        반려 사유: {p.rejectReason}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* 반려 사유 입력 */}
        {isPendingTab && showRejectInput && (
          <div>
            <label className="block text-xs font-semibold text-gray-500 mb-1">
              반려 사유 <span className="text-rose-500">*</span>
            </label>
            <textarea
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              rows={3}
              placeholder="선택된 참석자들에게 동일하게 적용됩니다"
              className="w-full px-3 py-2 border border-gray-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-rose-400 resize-none"
            />
          </div>
        )}

        <p className="text-[11px] text-gray-400 leading-relaxed border-t border-gray-100 pt-3">
          * 이번 단계에선 결재 처리(승인/반려)까지만 반영됩니다. 캘린더 등록·근태 반영은 다음 단계.
        </p>

        {/* 액션 버튼 */}
        <div className="flex justify-end gap-2 pt-2">
          <button
            onClick={onClose}
            disabled={submitting}
            className="px-4 py-2 text-sm font-medium text-gray-600 bg-gray-100 rounded-xl hover:bg-gray-200 disabled:opacity-50"
          >
            닫기
          </button>
          {isPendingTab &&
            (showRejectInput ? (
              <>
                <button
                  onClick={() => setShowRejectInput(false)}
                  disabled={submitting}
                  className="px-4 py-2 text-sm font-medium text-gray-600 bg-gray-100 rounded-xl hover:bg-gray-200 disabled:opacity-50"
                >
                  취소
                </button>
                <button
                  onClick={() => submit("reject")}
                  disabled={submitting || !rejectReason.trim() || selectedIds.size === 0}
                  className="px-4 py-2 text-sm font-bold text-white bg-rose-500 rounded-xl hover:bg-rose-600 disabled:opacity-50 inline-flex items-center gap-1.5"
                >
                  {submitting ? <Loader2 size={14} className="animate-spin" /> : <XCircle size={14} />}
                  반려 확정 ({selectedIds.size}명)
                </button>
              </>
            ) : (
              <>
                <button
                  onClick={() => setShowRejectInput(true)}
                  disabled={submitting || selectedIds.size === 0}
                  className="px-4 py-2 text-sm font-bold text-white bg-rose-500 rounded-xl hover:bg-rose-600 disabled:opacity-50 inline-flex items-center gap-1.5"
                >
                  <XCircle size={14} />
                  반려
                </button>
                <button
                  onClick={() => submit("approve")}
                  disabled={submitting || selectedIds.size === 0}
                  className="px-4 py-2 text-sm font-bold text-white bg-emerald-500 rounded-xl hover:bg-emerald-600 disabled:opacity-50 inline-flex items-center gap-1.5"
                >
                  {submitting ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle size={14} />}
                  승인 ({selectedIds.size}명)
                </button>
              </>
            ))}
        </div>
      </div>
    </div>
  );
}

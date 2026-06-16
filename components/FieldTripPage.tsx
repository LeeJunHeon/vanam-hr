"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import {
  Plane,
  Plus,
  Loader2,
  AlertCircle,
  MapPin,
  Calendar as CalendarIcon,
  User,
  Users as UsersIcon,
  X,
  Check,
  Trash2,
  Edit3,
  UserPlus,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { useCurrentEmployee } from "@/lib/useCurrentEmployee";
import TimePicker from "@/components/TimePicker";

// Phase 7 2단계: 출장 관리 페이지 — 이벤트 + 참석자(초대/self-join/수락/거절/날짜수정/제거).
// 결재 처리(approve/reject)와 캘린더/근태 반영은 3·4단계.

// ── 타입 ─────────────────────────────────────
interface TripEventListRow {
  id: number;
  name: string;
  location: string | null;
  description: string | null;
  startDate: string;
  endDate: string;
  status: string;
  createdById: number;
  createdByName: string | null;
  creatorIsAdmin: boolean;
  createdAt: string;
  participantCount: number;
  participantIds?: number[];
}

// 외근(EXTERNAL_WORK) attendance_request 1건 (GET /api/external-work)
interface ExternalRow {
  id: number;
  employeeId: number;
  employeeNo: string | null;
  employeeName: string | null;
  departmentName: string | null;
  categoryName: string | null;
  categoryColor: string | null;
  startDate: string;
  endDate: string;
  correctedCheckIn: string | null;
  correctedCheckOut: string | null;
  status: string;
  reason: string | null;
  requestedAt: string;
}

interface ParticipantDate {
  id: number;
  attendDate: string; // YYYY-MM-DD
  startTime: string | null; // HH:MM
  endTime: string | null;
  calendarEventId: string | null;
  attendanceRequestId: number | null;
}

interface Participant {
  id: number;
  employeeId: number;
  employeeName: string | null;
  employeeNo: string | null;
  departmentId: number | null;
  departmentName: string | null;
  inviteStatus: string; // invited/accepted/declined
  approvalStatus: string; // not_required/pending/approved/rejected
  approvedById: number | null;
  approvedByName: string | null;
  approvedAt: string | null;
  rejectReason: string | null;
  dates: ParticipantDate[];
}

interface TripEventDetail {
  id: number;
  name: string;
  location: string | null;
  description: string | null;
  startDate: string;
  endDate: string;
  status: string;
  createdById: number;
  createdByName: string | null;
  creatorIsAdmin: boolean;
  createdAt: string;
  participants: Participant[];
}

interface EmployeeOption {
  id: number;
  employeeNo: string | null;
  name: string;
  departmentName: string | null;
  isActive: boolean;
}

// ── 유틸 ─────────────────────────────────────
function pad2(n: number): string {
  return String(n).padStart(2, "0");
}
function todayYmd(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function formatDateRange(start: string, end: string): string {
  return start === end ? start : `${start} ~ ${end}`;
}
// "YYYY-MM-DD" 두 날짜 사이 모든 날짜 배열 (UTC 기준)
function enumerateDates(startYmd: string, endYmd: string): string[] {
  const out: string[] = [];
  const s = new Date(startYmd + "T00:00:00Z");
  const e = new Date(endYmd + "T00:00:00Z");
  if (isNaN(s.getTime()) || isNaN(e.getTime())) return out;
  const cur = new Date(s);
  while (cur.getTime() <= e.getTime()) {
    out.push(cur.toISOString().split("T")[0]);
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}
function weekdayLabel(ymd: string): string {
  const d = new Date(ymd + "T00:00:00Z");
  return ["일", "월", "화", "수", "목", "금", "토"][d.getUTCDay()];
}

// 상태 → 한글 + 색상 클래스
const INVITE_LABEL: Record<string, { label: string; cls: string }> = {
  invited: { label: "초대됨", cls: "bg-blue-50 text-blue-700" },
  accepted: { label: "수락", cls: "bg-emerald-50 text-emerald-700" },
  declined: { label: "거절", cls: "bg-gray-100 text-gray-500" },
};
const APPROVAL_LABEL: Record<string, { label: string; cls: string }> = {
  not_required: { label: "결재불요", cls: "bg-gray-100 text-gray-600" },
  pending: { label: "결재대기", cls: "bg-amber-50 text-amber-700" },
  approved: { label: "승인", cls: "bg-emerald-100 text-emerald-700" },
  rejected: { label: "반려", cls: "bg-rose-50 text-rose-700" },
};

// ── 페이지 본체 ──────────────────────────────
export default function FieldTripPage() {
  const { current, loading: empLoading } = useCurrentEmployee();
  const [events, setEvents] = useState<TripEventListRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [openEventId, setOpenEventId] = useState<number | null>(null);
  // 새 출장 생성 직후 "본인도 참여하시겠습니까?" → 예 → 이 state에 생성된 이벤트
  // 저장 후 self-join DatesModal을 띄운다.
  const [joinAfterCreate, setJoinAfterCreate] = useState<TripEventDetail | null>(null);
  // 출장 목록 탭: active=진행중·예정, history=취소·지난
  const [tab, setTab] = useState<"active" | "history">("active");
  // 캘린더 소스 마스터(생성 모달의 등록 캘린더 선택지)
  const [calendarSources, setCalendarSources] = useState<
    {
      id: number;
      calendarName: string;
      defaultCategoryId: number;
      categoryIds: number[];
    }[]
  >([]);
  // 외근 목록 + 직원 드롭다운 + 종류/사용자 필터
  const [externalItems, setExternalItems] = useState<ExternalRow[] | null>(null);
  const [employees, setEmployees] = useState<{ id: number; name: string }[]>([]);
  const [kindFilter, setKindFilter] = useState<"all" | "trip" | "external">(
    "all"
  );
  const [userFilter, setUserFilter] = useState<"all" | number>("all");

  // 캘린더 소스 1회 로드 (실패해도 본업 동작 — 생성 모달 선택지만 비게 됨)
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const sRes = await fetch("/api/calendar-sources");
        if (sRes.ok && !cancelled) {
          setCalendarSources(await sRes.json());
        }
      } catch (e) {
        console.error("trip-page calendar-sources fetch error:", e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // 오늘(KST) — endDate/startDate는 YYYY-MM-DD 문자열이라 사전순=날짜순 비교 가능.
  const today = todayYmd();

  // 종류(전체/출장/외근) + 사용자 필터 적용 후 active/history로 분류.
  const trips = events ?? [];
  const exts = externalItems ?? [];
  const tripActiveAll = (ev: TripEventListRow) =>
    ev.status === "active" && ev.endDate >= today;
  const extActiveAll = (x: ExternalRow) =>
    ["pending", "approved", "auto_approved"].includes(x.status) &&
    x.endDate >= today;
  const tripUser = (ev: TripEventListRow) =>
    userFilter === "all" ||
    ev.createdById === userFilter ||
    (ev.participantIds ?? []).includes(userFilter as number);
  const extUser = (x: ExternalRow) =>
    userFilter === "all" || x.employeeId === userFilter;
  const showTrips = kindFilter !== "external";
  const showExt = kindFilter !== "trip";
  const tripsActive = showTrips
    ? trips.filter((ev) => tripUser(ev) && tripActiveAll(ev))
    : [];
  const tripsHistory = showTrips
    ? trips.filter((ev) => tripUser(ev) && !tripActiveAll(ev))
    : [];
  const extsActive = showExt
    ? exts.filter((x) => extUser(x) && extActiveAll(x))
    : [];
  const extsHistory = showExt
    ? exts.filter((x) => extUser(x) && !extActiveAll(x))
    : [];
  const activeCount = tripsActive.length + extsActive.length;
  const historyCount = tripsHistory.length + extsHistory.length;
  const shownTrips = tab === "active" ? tripsActive : tripsHistory;
  const shownExts = tab === "active" ? extsActive : extsHistory;

  const fetchEvents = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/trip-events");
      if (res.ok) {
        setEvents(await res.json());
        setError(null);
      } else {
        const j = await res.json().catch(() => ({}));
        setError(j.error || "출장 이벤트를 불러올 수 없습니다.");
      }
    } catch (e) {
      console.error("trip-events fetch error:", e);
      setError("출장 이벤트를 불러올 수 없습니다.");
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchExternal = useCallback(async () => {
    try {
      const res = await fetch("/api/external-work");
      if (res.ok) setExternalItems(await res.json());
    } catch (e) {
      console.error("external-work fetch error:", e);
    }
  }, []);

  useEffect(() => {
    fetchEvents();
    fetchExternal();
  }, [fetchEvents, fetchExternal]);

  // 사용자 필터용 직원 목록 1회 로드 (활성만)
  useEffect(() => {
    (async () => {
      try {
        const r = await fetch("/api/employees");
        if (r.ok) {
          const d = await r.json();
          setEmployees(
            d
              .filter((e: { isActive: boolean }) => e.isActive)
              .map((e: { id: number; name: string }) => ({
                id: e.id,
                name: e.name,
              }))
          );
        }
      } catch {
        /* 직원 목록 실패해도 본업 동작 — 사용자 필터만 비게 됨 */
      }
    })();
  }, []);

  return (
    <div className="p-4 sm:p-6 space-y-5">
      {/* 헤더 */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold text-gray-900 flex items-center gap-2">
            <Plane size={22} className="text-blue-600" />
            출장/외근 관리
          </h1>
          <p className="text-sm text-gray-500 mt-0.5">
            학회/단체 출장 등 그룹 출장 이벤트를 생성하고 관리합니다.
          </p>
        </div>
        <button
          onClick={() => setCreateOpen(true)}
          disabled={empLoading || !current}
          className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-semibold text-white bg-blue-600 rounded-xl hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Plus size={16} />
          새 출장/외근 만들기
        </button>
      </div>

      {/* 본문 */}
      {error ? (
        <div className="bg-rose-50 text-rose-700 px-4 py-3 rounded-xl flex items-center gap-2">
          <AlertCircle size={16} />
          {error}
        </div>
      ) : loading && !events ? (
        <div className="flex items-center justify-center h-64">
          <Loader2 size={28} className="animate-spin text-blue-500" />
          <span className="ml-2 text-sm text-gray-500">로딩 중...</span>
        </div>
      ) : (
        <>
          {/* 필터 바: 종류(전체/출장/외근) + 사용자 드롭다운 */}
          <div className="flex flex-col sm:flex-row sm:items-center gap-2 justify-between">
            <div className="inline-flex rounded-xl border border-gray-200 overflow-hidden text-sm">
              {(
                [
                  ["all", "전체"],
                  ["trip", "출장"],
                  ["external", "외근"],
                ] as const
              ).map(([k, label]) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setKindFilter(k)}
                  className={`px-3 py-1.5 ${
                    kindFilter === k
                      ? "bg-blue-600 text-white font-semibold"
                      : "bg-white text-gray-600 hover:bg-gray-50"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            <select
              value={userFilter === "all" ? "all" : String(userFilter)}
              onChange={(e) =>
                setUserFilter(
                  e.target.value === "all" ? "all" : Number(e.target.value)
                )
              }
              className="px-3 py-1.5 text-sm border border-gray-200 rounded-xl bg-white"
            >
              <option value="all">전체 사용자</option>
              {employees.map((emp) => (
                <option key={emp.id} value={emp.id}>
                  {emp.name}
                </option>
              ))}
            </select>
          </div>

          {/* 탭: 활성/예정 vs 취소/지난 (카운트는 선택된 필터 기준) */}
          <div className="flex items-center gap-1 border-b border-gray-200">
            <button
              onClick={() => setTab("active")}
              className={`px-4 py-2 text-sm font-semibold border-b-2 -mb-px transition-colors ${
                tab === "active"
                  ? "border-blue-600 text-blue-600"
                  : "border-transparent text-gray-500 hover:text-gray-700"
              }`}
            >
              활성/예정 ({activeCount})
            </button>
            <button
              onClick={() => setTab("history")}
              className={`px-4 py-2 text-sm font-semibold border-b-2 -mb-px transition-colors ${
                tab === "history"
                  ? "border-blue-600 text-blue-600"
                  : "border-transparent text-gray-500 hover:text-gray-700"
              }`}
            >
              취소/지난 ({historyCount})
            </button>
          </div>

          {shownTrips.length === 0 && shownExts.length === 0 ? (
            <div className="bg-white rounded-2xl border border-gray-100 p-12 text-center text-sm text-gray-400 flex flex-col items-center gap-3">
              <Plane size={28} className="text-gray-300" />
              {tab === "active"
                ? "표시할 항목이 없습니다."
                : "취소되었거나 지난 항목이 없습니다."}
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3 sm:gap-4">
              {shownTrips.map((ev) => (
                <button
                  key={`t-${ev.id}`}
                  onClick={() => setOpenEventId(ev.id)}
                  className="text-left"
                >
                  <TripEventCard event={ev} today={today} />
                </button>
              ))}
              {shownExts.map((x) => (
                <ExternalWorkCard key={`e-${x.id}`} item={x} today={today} />
              ))}
            </div>
          )}
        </>
      )}

      {createOpen && (
        <CreateTripModal
          calendarSources={calendarSources}
          onClose={() => setCreateOpen(false)}
          onCreated={(created) => {
            setCreateOpen(false);
            fetchEvents();
            if (
              typeof window !== "undefined" &&
              window.confirm("본인도 이 출장에 참여하시겠습니까?")
            ) {
              setJoinAfterCreate(created);
            }
          }}
        />
      )}

      {openEventId !== null && (
        <TripDetailModal
          eventId={openEventId}
          currentEmployeeId={current?.id ?? null}
          onClose={() => setOpenEventId(null)}
          onMutated={fetchEvents}
        />
      )}

      {/* 생성 직후 self-join — TripDetailModal의 joinOpen과 동일 패턴 재사용 */}
      {joinAfterCreate && (
        <DatesModal
          title="나도 참여"
          submitLabel="참여"
          event={joinAfterCreate}
          initialDates={[]}
          requireAtLeastOne
          onClose={() => setJoinAfterCreate(null)}
          onSubmit={async (datesPayload) => {
            const res = await fetch(
              `/api/trip-events/${joinAfterCreate.id}/join`,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ dates: datesPayload }),
              }
            );
            if (!res.ok) {
              const j = await res.json().catch(() => ({}));
              return j.error || `참여 실패 (${res.status})`;
            }
            setJoinAfterCreate(null);
            fetchEvents();
            return null;
          }}
        />
      )}
    </div>
  );
}

// ── 카드 ─────────────────────────────────────
function TripEventCard({
  event,
  today,
}: {
  event: TripEventListRow;
  today: string; // YYYY-MM-DD (KST)
}) {
  // 상태 배지: closed=취소됨(회색), active이고 종료일이 오늘 이전=종료(회색),
  //            그 외(active && endDate >= today)=진행중(파랑)
  let badgeLabel: string;
  let badgeCls: string;
  if (event.status === "closed") {
    badgeLabel = "취소됨";
    badgeCls = "bg-gray-100 text-gray-600";
  } else if (event.status === "active" && event.endDate < today) {
    badgeLabel = "종료";
    badgeCls = "bg-gray-100 text-gray-500";
  } else {
    badgeLabel = "진행중";
    badgeCls = "bg-blue-100 text-blue-700";
  }
  return (
    <div className="bg-white rounded-2xl border border-gray-100 p-4 sm:p-5 hover:shadow-md hover:border-blue-200 transition-all">
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-base font-bold text-gray-900 truncate flex-1">
          {event.name}
        </h3>
        <span
          className={`text-[10px] font-semibold px-2 py-0.5 rounded-full shrink-0 ${badgeCls}`}
        >
          {badgeLabel}
        </span>
      </div>
      <div className="mt-3 space-y-1.5 text-sm">
        <div className="flex items-center gap-2 text-gray-600">
          <CalendarIcon size={14} className="text-gray-400 shrink-0" />
          <span className="font-mono text-xs">
            {formatDateRange(event.startDate, event.endDate)}
          </span>
        </div>
        {event.location && (
          <div className="flex items-center gap-2 text-gray-600">
            <MapPin size={14} className="text-gray-400 shrink-0" />
            <span className="truncate">{event.location}</span>
          </div>
        )}
        <div className="flex items-center gap-2 text-gray-500">
          <User size={14} className="text-gray-400 shrink-0" />
          <span className="text-xs truncate">
            생성자: {event.createdByName ?? `#${event.createdById}`}
          </span>
        </div>
        <div className="flex items-center gap-2 text-gray-500">
          <UsersIcon size={14} className="text-gray-400 shrink-0" />
          <span className="text-xs">참석자 {event.participantCount}명</span>
        </div>
      </div>
    </div>
  );
}

// ── 외근 카드 ─────────────────────────────────
function ExternalWorkCard({
  item,
  today,
}: {
  item: ExternalRow;
  today: string;
}) {
  let badgeLabel: string;
  let badgeCls: string;
  if (item.status === "cancelled") {
    badgeLabel = "취소됨";
    badgeCls = "bg-gray-100 text-gray-600";
  } else if (item.status === "rejected") {
    badgeLabel = "반려";
    badgeCls = "bg-rose-50 text-rose-700";
  } else if (item.endDate < today) {
    badgeLabel = "종료";
    badgeCls = "bg-gray-100 text-gray-500";
  } else if (item.status === "pending") {
    badgeLabel = "결재대기";
    badgeCls = "bg-amber-50 text-amber-700";
  } else {
    badgeLabel = "승인";
    badgeCls = "bg-emerald-100 text-emerald-700";
  }
  const hhmm = (iso: string | null) =>
    iso ? new Date(iso).toTimeString().slice(0, 5) : null;
  const ci = hhmm(item.correctedCheckIn);
  const co = hhmm(item.correctedCheckOut);
  const timeLabel = ci && co ? `${ci}~${co}` : "종일";
  return (
    <div className="bg-white rounded-2xl border border-gray-100 p-4 sm:p-5">
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-base font-bold text-gray-900 truncate flex-1">
          <span className="inline-flex items-center gap-1.5">
            <MapPin size={15} className="text-orange-500 shrink-0" />
            {item.employeeName ?? `#${item.employeeId}`}
          </span>
        </h3>
        <span
          className={`text-[10px] font-semibold px-2 py-0.5 rounded-full shrink-0 ${badgeCls}`}
        >
          {badgeLabel}
        </span>
      </div>
      <div className="mt-3 space-y-1.5 text-sm">
        <div className="flex items-center gap-2 text-gray-600">
          <CalendarIcon size={14} className="text-gray-400 shrink-0" />
          <span className="font-mono text-xs">
            {formatDateRange(item.startDate, item.endDate)} · {timeLabel}
          </span>
        </div>
        {item.departmentName && (
          <div className="flex items-center gap-2 text-gray-500">
            <UsersIcon size={14} className="text-gray-400 shrink-0" />
            <span className="text-xs truncate">{item.departmentName}</span>
          </div>
        )}
        <div className="flex items-center gap-2 text-gray-500">
          <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-orange-50 text-orange-600">
            외근
          </span>
          {item.reason && (
            <span className="text-xs text-gray-500 truncate">{item.reason}</span>
          )}
        </div>
      </div>
    </div>
  );
}

// ── 생성 모달 ────────────────────────────────
function CreateTripModal({
  onClose,
  onCreated,
  calendarSources,
}: {
  onClose: () => void;
  // 생성된 이벤트를 부모로 전달 — 생성 직후 self-join 모달에 그대로 넘기기 위함.
  // POST /api/trip-events 응답엔 participants가 없어 빈 배열로 보강해
  // TripEventDetail 형태로 맞춘다.
  onCreated: (created: TripEventDetail) => void;
  calendarSources: {
    id: number;
    calendarName: string;
    defaultCategoryId: number;
    categoryIds: number[];
  }[];
}) {
  const { current } = useCurrentEmployee();
  const [name, setName] = useState("");
  const [location, setLocation] = useState("");
  const [description, setDescription] = useState("");
  // 등록할 캘린더 선택 (Field Trip / External Meeting). Vacation(휴가)은 제외.
  const selectableCalendars = calendarSources.filter(
    (cs) => cs.calendarName !== "VanaM_Vacation"
  );
  const [calendarSourceId, setCalendarSourceId] = useState<number | null>(
    selectableCalendars[0]?.id ?? null
  );
  // 메모를 사용자가 직접 손댔는지 추적 — 손대기 전까지는 자동 헤더로 채워둔다.
  // (RequestPage 휴가/외근 autoDesc와 동일 형식)
  const [descTouched, setDescTouched] = useState(false);
  const [startDate, setStartDate] = useState(todayYmd());
  const [endDate, setEndDate] = useState(todayYmd());
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // 사용자가 메모를 수정하기 전까지 RequestPage 휴가/외근과 동일 형식으로 자동 채움.
  // 이벤트명과 무관(생성자/카테고리는 고정) — current 로드 시점에 1회 채워지면 충분.
  useEffect(() => {
    if (descTouched) return;
    const empName = current?.name ?? "-";
    const deptSuffix = current?.departmentName
      ? ` (${current.departmentName})`
      : "";
    const lines = [
      "[VanaM HR 자동 등록]",
      `신청자: ${empName}${deptSuffix}`,
      "카테고리: 출장 및 외근",
    ];
    setDescription(lines.join("\n"));
  }, [current, descTouched]);

  const canSubmit =
    name.trim().length > 0 &&
    /^\d{4}-\d{2}-\d{2}$/.test(startDate) &&
    /^\d{4}-\d{2}-\d{2}$/.test(endDate) &&
    startDate <= endDate &&
    !submitting;

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setErr(null);
    try {
      const res = await fetch("/api/trip-events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          location: location.trim() || undefined,
          description: description.trim() || undefined,
          startDate,
          endDate,
          calendarSourceId,
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setErr(j.error || `생성 실패 (${res.status})`);
        return;
      }
      // POST 응답엔 participants가 없으므로 빈 배열로 보강해 TripEventDetail 형태로
      const created = await res.json();
      onCreated({ ...created, participants: [] });
    } catch (e) {
      console.error("trip-events POST error:", e);
      setErr("출장 이벤트 생성 중 오류가 발생했습니다.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <ModalShell title="새 출장 만들기" icon={<Plane size={18} className="text-blue-600" />} onClose={onClose}>
      <div className="space-y-3">
        <Field label="출장명" required>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={200}
            placeholder="예: 2026 추계 학술대회"
            className="w-full px-3 py-2 text-sm border border-gray-200 rounded-xl focus:outline-none focus:border-blue-400"
          />
        </Field>
        {/* 캘린더 선택 — 어느 구글 캘린더에 등록할지 (출장/외근 통합) */}
        <Field label="등록 캘린더">
          <select
            value={calendarSourceId ?? ""}
            onChange={(e) => setCalendarSourceId(Number(e.target.value))}
            className="w-full px-3 py-2 text-sm border border-gray-200 rounded-xl focus:outline-none focus:border-blue-400"
          >
            {selectableCalendars.map((cs) => (
              <option key={cs.id} value={cs.id}>
                {cs.calendarName.replace(/^VanaM_/, "")}
              </option>
            ))}
          </select>
        </Field>
        <Field label="장소">
          <input
            type="text"
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            maxLength={200}
            placeholder="예: 부산 BEXCO"
            className="w-full px-3 py-2 text-sm border border-gray-200 rounded-xl focus:outline-none focus:border-blue-400"
          />
        </Field>
        <Field label="메모(설명)">
          <textarea
            value={description}
            onChange={(e) => {
              setDescTouched(true);
              setDescription(e.target.value);
            }}
            rows={3}
            placeholder="구글 캘린더 일정 설명에 표시됩니다"
            className="w-full px-3 py-2 text-sm border border-gray-200 rounded-xl focus:outline-none focus:border-blue-400 resize-none"
          />
          <p className="text-[10px] text-gray-400 mt-1">
            * 캘린더 일정 설명에 자동 안내 문구가 함께 표시됩니다.
          </p>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="시작일" required>
            <input
              type="date"
              value={startDate}
              onChange={(e) => {
                // 시작일이 기존 종료일보다 늦어지면 종료일도 새 시작일로 자동 보정
                // (RequestPage 휴가/외근 폼과 동일 패턴). YYYY-MM-DD는 사전순=날짜순.
                const v = e.target.value;
                setStartDate(v);
                setEndDate((prev) => (prev && prev < v ? v : prev));
              }}
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-xl focus:outline-none focus:border-blue-400 font-mono"
            />
          </Field>
          <Field label="종료일" required>
            <input
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              min={startDate}
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-xl focus:outline-none focus:border-blue-400 font-mono"
            />
          </Field>
        </div>
        {startDate > endDate && (
          <InlineError text="종료일은 시작일 이후여야 합니다." />
        )}
        <p className="text-[11px] text-gray-400 leading-relaxed">
          * 이벤트 생성 후 상세에서 참석자를 초대하거나 본인이 직접 참여할 수 있습니다.
        </p>
      </div>
      {err && <InlineError text={err} />}
      <ModalActions
        onClose={onClose}
        submitting={submitting}
        canSubmit={canSubmit}
        onSubmit={submit}
        submitLabel="생성"
        submitIcon={<Plus size={14} />}
      />
    </ModalShell>
  );
}

// ── 수정 모달 ────────────────────────────────
// 생성 모달과 동일한 폼 레이아웃(출장명/장소/메모/시작일/종료일).
// - 메모 자동 채움 useEffect는 사용하지 않음(기존 메모를 그대로 편집).
// - 시작일 onChange 시 종료일 자동 보정은 동일하게 유지.
// - PATCH 응답이 409면 j.error를 InlineError로 노출(기간 충돌 안내 그대로 표시).
function EditTripModal({
  event,
  onClose,
  onUpdated,
}: {
  event: TripEventDetail;
  onClose: () => void;
  onUpdated: () => void;
}) {
  const [name, setName] = useState(event.name);
  const [location, setLocation] = useState(event.location ?? "");
  const [description, setDescription] = useState(event.description ?? "");
  const [startDate, setStartDate] = useState(event.startDate);
  const [endDate, setEndDate] = useState(event.endDate);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const canSubmit =
    name.trim().length > 0 &&
    /^\d{4}-\d{2}-\d{2}$/.test(startDate) &&
    /^\d{4}-\d{2}-\d{2}$/.test(endDate) &&
    startDate <= endDate &&
    !submitting;

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setErr(null);
    try {
      const res = await fetch(`/api/trip-events/${event.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "update",
          name: name.trim(),
          location: location.trim() || undefined,
          description: description.trim() || undefined,
          startDate,
          endDate,
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setErr(j.error || `수정 실패 (${res.status})`);
        return;
      }
      onUpdated();
    } catch (e) {
      console.error("trip-events PATCH update error:", e);
      setErr("출장 이벤트 수정 중 오류가 발생했습니다.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <ModalShell
      title="출장 수정"
      icon={<Edit3 size={18} className="text-blue-600" />}
      onClose={onClose}
      nested
    >
      <div className="space-y-3">
        <Field label="출장명" required>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={200}
            placeholder="예: 2026 추계 학술대회"
            className="w-full px-3 py-2 text-sm border border-gray-200 rounded-xl focus:outline-none focus:border-blue-400"
          />
        </Field>
        <Field label="장소">
          <input
            type="text"
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            maxLength={200}
            placeholder="예: 부산 BEXCO"
            className="w-full px-3 py-2 text-sm border border-gray-200 rounded-xl focus:outline-none focus:border-blue-400"
          />
        </Field>
        <Field label="메모(설명)">
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            placeholder="구글 캘린더 일정 설명에 표시됩니다"
            className="w-full px-3 py-2 text-sm border border-gray-200 rounded-xl focus:outline-none focus:border-blue-400 resize-none"
          />
          <p className="text-[10px] text-gray-400 mt-1">
            * 캘린더 일정 설명에 그대로 반영됩니다.
          </p>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="시작일" required>
            <input
              type="date"
              value={startDate}
              onChange={(e) => {
                const v = e.target.value;
                setStartDate(v);
                setEndDate((prev) => (prev && prev < v ? v : prev));
              }}
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-xl focus:outline-none focus:border-blue-400 font-mono"
            />
          </Field>
          <Field label="종료일" required>
            <input
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              min={startDate}
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-xl focus:outline-none focus:border-blue-400 font-mono"
            />
          </Field>
        </div>
        {startDate > endDate && (
          <InlineError text="종료일은 시작일 이후여야 합니다." />
        )}
        <p className="text-[11px] text-gray-400 leading-relaxed">
          * 기간을 줄여 기존 참석자 날짜가 새 기간을 벗어나면 저장이 차단됩니다.
          해당 참석자의 날짜를 먼저 조정하거나 참석자를 제거한 뒤 다시 시도하세요.
        </p>
      </div>
      {err && <InlineError text={err} />}
      <ModalActions
        onClose={onClose}
        submitting={submitting}
        canSubmit={canSubmit}
        onSubmit={submit}
        submitLabel="수정 저장"
        submitIcon={<Edit3 size={14} />}
      />
    </ModalShell>
  );
}

// ── 상세 모달 ────────────────────────────────
function TripDetailModal({
  eventId,
  currentEmployeeId,
  onClose,
  onMutated,
}: {
  eventId: number;
  currentEmployeeId: number | null;
  onClose: () => void;
  onMutated: () => void;
}) {
  const { me } = useCurrentEmployee();
  const [detail, setDetail] = useState<TripEventDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [joinOpen, setJoinOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  // 본인 참석자 행에서 "수락" 또는 "날짜 변경" 모달 (어느 모드인지 표시)
  const [selfActionMode, setSelfActionMode] = useState<
    null | "accept" | "update"
  >(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/trip-events/${eventId}`);
      if (res.ok) {
        setDetail(await res.json());
        setErr(null);
      } else {
        const j = await res.json().catch(() => ({}));
        setErr(j.error || `조회 실패 (${res.status})`);
      }
    } catch (e) {
      console.error("trip-events detail fetch error:", e);
      setErr("이벤트 상세 조회 실패");
    } finally {
      setLoading(false);
    }
  }, [eventId]);

  useEffect(() => {
    reload();
  }, [reload]);

  // 현재 사용자의 participant row (있으면)
  const myParticipant = useMemo(
    () =>
      detail?.participants.find((p) => p.employeeId === currentEmployeeId) ??
      null,
    [detail, currentEmployeeId]
  );

  const isAdmin = me?.isAdmin || me?.isCeo;
  const isCreator = detail?.createdById === currentEmployeeId;

  const refreshAll = () => {
    reload();
    onMutated();
  };

  return (
    <ModalShell
      title={detail?.name ?? "출장 상세"}
      icon={<Plane size={18} className="text-blue-600" />}
      onClose={onClose}
      maxWidth="max-w-2xl"
    >
      {loading && !detail ? (
        <div className="flex items-center justify-center h-32">
          <Loader2 size={20} className="animate-spin text-blue-500" />
          <span className="ml-2 text-sm text-gray-500">로딩 중...</span>
        </div>
      ) : err ? (
        <InlineError text={err} />
      ) : !detail ? null : (
        <div className="space-y-4">
          {/* 이벤트 정보 */}
          <div className="bg-gray-50 rounded-xl p-3 sm:p-4 space-y-1.5 text-sm">
            <div className="flex items-center gap-2 text-gray-700">
              <CalendarIcon size={14} className="text-gray-400 shrink-0" />
              <span className="font-mono text-xs">
                {formatDateRange(detail.startDate, detail.endDate)}
              </span>
            </div>
            {detail.location && (
              <div className="flex items-center gap-2 text-gray-700">
                <MapPin size={14} className="text-gray-400 shrink-0" />
                <span>{detail.location}</span>
              </div>
            )}
            <div className="flex items-center gap-2 text-gray-500">
              <User size={14} className="text-gray-400 shrink-0" />
              <span className="text-xs">
                생성자: {detail.createdByName ?? `#${detail.createdById}`}
              </span>
            </div>
            {detail.description && detail.description.trim().length > 0 && (
              <div className="mt-1 text-xs text-gray-600 whitespace-pre-wrap bg-white border border-gray-100 rounded-lg p-2">
                {detail.description}
              </div>
            )}
          </div>

          {/* 액션 버튼 */}
          <div className="flex flex-wrap gap-2">
            {detail.status === "active" && (
              <button
                onClick={() => setInviteOpen(true)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-blue-700 bg-blue-50 rounded-xl hover:bg-blue-100"
              >
                <UserPlus size={14} />
                참석자 초대
              </button>
            )}
            {detail.status === "active" &&
              !myParticipant &&
              currentEmployeeId !== null && (
                <button
                  onClick={() => setJoinOpen(true)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-emerald-700 bg-emerald-50 rounded-xl hover:bg-emerald-100"
                >
                  <Check size={14} />
                  나도 참여
                </button>
              )}
            {/* 이벤트 수정(이름/장소/메모/기간) — 생성자 또는 admin/ceo, active일 때만 */}
            {detail.status === "active" && (isCreator || isAdmin) && (
              <button
                onClick={() => setEditOpen(true)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-gray-700 bg-gray-100 rounded-xl hover:bg-gray-200 ml-auto"
              >
                <Edit3 size={14} />
                수정
              </button>
            )}
            {/* Phase 7 4단계: 이벤트 취소(생성자 or admin/ceo, active일 때만).
                취소 시 미래 날짜의 캘린더·근태를 자동 정리(과거 보호). */}
            {detail.status === "active" && (isCreator || isAdmin) && (
              <button
                onClick={async () => {
                  if (
                    !confirm(
                      "이 이벤트를 취소하시겠습니까?\n" +
                        "- 오늘 이후 캘린더 일정 및 근태 반영이 삭제됩니다.\n" +
                        "- 과거 날짜는 그대로 보존됩니다."
                    )
                  )
                    return;
                  const res = await fetch(`/api/trip-events/${eventId}`, {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ action: "cancel" }),
                  });
                  if (!res.ok) {
                    const j = await res.json().catch(() => ({}));
                    alert(j.error || `취소 실패 (${res.status})`);
                    return;
                  }
                  refreshAll();
                }}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-rose-700 bg-rose-50 rounded-xl hover:bg-rose-100"
              >
                <X size={14} />
                이벤트 취소
              </button>
            )}
            {detail.status !== "active" && (
              <span className="text-xs text-gray-500 bg-gray-100 px-2 py-1 rounded-lg ml-auto">
                종료된 이벤트
              </span>
            )}
          </div>

          {/* 참석자 목록 */}
          <div>
            <h4 className="text-sm font-bold text-gray-700 mb-2 flex items-center gap-1.5">
              <UsersIcon size={14} />
              참석자 {detail.participants.length}명
            </h4>
            {detail.participants.length === 0 ? (
              <div className="text-xs text-gray-400 px-2 py-4 text-center bg-gray-50 rounded-xl">
                아직 참석자가 없습니다.
              </div>
            ) : (
              <div className="space-y-2">
                {detail.participants.map((p) => {
                  const isMe = p.employeeId === currentEmployeeId;
                  const canRemove = isMe || isCreator || isAdmin;
                  return (
                    <ParticipantRow
                      key={p.id}
                      p={p}
                      isMe={isMe}
                      canRemove={!!canRemove}
                      onAccept={() => setSelfActionMode("accept")}
                      onDecline={async () => {
                        if (!confirm("초대를 거절하시겠습니까?")) return;
                        await callPatch(p.id, { action: "decline" });
                        refreshAll();
                      }}
                      onUpdateDates={() => setSelfActionMode("update")}
                      onRemove={async () => {
                        if (
                          !confirm(
                            isMe
                              ? "본인 참석을 취소하시겠습니까?"
                              : "이 참석자를 제거하시겠습니까?"
                          )
                        )
                          return;
                        const res = await fetch(
                          `/api/trip-participants/${p.id}`,
                          { method: "DELETE" }
                        );
                        if (!res.ok) {
                          const j = await res.json().catch(() => ({}));
                          alert(j.error || `제거 실패 (${res.status})`);
                          return;
                        }
                        refreshAll();
                      }}
                    />
                  );
                })}
              </div>
            )}
          </div>

          <p className="text-[11px] text-gray-400 leading-relaxed border-t border-gray-100 pt-3">
            * 결재 처리(승인/반려)와 캘린더 등록은 다음 단계에서 추가될 예정입니다.
          </p>
        </div>
      )}

      {/* 하위 모달들 */}
      {detail && inviteOpen && (
        <InviteModal
          event={detail}
          // D-1: 초대 후보에서 (1) 본인(self-join이 따로 있음) (2) 이미 참석자인 직원 제외
          excludedEmployeeIds={
            new Set<number>([
              ...(currentEmployeeId !== null ? [currentEmployeeId] : []),
              ...detail.participants.map((p) => p.employeeId),
            ])
          }
          onClose={() => setInviteOpen(false)}
          onDone={() => {
            setInviteOpen(false);
            refreshAll();
          }}
        />
      )}
      {detail && joinOpen && (
        <DatesModal
          title="나도 참여"
          submitLabel="참여"
          event={detail}
          initialDates={[]}
          requireAtLeastOne
          onClose={() => setJoinOpen(false)}
          onSubmit={async (datesPayload) => {
            const res = await fetch(`/api/trip-events/${eventId}/join`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ dates: datesPayload }),
            });
            if (!res.ok) {
              const j = await res.json().catch(() => ({}));
              return j.error || `참여 실패 (${res.status})`;
            }
            setJoinOpen(false);
            refreshAll();
            return null;
          }}
        />
      )}
      {detail && myParticipant && selfActionMode && (
        <DatesModal
          title={selfActionMode === "accept" ? "초대 수락" : "날짜·시간 변경"}
          submitLabel={selfActionMode === "accept" ? "수락" : "저장"}
          event={detail}
          initialDates={myParticipant.dates}
          requireAtLeastOne
          warningText={
            selfActionMode === "update" &&
            myParticipant.approvalStatus === "approved"
              ? "이미 승인된 참석입니다. 날짜를 변경하면 결재가 다시 필요해집니다."
              : null
          }
          onClose={() => setSelfActionMode(null)}
          onSubmit={async (datesPayload) => {
            const res = await fetch(
              `/api/trip-participants/${myParticipant.id}`,
              {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  action:
                    selfActionMode === "accept" ? "accept" : "update_dates",
                  dates: datesPayload,
                }),
              }
            );
            if (!res.ok) {
              const j = await res.json().catch(() => ({}));
              return j.error || `저장 실패 (${res.status})`;
            }
            setSelfActionMode(null);
            refreshAll();
            return null;
          }}
        />
      )}
      {detail && editOpen && (
        <EditTripModal
          event={detail}
          onClose={() => setEditOpen(false)}
          onUpdated={() => {
            setEditOpen(false);
            refreshAll();
          }}
        />
      )}
    </ModalShell>
  );
}

// ── 참석자 행 ────────────────────────────────
function ParticipantRow({
  p,
  isMe,
  canRemove,
  onAccept,
  onDecline,
  onUpdateDates,
  onRemove,
}: {
  p: Participant;
  isMe: boolean;
  canRemove: boolean;
  onAccept: () => void;
  onDecline: () => void;
  onUpdateDates: () => void;
  onRemove: () => void;
}) {
  const inv = INVITE_LABEL[p.inviteStatus] ?? {
    label: p.inviteStatus,
    cls: "bg-gray-100 text-gray-500",
  };
  const apr = APPROVAL_LABEL[p.approvalStatus] ?? {
    label: p.approvalStatus,
    cls: "bg-gray-100 text-gray-500",
  };

  return (
    <div className="border border-gray-100 rounded-xl p-3 bg-white">
      <div className="flex items-start justify-between gap-2 flex-wrap">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold text-gray-900">
              {p.employeeName ?? `#${p.employeeId}`}
            </span>
            {isMe && (
              <span className="text-[10px] font-semibold bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded">
                나
              </span>
            )}
            <span
              className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${inv.cls}`}
            >
              {inv.label}
            </span>
            <span
              className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${apr.cls}`}
            >
              {apr.label}
            </span>
          </div>
          <div className="text-xs text-gray-500 mt-0.5">
            {p.departmentName ?? "-"}
            {p.employeeNo ? ` · ${p.employeeNo}` : ""}
          </div>
          {p.dates.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {p.dates.map((d) => (
                <span
                  key={d.id}
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
        </div>

        {/* 액션 버튼 영역 */}
        <div className="flex items-center gap-1 shrink-0">
          {isMe && p.inviteStatus === "invited" && (
            <>
              <button
                onClick={onAccept}
                className="p-1.5 rounded-lg hover:bg-emerald-50 text-emerald-600"
                title="수락"
              >
                <Check size={14} />
              </button>
              <button
                onClick={onDecline}
                className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-500"
                title="거절"
              >
                <X size={14} />
              </button>
            </>
          )}
          {isMe && p.inviteStatus === "declined" && (
            <button
              onClick={onAccept}
              className="p-1.5 rounded-lg hover:bg-emerald-50 text-emerald-600"
              title="다시 수락"
            >
              <Check size={14} />
            </button>
          )}
          {isMe && p.inviteStatus === "accepted" && (
            <button
              onClick={onUpdateDates}
              className="p-1.5 rounded-lg hover:bg-blue-50 text-blue-600"
              title="날짜·시간 변경"
            >
              <Edit3 size={14} />
            </button>
          )}
          {canRemove && (
            <button
              onClick={onRemove}
              className="p-1.5 rounded-lg hover:bg-rose-50 text-rose-500"
              title="제거"
            >
              <Trash2 size={14} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

async function callPatch(pid: number, body: Record<string, unknown>) {
  const res = await fetch(`/api/trip-participants/${pid}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    alert(j.error || `요청 실패 (${res.status})`);
  }
}

// ── 초대 모달 ────────────────────────────────
function InviteModal({
  event,
  excludedEmployeeIds,
  onClose,
  onDone,
}: {
  event: TripEventDetail;
  excludedEmployeeIds: Set<number>;
  onClose: () => void;
  onDone: () => void;
}) {
  const [employees, setEmployees] = useState<EmployeeOption[] | null>(null);
  const [selectedEmpId, setSelectedEmpId] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  // 초대 모달의 날짜 기본값 = 주최자(생성자)의 참가 일정 복사.
  // 주최자가 아직 참석자가 아니거나 dates가 없으면 빈 배열(기존과 동일).
  // 사용자가 수정/제거 가능, 비우고도 초대 가능(requireAtLeastOne=false).
  const [datesPayload, setDatesPayload] = useState<DatePayloadRow[]>(() => {
    const creator = event.participants.find(
      (p) => p.employeeId === event.createdById
    );
    const src = creator?.dates ?? [];
    return src.map((d) => ({
      attendDate: d.attendDate,
      startTime: d.startTime ?? "",
      endTime: d.endTime ?? "",
    }));
  });
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/employees");
        if (res.ok && !cancelled) {
          setEmployees(await res.json());
        }
      } catch (e) {
        console.error("employees fetch error:", e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const filtered = useMemo(() => {
    if (!employees) return [];
    const q = search.trim().toLowerCase();
    return employees
      .filter((e) => e.isActive && !excludedEmployeeIds.has(e.id))
      .filter((e) => {
        if (!q) return true;
        return (
          e.name.toLowerCase().includes(q) ||
          (e.departmentName ?? "").toLowerCase().includes(q) ||
          (e.employeeNo ?? "").toLowerCase().includes(q)
        );
      })
      .slice(0, 50);
  }, [employees, excludedEmployeeIds, search]);

  const submit = async () => {
    if (!selectedEmpId) {
      setErr("직원을 선택하세요.");
      return;
    }
    setSubmitting(true);
    setErr(null);
    try {
      const res = await fetch(
        `/api/trip-events/${event.id}/participants`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            employeeId: selectedEmpId,
            dates: datesPayload.length > 0 ? datesPayload : undefined,
          }),
        }
      );
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setErr(j.error || `초대 실패 (${res.status})`);
        return;
      }
      onDone();
    } catch (e) {
      console.error("invite POST error:", e);
      setErr("초대 중 오류가 발생했습니다.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <ModalShell
      title="참석자 초대"
      icon={<UserPlus size={18} className="text-blue-600" />}
      onClose={onClose}
      nested
    >
      <div className="space-y-4">
        <Field label="직원" required>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="이름/부서/사번 검색"
            className="w-full px-3 py-2 text-sm border border-gray-200 rounded-xl focus:outline-none focus:border-blue-400"
          />
          <div className="mt-2 max-h-40 overflow-y-auto border border-gray-100 rounded-xl divide-y divide-gray-50">
            {employees === null ? (
              <div className="px-3 py-3 text-xs text-gray-400 text-center">
                로딩 중...
              </div>
            ) : filtered.length === 0 ? (
              <div className="px-3 py-3 text-xs text-gray-400 text-center">
                결과가 없습니다.
              </div>
            ) : (
              filtered.map((e) => (
                <button
                  key={e.id}
                  type="button"
                  onClick={() => setSelectedEmpId(e.id)}
                  className={`w-full text-left px-3 py-2 text-sm transition-colors ${
                    selectedEmpId === e.id
                      ? "bg-blue-50"
                      : "hover:bg-gray-50"
                  }`}
                >
                  <div className="font-medium text-gray-900">
                    {e.name}
                    {e.employeeNo && (
                      <span className="ml-2 text-[11px] text-gray-400 font-mono">
                        {e.employeeNo}
                      </span>
                    )}
                  </div>
                  {e.departmentName && (
                    <div className="text-xs text-gray-500">
                      {e.departmentName}
                    </div>
                  )}
                </button>
              ))
            )}
          </div>
        </Field>

        <DatesPicker
          event={event}
          value={datesPayload}
          onChange={setDatesPayload}
          requireAtLeastOne={false}
          helpText="주최자 일정으로 기본 채워졌습니다. 날짜·시간을 수정하거나, 비우고 초대하면 참석자가 수락 시 직접 입력합니다."
        />
      </div>
      {err && <InlineError text={err} />}
      <ModalActions
        onClose={onClose}
        submitting={submitting}
        canSubmit={!!selectedEmpId && !submitting}
        onSubmit={submit}
        submitLabel="초대"
        submitIcon={<UserPlus size={14} />}
      />
    </ModalShell>
  );
}

// ── 날짜·시간 입력만 있는 모달 (join/accept/update_dates 공용) ──
function DatesModal({
  title,
  submitLabel,
  event,
  initialDates,
  requireAtLeastOne,
  warningText,
  onClose,
  onSubmit,
}: {
  title: string;
  submitLabel: string;
  event: TripEventDetail;
  initialDates: ParticipantDate[];
  requireAtLeastOne: boolean;
  warningText?: string | null;
  onClose: () => void;
  onSubmit: (datesPayload: ApiDatePayload[]) => Promise<string | null>;
}) {
  const [datesPayload, setDatesPayload] = useState<DatePayloadRow[]>(() =>
    initialDates.map((d) => ({
      attendDate: d.attendDate,
      startTime: d.startTime ?? "",
      endTime: d.endTime ?? "",
    }))
  );
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    if (requireAtLeastOne && datesPayload.length === 0) {
      setErr("참여 날짜를 1개 이상 선택하세요.");
      return;
    }
    setSubmitting(true);
    setErr(null);
    try {
      const payload = datesPayload.map((d) => ({
        attendDate: d.attendDate,
        startTime: d.startTime || undefined,
        endTime: d.endTime || undefined,
      }));
      const e = await onSubmit(payload);
      if (e) setErr(e);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <ModalShell title={title} onClose={onClose} nested>
      <DatesPicker
        event={event}
        value={datesPayload}
        onChange={setDatesPayload}
        requireAtLeastOne={requireAtLeastOne}
      />
      {warningText && (
        <div className="bg-amber-50 text-amber-700 text-xs px-3 py-2 rounded-xl flex items-start gap-2">
          <AlertCircle size={12} className="mt-0.5 shrink-0" />
          {warningText}
        </div>
      )}
      {err && <InlineError text={err} />}
      <ModalActions
        onClose={onClose}
        submitting={submitting}
        canSubmit={!submitting && (!requireAtLeastOne || datesPayload.length > 0)}
        onSubmit={submit}
        submitLabel={submitLabel}
      />
    </ModalShell>
  );
}

// ── 날짜·시간 선택 위젯 ──────────────────────
// UI 내부 상태(빈 문자열로 비어있음 표현)와 API payload(undefined로 비어있음 표현)를 분리.
interface DatePayloadRow {
  attendDate: string;
  startTime: string; // "" if blank
  endTime: string;
}
interface ApiDatePayload {
  attendDate: string;
  startTime?: string;
  endTime?: string;
}

// Phase 7 3단계 D-2: 미니 캘린더(월 그리드) + 선택 날짜 시간 입력 리스트.
// - 이벤트 기간 내 날짜만 클릭 가능(범위 밖은 비활성/회색).
// - 클릭 토글, 불연속 선택 가능.
// - 월 네비는 이벤트 기간을 포함하는 범위로 제한.
function DatesPicker({
  event,
  value,
  onChange,
  requireAtLeastOne,
  helpText,
}: {
  event: TripEventDetail;
  value: DatePayloadRow[];
  onChange: (v: DatePayloadRow[]) => void;
  requireAtLeastOne: boolean;
  helpText?: string;
}) {
  // 이벤트 기간 내 모든 YYYY-MM-DD (선택 가능 셀 판정용)
  const inRange = useMemo(() => {
    const set = new Set(enumerateDates(event.startDate, event.endDate));
    return set;
  }, [event.startDate, event.endDate]);

  // 선택된 항목 맵 + 정렬된 표시용 리스트
  const byDate = useMemo(() => {
    const m = new Map<string, DatePayloadRow>();
    for (const v of value) m.set(v.attendDate, v);
    return m;
  }, [value]);
  const sortedSelected = useMemo(
    () => [...value].sort((a, b) => a.attendDate.localeCompare(b.attendDate)),
    [value]
  );

  // 현재 보고 있는 월(YYYY-MM). 기본은 이벤트 시작월.
  const [viewYm, setViewYm] = useState(() => event.startDate.slice(0, 7));

  // 이벤트 시작/종료 월 (월 네비 범위 클램프용)
  const eventStartYm = event.startDate.slice(0, 7);
  const eventEndYm = event.endDate.slice(0, 7);
  const canPrev = viewYm > eventStartYm;
  const canNext = viewYm < eventEndYm;

  function shiftYm(ym: string, delta: number): string {
    const [y, m] = ym.split("-").map(Number);
    const d = new Date(y, m - 1 + delta, 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  }

  // 월 그리드 셀 배열 (leading blanks + days, 6주 패딩)
  const cells = useMemo(() => {
    const [yy, mm] = viewYm.split("-").map(Number);
    const firstDow = new Date(yy, mm - 1, 1).getDay(); // 0=일
    const lastDay = new Date(yy, mm, 0).getDate();
    const arr: ({ ymd: string; day: number; dow: number } | null)[] = [];
    for (let i = 0; i < firstDow; i++) arr.push(null);
    for (let d = 1; d <= lastDay; d++) {
      const ymd = `${yy}-${String(mm).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      arr.push({ ymd, day: d, dow: new Date(yy, mm - 1, d).getDay() });
    }
    while (arr.length % 7 !== 0) arr.push(null);
    return arr;
  }, [viewYm]);

  const toggle = (ymd: string) => {
    if (byDate.has(ymd)) {
      onChange(value.filter((v) => v.attendDate !== ymd));
    } else {
      onChange(
        [...value, { attendDate: ymd, startTime: "", endTime: "" }].sort(
          (a, b) => a.attendDate.localeCompare(b.attendDate)
        )
      );
    }
  };

  const updateTime = (
    ymd: string,
    field: "startTime" | "endTime",
    next: string
  ) => {
    onChange(value.map((v) => (v.attendDate === ymd ? { ...v, [field]: next } : v)));
  };

  const [headerYy, headerMm] = viewYm.split("-").map(Number);
  const DOW_HEADERS = ["일", "월", "화", "수", "목", "금", "토"] as const;

  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <label className="text-xs font-semibold text-gray-600">
          참여 날짜 {requireAtLeastOne && <span className="text-rose-500">*</span>}
        </label>
        <span className="text-[10px] text-gray-400">
          이벤트 기간: {formatDateRange(event.startDate, event.endDate)}
        </span>
      </div>

      {/* 미니 캘린더 */}
      <div className="border border-gray-100 rounded-xl p-3 bg-white">
        {/* 월 네비 */}
        <div className="flex items-center justify-between mb-2">
          <button
            type="button"
            onClick={() => canPrev && setViewYm(shiftYm(viewYm, -1))}
            disabled={!canPrev}
            className="p-1 rounded hover:bg-gray-100 text-gray-500 disabled:opacity-30 disabled:cursor-not-allowed"
            aria-label="이전 달"
          >
            <ChevronLeft size={14} />
          </button>
          <span className="text-sm font-semibold text-gray-900">
            {headerYy}년 {headerMm}월
          </span>
          <button
            type="button"
            onClick={() => canNext && setViewYm(shiftYm(viewYm, 1))}
            disabled={!canNext}
            className="p-1 rounded hover:bg-gray-100 text-gray-500 disabled:opacity-30 disabled:cursor-not-allowed"
            aria-label="다음 달"
          >
            <ChevronRight size={14} />
          </button>
        </div>

        {/* 요일 헤더 */}
        <div className="grid grid-cols-7 gap-1 mb-1">
          {DOW_HEADERS.map((h, i) => (
            <div
              key={h}
              className={`text-center text-[10px] font-semibold py-1 ${
                i === 0
                  ? "text-rose-400"
                  : i === 6
                  ? "text-blue-400"
                  : "text-gray-400"
              }`}
            >
              {h}
            </div>
          ))}
        </div>

        {/* 날짜 셀 */}
        <div className="grid grid-cols-7 gap-1">
          {cells.map((c, idx) => {
            if (c === null) {
              return <div key={`blank-${idx}`} className="h-9" />;
            }
            const isInRange = inRange.has(c.ymd);
            const isSelected = byDate.has(c.ymd);
            const baseColor =
              c.dow === 0
                ? "text-rose-500"
                : c.dow === 6
                ? "text-blue-500"
                : "text-gray-700";
            return (
              <button
                key={c.ymd}
                type="button"
                onClick={() => isInRange && toggle(c.ymd)}
                disabled={!isInRange}
                className={`h-9 rounded-lg text-xs font-semibold transition-colors ${
                  !isInRange
                    ? "text-gray-300 cursor-not-allowed bg-gray-50/60"
                    : isSelected
                    ? "bg-blue-500 text-white hover:bg-blue-600"
                    : `bg-white hover:bg-blue-50 border border-gray-100 ${baseColor}`
                }`}
                title={c.ymd}
              >
                {c.day}
              </button>
            );
          })}
        </div>
      </div>

      {/* 선택된 날짜 + 시간 입력 리스트 */}
      {sortedSelected.length > 0 && (
        <div className="mt-3 space-y-1.5">
          <div className="text-[11px] font-semibold text-gray-600">
            선택된 날짜 {sortedSelected.length}개 (시간 비우면 종일)
          </div>
          <div className="border border-gray-100 rounded-xl divide-y divide-gray-50 max-h-44 overflow-y-auto">
            {sortedSelected.map((row) => (
              <div
                key={row.attendDate}
                className="px-3 py-2 flex items-center gap-2 flex-wrap"
              >
                <span className="font-mono text-xs text-gray-700 min-w-[110px]">
                  {row.attendDate} ({weekdayLabel(row.attendDate)})
                </span>
                <div className="flex items-center gap-1 ml-auto">
                  <TimePicker
                    value={row.startTime}
                    onChange={(val) =>
                      updateTime(row.attendDate, "startTime", val)
                    }
                    placeholder="시작"
                    className="w-[120px]"
                  />
                  <span className="text-xs text-gray-400">~</span>
                  <TimePicker
                    value={row.endTime}
                    onChange={(val) =>
                      updateTime(row.attendDate, "endTime", val)
                    }
                    placeholder="종료"
                    className="w-[120px]"
                  />
                  <button
                    type="button"
                    onClick={() => toggle(row.attendDate)}
                    className="p-1 rounded hover:bg-rose-50 text-rose-400"
                    title="제거"
                  >
                    <X size={12} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <p className="text-[11px] text-gray-400 mt-2 leading-relaxed">
        {helpText ?? "캘린더에서 날짜를 클릭해 선택하세요. 시작/종료 시간은 선택사항(비우면 종일)."}
      </p>
    </div>
  );
}

// ── 작은 공용 UI ─────────────────────────────
function ModalShell({
  title,
  icon,
  onClose,
  children,
  maxWidth = "max-w-md",
  nested = false,
}: {
  title: string;
  icon?: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
  maxWidth?: string;
  nested?: boolean;
}) {
  return (
    <div
      className={`fixed inset-0 ${nested ? "z-[60]" : "z-50"} flex items-center justify-center p-4`}
      style={{ backgroundColor: "rgba(0,0,0,0.4)" }}
      onClick={onClose}
    >
      <div
        className={`bg-white rounded-2xl shadow-2xl w-full ${maxWidth} p-5 sm:p-6 space-y-4 max-h-[90vh] overflow-y-auto`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-bold text-gray-900 flex items-center gap-2 truncate">
            {icon}
            <span className="truncate">{title}</span>
          </h3>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 shrink-0"
          >
            <X size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="text-xs font-semibold text-gray-600 mb-1 block">
        {label} {required && <span className="text-rose-500">*</span>}
      </label>
      {children}
    </div>
  );
}

function InlineError({ text }: { text: string }) {
  return (
    <div className="bg-rose-50 text-rose-700 text-sm px-3 py-2 rounded-xl flex items-center gap-2">
      <AlertCircle size={14} />
      {text}
    </div>
  );
}

function ModalActions({
  onClose,
  submitting,
  canSubmit,
  onSubmit,
  submitLabel,
  submitIcon,
}: {
  onClose: () => void;
  submitting: boolean;
  canSubmit: boolean;
  onSubmit: () => void;
  submitLabel: string;
  submitIcon?: React.ReactNode;
}) {
  return (
    <div className="flex justify-end gap-2 pt-2 border-t border-gray-100">
      <button
        onClick={onClose}
        disabled={submitting}
        className="px-4 py-2 text-sm font-medium text-gray-600 bg-gray-100 rounded-xl hover:bg-gray-200 disabled:opacity-50"
      >
        취소
      </button>
      <button
        onClick={onSubmit}
        disabled={!canSubmit}
        className="px-4 py-2 text-sm font-bold text-white bg-blue-600 rounded-xl hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-1.5"
      >
        {submitting ? (
          <>
            <Loader2 size={14} className="animate-spin" />
            처리 중...
          </>
        ) : (
          <>
            {submitIcon}
            {submitLabel}
          </>
        )}
      </button>
    </div>
  );
}

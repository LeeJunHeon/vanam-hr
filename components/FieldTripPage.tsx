"use client";

import { useState, useEffect, useCallback } from "react";
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
} from "lucide-react";
import { useCurrentEmployee } from "@/lib/useCurrentEmployee";

// Phase 7 1단계: 출장 관리 페이지 — 이벤트 생성 + 목록만.
// 참석자/초대/결재/캘린더 연동은 다음 단계.

interface TripEvent {
  id: number;
  name: string;
  location: string | null;
  startDate: string; // YYYY-MM-DD
  endDate: string;
  status: string;
  createdById: number;
  createdByName: string | null;
  creatorIsAdmin: boolean;
  createdAt: string; // ISO
  participantCount: number;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function todayYmd(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function formatDateRange(start: string, end: string): string {
  if (start === end) return start;
  return `${start} ~ ${end}`;
}

export default function FieldTripPage() {
  const { current, loading: empLoading } = useCurrentEmployee();
  const [events, setEvents] = useState<TripEvent[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

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

  useEffect(() => {
    fetchEvents();
  }, [fetchEvents]);

  return (
    <div className="p-4 sm:p-6 space-y-5">
      {/* 헤더 */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold text-gray-900 flex items-center gap-2">
            <Plane size={22} className="text-blue-600" />
            출장 관리
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
          새 출장 만들기
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
      ) : events && events.length === 0 ? (
        <div className="bg-white rounded-2xl border border-gray-100 p-12 text-center text-sm text-gray-400 flex flex-col items-center gap-3">
          <Plane size={28} className="text-gray-300" />
          아직 등록된 출장 이벤트가 없습니다.
          <br />
          상단의 &quot;새 출장 만들기&quot; 버튼으로 첫 이벤트를 생성하세요.
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3 sm:gap-4">
          {(events ?? []).map((ev) => (
            <TripEventCard key={ev.id} event={ev} />
          ))}
        </div>
      )}

      {/* 생성 모달 */}
      {createOpen && (
        <CreateTripModal
          onClose={() => setCreateOpen(false)}
          onCreated={() => {
            setCreateOpen(false);
            fetchEvents();
          }}
        />
      )}
    </div>
  );
}

// ── 카드 ──────────────────────────────────────
function TripEventCard({ event }: { event: TripEvent }) {
  return (
    <div className="bg-white rounded-2xl border border-gray-100 p-4 sm:p-5 hover:shadow-md transition-shadow">
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-base font-bold text-gray-900 truncate flex-1">
          {event.name}
        </h3>
        <span className="text-[10px] font-semibold bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full shrink-0">
          {event.status === "active" ? "진행중" : event.status}
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

// ── 생성 모달 ──────────────────────────────────
function CreateTripModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [location, setLocation] = useState("");
  const [startDate, setStartDate] = useState(todayYmd());
  const [endDate, setEndDate] = useState(todayYmd());
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
      const res = await fetch("/api/trip-events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          location: location.trim() || undefined,
          startDate,
          endDate,
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setErr(j.error || `생성 실패 (${res.status})`);
        return;
      }
      onCreated();
    } catch (e) {
      console.error("trip-events POST error:", e);
      setErr("출장 이벤트 생성 중 오류가 발생했습니다.");
    } finally {
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
        className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-5 sm:p-6 space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-bold text-gray-900 flex items-center gap-2">
            <Plane size={18} className="text-blue-600" />새 출장 만들기
          </h3>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400"
          >
            <X size={18} />
          </button>
        </div>

        <div className="space-y-3">
          <div>
            <label className="text-xs font-semibold text-gray-600 mb-1 block">
              출장명 <span className="text-rose-500">*</span>
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={200}
              placeholder="예: 2026 추계 학술대회"
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-xl focus:outline-none focus:border-blue-400"
            />
          </div>

          <div>
            <label className="text-xs font-semibold text-gray-600 mb-1 block">
              장소
            </label>
            <input
              type="text"
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              maxLength={200}
              placeholder="예: 부산 BEXCO"
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-xl focus:outline-none focus:border-blue-400"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-semibold text-gray-600 mb-1 block">
                시작일 <span className="text-rose-500">*</span>
              </label>
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-xl focus:outline-none focus:border-blue-400 font-mono"
              />
            </div>
            <div>
              <label className="text-xs font-semibold text-gray-600 mb-1 block">
                종료일 <span className="text-rose-500">*</span>
              </label>
              <input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                min={startDate}
                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-xl focus:outline-none focus:border-blue-400 font-mono"
              />
            </div>
          </div>

          {startDate > endDate && (
            <div className="text-xs text-rose-600 flex items-center gap-1">
              <AlertCircle size={12} />
              종료일은 시작일 이후여야 합니다.
            </div>
          )}

          <p className="text-[11px] text-gray-400 leading-relaxed">
            * 이번 단계에서는 이벤트만 생성됩니다. 참석자 초대/결재 기능은 추후
            추가될 예정입니다.
          </p>
        </div>

        {err && (
          <div className="bg-rose-50 text-rose-700 text-sm px-3 py-2 rounded-xl flex items-center gap-2">
            <AlertCircle size={14} />
            {err}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2 border-t border-gray-100">
          <button
            onClick={onClose}
            disabled={submitting}
            className="px-4 py-2 text-sm font-medium text-gray-600 bg-gray-100 rounded-xl hover:bg-gray-200 disabled:opacity-50"
          >
            취소
          </button>
          <button
            onClick={submit}
            disabled={!canSubmit}
            className="px-4 py-2 text-sm font-bold text-white bg-blue-600 rounded-xl hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-1.5"
          >
            {submitting ? (
              <>
                <Loader2 size={14} className="animate-spin" />
                생성 중...
              </>
            ) : (
              <>
                <Plus size={14} />
                생성
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

"use client";

import { useState, useEffect, useCallback } from "react";
import { Loader2, Plane, MapPin, CalendarDays } from "lucide-react";
import TripReportModal, { type TripReportTarget } from "@/components/TripReportModal";
import Pagination from "@/components/Pagination";
import { useCurrentEmployee } from "@/lib/useCurrentEmployee";

interface MyTripRow extends TripReportTarget {
  report: { id: number; status: string; submittedAt: string | null } | null;
}

type FilterKey = "all" | "todo" | "done";

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: "all", label: "전체" },
  { key: "todo", label: "미제출" },
  { key: "done", label: "제출완료" },
];

// 보고서 상태 배지 — 미작성(rose) / 작성중(amber) / 제출완료(emerald)
function ReportBadge({ status }: { status: string | null }) {
  const meta =
    status === "submitted"
      ? { label: "제출완료", cls: "bg-emerald-100 text-emerald-700" }
      : status === "draft"
      ? { label: "작성중", cls: "bg-amber-50 text-amber-700" }
      : { label: "보고서 미작성", cls: "bg-rose-50 text-rose-700" };
  return (
    <span
      className={`shrink-0 text-[11px] font-semibold px-2 py-0.5 rounded-full ${meta.cls}`}
    >
      {meta.label}
    </span>
  );
}

function periodLabel(start: string | null, end: string | null): string {
  if (start && end) return start === end ? start : `${start} ~ ${end}`;
  return start ?? end ?? "-";
}

export default function MyTripsPage() {
  const { me } = useCurrentEmployee();
  const [rows, setRows] = useState<MyTripRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [filter, setFilter] = useState<FilterKey>("all");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [target, setTarget] = useState<MyTripRow | null>(null);

  // 필터/페이지 파라미터로만 재조회한다.
  // 로딩·데이터 상태는 절대 의존성에 넣지 않는다 (자기가 바꾼 상태로 재실행 → 무한로딩).
  const fetchRows = useCallback(async () => {
    const params = new URLSearchParams({
      status: filter === "todo" ? "missing" : filter === "done" ? "submitted" : "all",
      page: String(page),
      pageSize: String(pageSize),
    });
    setLoading(true);
    setLoadError("");
    try {
      const res = await fetch(`/api/my-trips?${params}`);
      const json = await res.json().catch(() => ({}));
      if (res.ok) {
        setRows(json.rows ?? []);
        setTotal(json.total ?? 0);
      } else {
        setLoadError(json.error ?? "출장 목록을 불러오지 못했습니다.");
      }
    } catch (e) {
      console.error("GET /api/my-trips error:", e);
      setLoadError("네트워크 오류로 출장 목록을 불러오지 못했습니다.");
    } finally {
      setLoading(false);
    }
  }, [filter, page, pageSize]);

  useEffect(() => {
    fetchRows();
  }, [fetchRows]);

  // 필터 변경은 항상 1페이지부터
  const changeFilter = (key: FilterKey) => {
    setFilter(key);
    setPage(1);
  };
  const changePageSize = (size: number) => {
    setPageSize(size);
    setPage(1);
  };

  return (
    <div className="p-4 sm:p-6 space-y-5">
      {/* 헤더 */}
      <div>
        <h1 className="text-xl sm:text-2xl font-bold text-gray-900">내 출장</h1>
        <p className="text-sm text-gray-500 mt-0.5">
          다녀온 출장/외근의 보고서를 작성합니다
          {filter === "todo" && total > 0 && (
            <span className="ml-1 text-rose-600 font-medium">
              · 미제출 {total}건
            </span>
          )}
        </p>
      </div>

      {/* 필터 칩 */}
      <div className="flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            onClick={() => changeFilter(f.key)}
            className={`px-3.5 py-1.5 rounded-full text-xs font-semibold transition-colors ${
              filter === f.key
                ? "bg-blue-500 text-white"
                : "bg-white border border-gray-200 text-gray-600 hover:bg-gray-50"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* 목록 */}
      {loading ? (
        <div className="flex items-center justify-center h-32">
          <Loader2 size={24} className="animate-spin text-blue-500" />
          <span className="ml-2 text-sm text-gray-500">로딩 중...</span>
        </div>
      ) : loadError ? (
        <div className="bg-white rounded-2xl border border-gray-100 px-5 py-12 text-center text-sm text-rose-600">
          {loadError}
        </div>
      ) : rows.length === 0 ? (
        <div className="bg-white rounded-2xl border border-gray-100 px-5 py-12 text-center">
          <Plane size={28} className="mx-auto text-gray-300 mb-2" />
          <p className="text-sm text-gray-400">
            {filter === "all"
              ? "보고서를 작성할 출장/외근이 없습니다"
              : "해당 조건의 출장이 없습니다"}
          </p>
        </div>
      ) : (
        <>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          {rows.map((r) => (
            <button
              key={`${r.kind}-${r.refId}`}
              onClick={() => setTarget(r)}
              className="text-left bg-white rounded-2xl border border-gray-100 p-4 hover:border-blue-200 hover:bg-blue-50/30 transition-colors"
            >
              <div className="flex items-start justify-between gap-2 mb-2">
                <div className="flex items-center gap-2 min-w-0">
                  <Plane size={15} className="text-gray-400 shrink-0" />
                  <span className="text-sm font-semibold text-gray-900 truncate">
                    {r.title}
                  </span>
                </div>
                <ReportBadge status={r.report?.status ?? null} />
              </div>
              <p className="text-xs text-gray-500 flex items-center gap-1.5">
                <CalendarDays size={12} className="text-gray-400 shrink-0" />
                {periodLabel(r.startDate, r.endDate)}
              </p>
              {r.location && (
                <p className="text-xs text-gray-500 flex items-center gap-1.5 mt-1">
                  <MapPin size={12} className="text-gray-400 shrink-0" />
                  <span className="truncate">{r.location}</span>
                </p>
              )}
              {r.kind === "trip" && r.myDates.length > 0 && (
                <p className="text-[11px] text-gray-400 mt-1.5">
                  내 참가일 {r.myDates.length}일
                </p>
              )}
            </button>
          ))}
        </div>
        <Pagination
          page={page}
          pageSize={pageSize}
          total={total}
          onPageChange={setPage}
          onPageSizeChange={changePageSize}
        />
        </>
      )}

      {target && (
        <TripReportModal
          target={target}
          employeeName={me?.name ?? ""}
          onClose={() => setTarget(null)}
          onSaved={fetchRows}
        />
      )}
    </div>
  );
}

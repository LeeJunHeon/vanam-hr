"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { Loader2, RefreshCw, CalendarDays } from "lucide-react";
import ScheduleCategoryModal from "@/components/ScheduleCategoryModal";

// API 응답 row 타입
interface ScheduleRow {
  id: number;
  employeeId: number;
  employeeNo: string;
  employeeName: string;
  departmentName: string | null;
  positionName: string | null;
  categoryCode: string | null;
  categoryName: string | null;
  categoryColor: string | null;
  startDate: string;
  endDate: string;
  correctedCheckIn: string | null;
  correctedCheckOut: string | null;
  reason: string | null;
  isAllDay: boolean;
  isMultiDay: boolean;
}

interface ScheduleResponse {
  date: string;
  total: number;
  holiday?: string | null;
  schedules: ScheduleRow[];
}

// 사람 단위 묶음 — 같은 직원이 같은 카테고리에 여러 일정을 올린 경우 1명으로
// 합치고, rows에 그 사람의 일정들을 누적한다.
interface PersonGroup {
  employeeId: number;
  employeeNo: string;
  employeeName: string;
  departmentName: string | null;
  positionName: string | null;
  rows: ScheduleRow[];
}

// 카테고리 그룹 정의 (사용자 결정 Q3, 표시 순서)
// FAMILY_EVENT는 아이콘 X (사용자 결정)
const CATEGORY_GROUPS = [
  {
    key: "leave",
    label: "휴가",
    icon: "🏖️",
    codes: ["ANNUAL", "HALF_AM", "HALF_PM"],
    color: "purple",
  },
  { key: "sick", label: "병가", icon: "🏥", codes: ["SICK"], color: "rose" },
  {
    key: "trip_external",
    label: "출장 및 외근",
    icon: "🌐",
    codes: ["BUSINESS_TRIP", "EXTERNAL_WORK"],
    color: "amber",
  },
  {
    key: "remote_work",
    label: "재택",
    icon: "🏠",
    codes: ["REMOTE_WORK"],
    color: "emerald",
  },
  {
    key: "family_event",
    label: "경조사",
    icon: "",
    codes: ["FAMILY_EVENT"],
    color: "indigo",
  },
  { key: "etc", label: "기타", icon: "📋", codes: ["ETC"], color: "gray" },
] as const;

// 카테고리 코드 → 그룹 key 매핑 (그 외 코드는 "etc"로 모음)
function getGroupKey(code: string | null): string {
  if (!code) return "etc";
  for (const g of CATEGORY_GROUPS) {
    if ((g.codes as readonly string[]).includes(code)) return g.key;
  }
  return "etc";
}

// 날짜 라벨 (예: "2026년 6월 1일 (월)")
function formatDateLabel(ymd: string): string {
  const d = new Date(`${ymd}T00:00:00`);
  const weekdays = ["일", "월", "화", "수", "목", "금", "토"];
  return `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일 (${
    weekdays[d.getDay()]
  })`;
}

// 카테고리 그룹별 Tailwind 색상 토큰 — inline style 없이 일관된 디자인
const COLOR_MAP: Record<
  string,
  { bg: string; border: string; text: string; pill: string }
> = {
  purple: {
    bg: "bg-purple-50",
    border: "border-purple-100",
    text: "text-purple-700",
    pill: "bg-purple-100 text-purple-700",
  },
  rose: {
    bg: "bg-rose-50",
    border: "border-rose-100",
    text: "text-rose-700",
    pill: "bg-rose-100 text-rose-700",
  },
  amber: {
    bg: "bg-amber-50",
    border: "border-amber-100",
    text: "text-amber-700",
    pill: "bg-amber-100 text-amber-700",
  },
  orange: {
    bg: "bg-orange-50",
    border: "border-orange-100",
    text: "text-orange-700",
    pill: "bg-orange-100 text-orange-700",
  },
  emerald: {
    bg: "bg-emerald-50",
    border: "border-emerald-100",
    text: "text-emerald-700",
    pill: "bg-emerald-100 text-emerald-700",
  },
  indigo: {
    bg: "bg-indigo-50",
    border: "border-indigo-100",
    text: "text-indigo-700",
    pill: "bg-indigo-100 text-indigo-700",
  },
  gray: {
    bg: "bg-gray-50",
    border: "border-gray-100",
    text: "text-gray-700",
    pill: "bg-gray-100 text-gray-700",
  },
};

export default function ScheduleOverviewPage() {
  const [data, setData] = useState<ScheduleResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Phase 6-2K-1: 카테고리 카드 클릭 → 모달 열기
  const [selectedGroup, setSelectedGroup] = useState<string | null>(null);

  // fetch (silent 옵션 — AttendanceOverviewPage 패턴 참고)
  const fetchSchedule = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const res = await fetch("/api/schedule/today");
      if (res.ok) {
        setData(await res.json());
        setError(null);
      } else if (res.status === 403) {
        setError("관리자 권한이 필요합니다.");
      } else {
        setError("일정을 불러올 수 없습니다.");
      }
    } catch (e) {
      console.error("schedule fetch error:", e);
      setError("일정을 불러올 수 없습니다.");
    } finally {
      setLoading(false);
    }
  }, []);

  // 첫 진입
  useEffect(() => {
    fetchSchedule();
  }, [fetchSchedule]);

  // 60초마다 자동 갱신 (탭이 visible일 때만) + 탭 복귀 시 즉시 갱신
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") {
        fetchSchedule(true);
      }
    }, 60000);
    const onVisible = () => {
      if (document.visibilityState === "visible") fetchSchedule(true);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [fetchSchedule]);

  // 그룹별로 schedules 분배 — 사람 단위(employeeId)로 묶고 rows에 일정 누적.
  // 같은 사람이 같은 카테고리에 일정을 여러 건 올려도 1명으로 카운트되고,
  // 모달에서 일정별 상세를 보여줄 수 있도록 원본 row를 보관한다.
  const groupedSchedules = useMemo(() => {
    const result: Record<string, PersonGroup[]> = {};
    const idx: Record<string, Map<number, PersonGroup>> = {};
    for (const g of CATEGORY_GROUPS) {
      result[g.key] = [];
      idx[g.key] = new Map();
    }
    if (data) {
      for (const row of data.schedules) {
        const key = getGroupKey(row.categoryCode);
        if (!result[key]) continue;
        let pg = idx[key].get(row.employeeId);
        if (!pg) {
          pg = {
            employeeId: row.employeeId,
            employeeNo: row.employeeNo,
            employeeName: row.employeeName,
            departmentName: row.departmentName,
            positionName: row.positionName,
            rows: [],
          };
          idx[key].set(row.employeeId, pg);
          result[key].push(pg);
        }
        pg.rows.push(row);
      }
    }
    return result;
  }, [data]);

  // 상단 "오늘 총 부재/외근 인원" — data.total(=일정 건수)이 아니라 distinct 인원수
  const totalPeople = useMemo(
    () =>
      data ? new Set(data.schedules.map((s) => s.employeeId)).size : 0,
    [data]
  );

  if (loading && !data) {
    return (
      <div className="p-4 sm:p-6">
        <div className="flex items-center justify-center h-64">
          <Loader2 className="animate-spin text-blue-500" size={32} />
          <span className="ml-3 text-gray-500">일정을 불러오는 중...</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4 sm:p-6">
        <div className="bg-rose-50 text-rose-700 px-4 py-3 rounded-xl">
          {error}
        </div>
      </div>
    );
  }

  if (!data) return null;

  return (
    <div className="p-4 sm:p-6 space-y-4 sm:space-y-6">
      {/* ─── 헤더 ─── */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg sm:text-xl font-bold text-gray-900 flex items-center gap-2 flex-wrap">
            <CalendarDays size={22} className="text-blue-600" />
            오늘의 일정
            {/* Phase 6-2L+ B-4: 오늘이 공휴일이면 라벨 */}
            {data.holiday && (
              <span className="text-xs font-semibold bg-rose-100 text-rose-700 px-2 py-0.5 rounded-full">
                🎌 {data.holiday}
              </span>
            )}
          </h2>
          <p className="text-sm text-gray-500 mt-1">
            {formatDateLabel(data.date)}
          </p>
        </div>
        <button
          onClick={() => fetchSchedule(false)}
          className="text-xs text-gray-500 hover:text-gray-700 flex items-center gap-1 px-2 py-1 rounded"
        >
          <RefreshCw size={14} />
          새로고침
        </button>
      </div>

      {/* ─── 통계 카드 ─── */}
      <div className="bg-blue-50 rounded-2xl border border-blue-100 p-4 sm:p-5">
        <p className="text-xs font-semibold text-blue-700 uppercase tracking-wide mb-2">
          오늘 총 부재/외근 인원
        </p>
        <p className="text-2xl sm:text-3xl font-bold text-blue-700 font-mono">
          {totalPeople}
          <span className="text-base font-medium text-blue-600">명</span>
        </p>
        <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-xs text-blue-700/80">
          {CATEGORY_GROUPS.map((g) => (
            <span key={g.key}>
              {g.icon && <span>{g.icon} </span>}
              {g.label} {groupedSchedules[g.key]?.length ?? 0}
            </span>
          ))}
        </div>
      </div>

      {/* ─── Phase 6-2K-1: 카테고리별 작은 카드 그리드 (7개, 항상 표시) ─── */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-7 gap-3">
        {CATEGORY_GROUPS.map((group) => {
          const items = groupedSchedules[group.key] ?? [];
          const c = COLOR_MAP[group.color] ?? COLOR_MAP.gray;
          const hasItems = items.length > 0;

          return (
            <button
              key={group.key}
              onClick={() => hasItems && setSelectedGroup(group.key)}
              disabled={!hasItems}
              className={`${c.bg} border ${c.border} rounded-2xl p-3 sm:p-4 text-left transition-all ${
                hasItems
                  ? "hover:shadow-md hover:scale-[1.02] cursor-pointer"
                  : "opacity-70 cursor-default"
              }`}
            >
              {/* 헤더: 아이콘 + 인원수 pill */}
              <div className="flex items-center justify-between mb-2">
                <span className="text-2xl">{group.icon || "•"}</span>
                <span
                  className={`${c.pill} text-xs font-bold px-2 py-0.5 rounded-full`}
                >
                  {items.length}명
                </span>
              </div>

              {/* 카테고리 라벨 */}
              <h3 className={`text-sm font-bold ${c.text}`}>{group.label}</h3>

              {/* 미리보기 — 최대 3명 이름 (사람당 일정이 여러 건이면 "(N건)" 표시) */}
              {hasItems ? (
                <div className="mt-2 space-y-0.5">
                  {items.slice(0, 3).map((pg) => (
                    <p
                      key={pg.employeeId}
                      className="text-xs text-gray-600 truncate"
                    >
                      {pg.employeeName}
                      {pg.rows.length > 1 ? ` (${pg.rows.length}건)` : ""}
                    </p>
                  ))}
                  {items.length > 3 && (
                    <p className="text-xs text-gray-400">
                      +{items.length - 3}명 더
                    </p>
                  )}
                </div>
              ) : (
                <p className="text-xs text-gray-400 mt-2">없음</p>
              )}
            </button>
          );
        })}
      </div>

      {/* 카테고리 카드 클릭 → 직원 상세 모달 */}
      {selectedGroup &&
        (() => {
          const group = CATEGORY_GROUPS.find((g) => g.key === selectedGroup);
          if (!group) return null;
          return (
            <ScheduleCategoryModal
              group={group}
              items={groupedSchedules[selectedGroup] ?? []}
              onClose={() => setSelectedGroup(null)}
            />
          );
        })()}
    </div>
  );
}

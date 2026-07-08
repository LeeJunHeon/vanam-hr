"use client";

import { useState, useEffect, useCallback } from "react";
import { Loader2, Search, ChevronDown, ChevronRight } from "lucide-react";

// GET /api/annual-leave/grants 의 employees 배열 원소
interface GrantRow {
  employeeId: number;
  name: string;
  employeeNo: string | null;
  departmentName: string | null;
  positionName: string | null;
  hiredAt: string | null;
  grantedDays: number;
  autoGrantedDays: number;
  initialUsedDays: number;
  systemUsedDays: number;
  remainingDays: number;
  hasGrantRow: boolean;
}

interface DetailItem {
  startDate: string;
  endDate: string;
  categoryName: string | null;
  usedDays: number;
}

interface DetailResp {
  employeeId: number;
  year: number;
  totalUsed: number;
  items: DetailItem[];
}

// HR 시스템 도입 연도. 이 이전 연도는 데이터가 없어 연도 선택에 노출하지 않는다.
const SYSTEM_START_YEAR = 2026;

// 정수면 그대로, 아니면 소수 1자리 (반차 0.5 단위 대응)
function fmtNum(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

// 같은 날이면 하루만, 다르면 범위로
function dateRangeLabel(start: string, end: string): string {
  return start === end ? start : `${start} ~ ${end}`;
}

// 우측 stat chip (EmployeeAnnualLeaveModal 3칩 색감 참고)
function StatChip({
  label,
  value,
  bg,
  color,
}: {
  label: string;
  value: string;
  bg: string;
  color: string;
}) {
  return (
    <div className={`${bg} rounded-lg px-3 py-1.5 text-center min-w-[60px]`}>
      <div className="text-[10px] text-gray-500">{label}</div>
      <div className={`text-sm font-bold ${color}`}>{value}</div>
    </div>
  );
}

export default function AnnualLeavePage() {
  const thisYear = new Date().getFullYear();
  const [year, setYear] = useState<number>(thisYear);
  const [search, setSearch] = useState("");
  const [rows, setRows] = useState<GrantRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [detailMap, setDetailMap] = useState<Record<number, DetailResp>>({});
  const [detailLoading, setDetailLoading] = useState<number | null>(null);

  const fetchGrants = useCallback(async () => {
    setLoading(true);
    setError("");
    // 연도 전환 시 이전 연도 펼침/캐시 초기화 (데이터 섞임 방지)
    setExpandedId(null);
    setDetailMap({});
    try {
      const res = await fetch(`/api/annual-leave/grants?year=${year}`);
      if (res.ok) {
        const data = await res.json();
        setRows(data.employees ?? []);
      } else {
        setError("연차 목록을 불러오지 못했습니다.");
        setRows([]);
      }
    } catch (e) {
      console.error("GET /api/annual-leave/grants error:", e);
      setError("네트워크 오류로 연차 목록을 불러오지 못했습니다.");
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [year]);

  useEffect(() => {
    fetchGrants();
  }, [fetchGrants]);

  const toggle = async (id: number) => {
    if (expandedId === id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(id);
    if (!detailMap[id]) {
      setDetailLoading(id);
      try {
        const res = await fetch(
          `/api/annual-leave/detail?employeeId=${id}&year=${year}`
        );
        if (res.ok) {
          const data: DetailResp = await res.json();
          setDetailMap((prev) => ({ ...prev, [id]: data }));
        }
      } catch (e) {
        console.error("GET /api/annual-leave/detail error:", e);
      } finally {
        setDetailLoading(null);
      }
    }
  };

  const q = search.trim().toLowerCase();
  const filtered = q
    ? rows.filter(
        (r) =>
          r.name.toLowerCase().includes(q) ||
          (r.departmentName ?? "").toLowerCase().includes(q)
      )
    : rows;

  const years: number[] = [];
  for (let y = thisYear; y >= SYSTEM_START_YEAR; y--) years.push(y);

  return (
    <div className="p-4 sm:p-6 space-y-5">
      {/* 헤더 */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold text-gray-900">연차 관리</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            전 재직자의 연차 부여·사용·잔여 현황
          </p>
        </div>
        <div className="flex items-center gap-2">
          {years.length > 1 ? (
            <select
              value={year}
              onChange={(e) => setYear(Number(e.target.value))}
              className="px-3 py-2.5 border border-gray-200 rounded-xl text-sm bg-white outline-none focus:ring-2 focus:ring-blue-500"
            >
              {years.map((y) => (
                <option key={y} value={y}>
                  {y}년
                </option>
              ))}
            </select>
          ) : (
            <div className="px-3 py-2.5 text-sm font-medium text-gray-700">
              {thisYear}년
            </div>
          )}
          <div className="relative">
            <Search
              size={16}
              className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-400"
            />
            <input
              type="text"
              placeholder="이름/부서 검색"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full sm:w-56 pl-10 pr-4 py-2.5 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-blue-500 outline-none"
            />
          </div>
        </div>
      </div>

      {/* 목록 */}
      {loading ? (
        <div className="flex items-center justify-center h-32">
          <Loader2 size={24} className="animate-spin text-blue-500" />
          <span className="ml-2 text-sm text-gray-500">로딩 중...</span>
        </div>
      ) : error ? (
        <div className="bg-white rounded-2xl border border-gray-100 p-8 text-center text-sm text-rose-600">
          {error}
        </div>
      ) : filtered.length === 0 ? (
        <div className="bg-white rounded-2xl border border-gray-100 p-8 text-center text-sm text-gray-400">
          표시할 직원이 없습니다
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map((r) => {
            const used = r.initialUsedDays + r.systemUsedDays;
            const expanded = expandedId === r.employeeId;
            const detail = detailMap[r.employeeId];
            const isDetailLoading = detailLoading === r.employeeId;
            return (
              <div
                key={r.employeeId}
                className="bg-white rounded-xl border border-gray-100 overflow-hidden"
              >
                <button
                  onClick={() => toggle(r.employeeId)}
                  className="w-full flex items-center justify-between gap-3 p-4 text-left hover:bg-gray-50 transition-colors"
                >
                  {/* 좌: 이름 + 부서 */}
                  <div className="flex items-center gap-2 min-w-0">
                    {expanded ? (
                      <ChevronDown size={16} className="text-gray-400 shrink-0" />
                    ) : (
                      <ChevronRight size={16} className="text-gray-400 shrink-0" />
                    )}
                    <div className="min-w-0">
                      <div className="text-sm font-semibold text-gray-900 truncate">
                        {r.name}
                      </div>
                      <div className="text-xs text-gray-400 truncate">
                        {[r.departmentName, r.positionName].filter(Boolean).join(" · ") || "부서/직급 없음"}
                      </div>
                    </div>
                  </div>
                  {/* 우: 부여/사용/잔여 칩 */}
                  <div className="flex flex-wrap items-center justify-end gap-2 shrink-0">
                    <StatChip
                      label="부여"
                      value={fmtNum(r.grantedDays)}
                      bg="bg-blue-50"
                      color="text-blue-700"
                    />
                    <StatChip
                      label="사용"
                      value={fmtNum(used)}
                      bg="bg-gray-50"
                      color="text-gray-700"
                    />
                    <StatChip
                      label="잔여"
                      value={fmtNum(r.remainingDays)}
                      bg="bg-emerald-50"
                      color={
                        r.remainingDays < 0 ? "text-rose-600" : "text-emerald-700"
                      }
                    />
                  </div>
                </button>

                {/* 펼친 영역: 사용 내역 */}
                {expanded && (
                  <div className="border-t border-gray-100 px-4 py-3 bg-gray-50/50">
                    {isDetailLoading ? (
                      <div className="flex items-center justify-center py-4">
                        <Loader2 size={18} className="animate-spin text-blue-500" />
                        <span className="ml-2 text-xs text-gray-500">
                          내역 불러오는 중...
                        </span>
                      </div>
                    ) : (
                      <div className="space-y-1.5">
                        {/* 도입 전 사용(수동) — 값이 있을 때만 */}
                        {r.initialUsedDays > 0 && (
                          <div className="flex items-center justify-between text-sm bg-white rounded-lg border border-gray-100 px-3 py-2">
                            <span className="text-gray-500">도입 전 사용(수동)</span>
                            <span className="font-medium text-gray-700">
                              {fmtNum(r.initialUsedDays)}일
                            </span>
                          </div>
                        )}

                        {detail && detail.items.length > 0
                          ? detail.items.map((it, idx) => (
                              <div
                                key={idx}
                                className="flex items-center justify-between gap-3 text-sm bg-white rounded-lg border border-gray-100 px-3 py-2"
                              >
                                <div className="min-w-0">
                                  <div className="text-gray-700 truncate">
                                    {dateRangeLabel(it.startDate, it.endDate)}
                                  </div>
                                  <div className="text-xs text-gray-400 truncate">
                                    {it.categoryName ?? "-"}
                                  </div>
                                </div>
                                <span className="font-medium text-gray-700 shrink-0">
                                  차감 {fmtNum(it.usedDays)}일
                                </span>
                              </div>
                            ))
                          : detail &&
                            r.initialUsedDays === 0 && (
                              <div className="text-sm text-gray-400 text-center py-3">
                                사용 내역 없음
                              </div>
                            )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

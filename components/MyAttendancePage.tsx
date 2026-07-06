"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Calendar,
  Loader2,
  UserCheck,
  AlertCircle,
  Clock,
  type LucideIcon,
} from "lucide-react";
import { useCurrentEmployee } from "@/lib/useCurrentEmployee";
import AttendanceCalendarView from "@/components/AttendanceCalendarView";
import MyShiftModal from "@/components/MyShiftModal";

// 내 근태 화면용 요약 카드 fetch 결과 타입
// 캘린더 렌더는 AttendanceCalendarView가 담당하므로 여기서는 상단 4개 카드 통계 계산용으로만 사용한다.
interface AttendanceDaily {
  id: number;
  workDate: string; // "YYYY-MM-DD"
  checkIn: string | null;
  checkOut: string | null;
  autoStatus: string | null;
}

interface StatusLookup {
  id: number;
  code: string;
  label: string;
  color: string | null;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

// "YYYY-MM" 형식 보장
function toYm(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}`;
}

// "YYYY-MM" 문자열의 월에서 ±n 한 새로운 "YYYY-MM" 문자열 반환
function shiftYm(ym: string, deltaMonths: number): string {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(y, (m - 1) + deltaMonths, 1);
  return toYm(d);
}

export default function MyAttendancePage() {
  const { currentId, current, loading: empLoading } = useCurrentEmployee();

  const today = useMemo(() => new Date(), []);
  // ym = "YYYY-MM" — AttendanceCalendarView에 controlled로 전달하고, 요약 카드도 이 ym로 fetch 한다.
  const [ym, setYm] = useState<string>(() => toYm(today));

  const [dailies, setDailies] = useState<AttendanceDaily[]>([]);
  const [statusLookups, setStatusLookups] = useState<StatusLookup[]>([]);
  const [loading, setLoading] = useState(false);
  const [showShiftModal, setShowShiftModal] = useState(false);

  // ym → 년/월/말일 (요약 카드 fetch 범위 계산용)
  const { year, monthIdx, lastDayNum } = useMemo(() => {
    const [yy, mm] = ym.split("-").map(Number);
    return {
      year: yy,
      monthIdx: mm - 1,
      lastDayNum: new Date(yy, mm, 0).getDate(),
    };
  }, [ym]);

  // attendance_auto_status lookup 1회
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(
          "/api/lookups?category=attendance_auto_status&includeInactive=false"
        );
        if (res.ok) setStatusLookups(await res.json());
      } catch (e) {
        console.error("status lookups fetch error:", e);
      }
    })();
  }, []);

  // 상단 요약 카드용 dailies fetch — 캘린더 렌더링은 AttendanceCalendarView가 별도로 한다.
  const fetchDailies = useCallback(async () => {
    if (!currentId) return;
    setLoading(true);
    try {
      const from = `${year}-${pad2(monthIdx + 1)}-01`;
      const to = `${year}-${pad2(monthIdx + 1)}-${pad2(lastDayNum)}`;
      const res = await fetch(
        `/api/attendance-daily?employeeId=${currentId}&from=${from}&to=${to}`
      );
      if (res.ok) setDailies(await res.json());
      else setDailies([]);
    } catch (e) {
      console.error(e);
      setDailies([]);
    } finally {
      setLoading(false);
    }
  }, [currentId, year, monthIdx, lastDayNum]);

  useEffect(() => {
    fetchDailies();
  }, [fetchDailies]);

  // status helper (summary 카드 색상용)
  const getStatusColor = (code: string | null): string | null => {
    if (!code) return null;
    const lookup = statusLookups.find((l) => l.code === code);
    return lookup?.color ?? null;
  };

  // 통계 요약
  const summary = useMemo(() => {
    let attended = 0;
    let normal = 0;
    let late = 0;
    let absent = 0;
    dailies.forEach((d) => {
      if (d.checkIn) attended++;
      if (d.autoStatus === "normal") normal++;
      else if (d.autoStatus === "late") late++;
      else if (d.autoStatus === "absent") absent++;
    });
    return { attended, normal, late, absent };
  }, [dailies]);

  // 월 네비 — ym 문자열 직접 갱신
  const prevMonth = () => setYm((cur) => shiftYm(cur, -1));
  const nextMonth = () => setYm((cur) => shiftYm(cur, +1));
  const goToday = () => setYm(toYm(today));

  return (
    <div className="p-4 sm:p-6 space-y-5">
      {/* 헤더 */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold text-gray-900">
            내 근태
          </h1>
          <p className="text-sm text-gray-500 mt-0.5">
            {current
              ? `${current.name} 님의 월별 근태`
              : "본인을 선택하세요"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={prevMonth}
            className="p-2 rounded-lg hover:bg-gray-100 text-gray-500"
            title="이전 달"
          >
            <ChevronLeft size={18} />
          </button>
          <div className="text-sm sm:text-base font-semibold text-gray-900 min-w-[100px] text-center">
            {year}년 {monthIdx + 1}월
          </div>
          <button
            onClick={nextMonth}
            className="p-2 rounded-lg hover:bg-gray-100 text-gray-500"
            title="다음 달"
          >
            <ChevronRight size={18} />
          </button>
          <button
            onClick={goToday}
            className="ml-1 px-3 py-1.5 text-xs font-medium bg-white border border-gray-200 text-gray-600 rounded-lg hover:bg-gray-50"
          >
            오늘
          </button>
          {currentId && (
            <button
              onClick={() => setShowShiftModal(true)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-white border border-gray-200 text-gray-600 rounded-lg hover:bg-gray-50"
            >
              <Clock size={14} />
              시프트 변경
            </button>
          )}
        </div>
      </div>

      {showShiftModal && (
        <MyShiftModal
          onClose={() => setShowShiftModal(false)}
          onChanged={fetchDailies}
        />
      )}

      {/* 본인 없음 / 로딩 / 본문 */}
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
          {/* 통계 요약 카드 4개 */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
            <SummaryCard
              icon={UserCheck}
              label="출근일"
              value={summary.attended}
              color="text-blue-600"
              bg="bg-blue-50"
            />
            <SummaryCard
              icon={Calendar}
              label="정상"
              value={summary.normal}
              color={getStatusColor("normal") ?? "text-emerald-600"}
              bg="bg-emerald-50"
              dynamicColor={getStatusColor("normal")}
            />
            <SummaryCard
              icon={Clock}
              label="지각"
              value={summary.late}
              color={getStatusColor("late") ?? "text-amber-600"}
              bg="bg-amber-50"
              dynamicColor={getStatusColor("late")}
            />
            <SummaryCard
              icon={AlertCircle}
              label="결근"
              value={summary.absent}
              color={getStatusColor("absent") ?? "text-rose-600"}
              bg="bg-rose-50"
              dynamicColor={getStatusColor("absent")}
            />
          </div>

          {loading && (
            <div className="flex items-center justify-center h-8">
              <Loader2 size={18} className="animate-spin text-blue-500" />
              <span className="ml-2 text-xs text-gray-500">요약 갱신 중...</span>
            </div>
          )}

          {/* 전체 근태와 동일한 캘린더 UI — employeeId로 본인 데이터만, hideHeader로 상단 월 네비는 부모(이 페이지)가 제공 */}
          <AttendanceCalendarView
            employeeId={currentId}
            yearMonth={ym}
            onMonthChange={setYm}
            hideHeader
          />
        </>
      )}
    </div>
  );
}

// 통계 요약 카드 (재사용 안 함, 페이지 내부 헬퍼)
interface SummaryCardProps {
  icon: LucideIcon;
  label: string;
  value: number;
  color: string;
  bg: string;
  dynamicColor?: string | null;
}

function SummaryCard({
  icon: Icon,
  label,
  value,
  color,
  bg,
  dynamicColor,
}: SummaryCardProps) {
  // dynamicColor가 HEX면 inline style로, 아니면 tailwind class 사용
  const useDynamic = dynamicColor && dynamicColor.startsWith("#");
  return (
    <div className="bg-white rounded-2xl border border-gray-100 p-4 sm:p-5">
      <div
        className={`w-10 h-10 rounded-xl flex items-center justify-center mb-3 ${
          useDynamic ? "" : bg
        }`}
        style={useDynamic ? { backgroundColor: `${dynamicColor}20` } : undefined}
      >
        <Icon
          size={18}
          className={useDynamic ? "" : color}
          style={useDynamic ? { color: dynamicColor! } : undefined}
        />
      </div>
      <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
        {label}
      </p>
      <p className="mt-1 text-2xl sm:text-3xl font-bold text-gray-900 font-mono">
        {value}
      </p>
    </div>
  );
}

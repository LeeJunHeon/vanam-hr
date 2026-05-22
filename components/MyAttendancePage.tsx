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
  Wifi,
  WifiOff,
  Info,
  ChevronDown,
  type LucideIcon,
} from "lucide-react";
import { useCurrentEmployee } from "@/lib/useCurrentEmployee";
import CurrentEmployeeSelector from "@/components/CurrentEmployeeSelector";

interface AttendanceDaily {
  id: number;
  workDate: string; // "YYYY-MM-DD"
  checkIn: string | null;
  checkOut: string | null;
  autoStatus: string | null;
  categoryId: number | null;
  categoryCode: string | null;
  categoryName: string | null;
  categoryColor: string | null;
  isOverridden: boolean;
  workMinutes: number | null;
  note: string | null;
  isConfirmed: boolean;
}

interface StatusLookup {
  id: number;
  code: string;
  label: string;
  color: string | null;
}

interface PresenceSummary {
  employeeId: number;
  currentStatus: "online" | "offline" | null;
  lastOnlineAt: string | null;
  lastOfflineAt: string | null;
  todayRawCount: number;
}

const DAY_HEADERS = ["일", "월", "화", "수", "목", "금", "토"];

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function formatTime(iso: string | null): string {
  if (!iso) return "-";
  const d = new Date(iso);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function formatDateTime(iso: string | null): string {
  if (!iso) return "-";
  const d = new Date(iso);
  return `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function ymd(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

export default function MyAttendancePage() {
  const { currentId, current, loading: empLoading } = useCurrentEmployee();

  const today = useMemo(() => new Date(), []);
  const [viewDate, setViewDate] = useState(
    () => new Date(today.getFullYear(), today.getMonth(), 1)
  );

  const [dailies, setDailies] = useState<AttendanceDaily[]>([]);
  const [statusLookups, setStatusLookups] = useState<StatusLookup[]>([]);
  const [presence, setPresence] = useState<PresenceSummary | null>(null);
  const [loading, setLoading] = useState(false);

  const todayYmd = useMemo(() => ymd(today), [today]);

  const year = viewDate.getFullYear();
  const monthIdx = viewDate.getMonth(); // 0-based
  const firstDay = useMemo(
    () => new Date(year, monthIdx, 1),
    [year, monthIdx]
  );
  const lastDayNum = useMemo(
    () => new Date(year, monthIdx + 1, 0).getDate(),
    [year, monthIdx]
  );
  const leadingBlanks = firstDay.getDay(); // 0=Sun

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

  const fetchPresence = useCallback(async () => {
    if (!currentId) {
      setPresence(null);
      return;
    }
    try {
      const res = await fetch(`/api/presence?employeeId=${currentId}`);
      if (res.ok) {
        setPresence(await res.json());
      } else {
        setPresence(null);
      }
    } catch (e) {
      console.error("fetch presence error:", e);
      setPresence(null);
    }
  }, [currentId]);

  useEffect(() => {
    fetchPresence();
  }, [fetchPresence]);

  // date(YYYY-MM-DD) → daily 매핑
  const dailyByDate = useMemo(() => {
    const map = new Map<string, AttendanceDaily>();
    dailies.forEach((d) => map.set(d.workDate, d));
    return map;
  }, [dailies]);

  // status helper
  const getStatusLabel = (code: string | null): string => {
    if (!code) return "";
    const lookup = statusLookups.find((l) => l.code === code);
    return lookup ? lookup.label : code;
  };
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

  // 월 네비
  const prevMonth = () =>
    setViewDate((d) => new Date(d.getFullYear(), d.getMonth() - 1, 1));
  const nextMonth = () =>
    setViewDate((d) => new Date(d.getFullYear(), d.getMonth() + 1, 1));
  const goToday = () =>
    setViewDate(new Date(today.getFullYear(), today.getMonth(), 1));

  // 캘린더 셀 배열 (leading blanks + 1~lastDayNum)
  const cells: (number | null)[] = useMemo(() => {
    const arr: (number | null)[] = [];
    for (let i = 0; i < leadingBlanks; i++) arr.push(null);
    for (let d = 1; d <= lastDayNum; d++) arr.push(d);
    // 6주(42셀)로 패딩
    while (arr.length % 7 !== 0) arr.push(null);
    return arr;
  }, [leadingBlanks, lastDayNum]);

  return (
    <div className="p-4 sm:p-6 space-y-5">
      {/* 본인 선택기 */}
      <CurrentEmployeeSelector />

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
        </div>
      </div>

      {/* 본인 없음 / 로딩 / 캘린더 */}
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

          {/* 현재 상태 박스 (오늘 사무실 연결 상태) */}
          <PresenceStatusCard presence={presence} onRefresh={fetchPresence} />

          {/* 시스템 동작 안내 (펼치기) */}
          <SystemInfoBox />

          {/* 로딩 */}
          {loading ? (
            <div className="flex items-center justify-center h-64">
              <Loader2 size={28} className="animate-spin text-blue-500" />
              <span className="ml-2 text-sm text-gray-500">로딩 중...</span>
            </div>
          ) : (
            <>
              {/* 데스크탑 캘린더 그리드 */}
              <div className="hidden sm:block bg-white rounded-2xl border border-gray-100 p-4 overflow-hidden">
                {/* 요일 헤더 */}
                <div className="grid grid-cols-7 gap-1 mb-1">
                  {DAY_HEADERS.map((h, i) => (
                    <div
                      key={h}
                      className={`text-center text-xs font-semibold py-2 ${
                        i === 0
                          ? "text-rose-500"
                          : i === 6
                          ? "text-blue-500"
                          : "text-gray-500"
                      }`}
                    >
                      {h}
                    </div>
                  ))}
                </div>

                {/* 날짜 셀 */}
                <div className="grid grid-cols-7 gap-1">
                  {cells.map((day, idx) => {
                    if (day === null) {
                      return (
                        <div
                          key={`blank-${idx}`}
                          className="min-h-[88px] bg-gray-50/50 rounded-lg"
                        />
                      );
                    }
                    const dateStr = `${year}-${pad2(monthIdx + 1)}-${pad2(day)}`;
                    const daily = dailyByDate.get(dateStr);
                    const isToday = dateStr === todayYmd;
                    const dow = (leadingBlanks + day - 1) % 7;
                    const dayColor =
                      dow === 0
                        ? "text-rose-500"
                        : dow === 6
                        ? "text-blue-500"
                        : "text-gray-700";

                    const statusColor = getStatusColor(daily?.autoStatus ?? null);

                    return (
                      <div
                        key={dateStr}
                        className={`min-h-[88px] rounded-lg border p-1.5 transition-colors ${
                          isToday
                            ? "border-blue-500 bg-blue-50/40"
                            : daily
                            ? "border-gray-100 bg-white hover:bg-gray-50"
                            : "border-gray-100 bg-white"
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <span
                            className={`text-sm font-semibold ${
                              isToday ? "text-blue-600" : dayColor
                            }`}
                          >
                            {day}
                          </span>
                          {daily?.isConfirmed && (
                            <span
                              className="w-1.5 h-1.5 rounded-full bg-emerald-500"
                              title="확정됨"
                            />
                          )}
                        </div>

                        {daily ? (
                          <div className="mt-1 space-y-1">
                            {(daily.checkIn || daily.checkOut) && (
                              <div className="text-[10px] text-gray-600 font-mono leading-tight">
                                {formatTime(daily.checkIn)} -{" "}
                                {formatTime(daily.checkOut)}
                              </div>
                            )}
                            {daily.autoStatus && (
                              <div
                                className="text-[10px] font-semibold px-1.5 py-0.5 rounded inline-block"
                                style={
                                  statusColor &&
                                  statusColor.startsWith("#")
                                    ? {
                                        backgroundColor: `${statusColor}20`,
                                        color: statusColor,
                                      }
                                    : { backgroundColor: "#f3f4f6", color: "#4b5563" }
                                }
                              >
                                {getStatusLabel(daily.autoStatus)}
                              </div>
                            )}
                            {daily.categoryName && (
                              <div
                                className="text-[10px] font-medium px-1.5 py-0.5 rounded inline-block truncate max-w-full"
                                style={
                                  daily.categoryColor &&
                                  daily.categoryColor.startsWith("#")
                                    ? {
                                        backgroundColor: `${daily.categoryColor}20`,
                                        color: daily.categoryColor,
                                      }
                                    : {
                                        backgroundColor: "#e0e7ff",
                                        color: "#4f46e5",
                                      }
                                }
                                title={daily.categoryName}
                              >
                                {daily.categoryName}
                              </div>
                            )}
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* 모바일: 데이터 있는 일자만 리스트로 */}
              <div className="sm:hidden bg-white rounded-2xl border border-gray-100 divide-y divide-gray-50 overflow-hidden">
                {dailies.length === 0 ? (
                  <div className="px-4 py-12 text-center text-sm text-gray-400">
                    이 달의 근태 기록이 없습니다.
                  </div>
                ) : (
                  dailies.map((d) => {
                    const statusColor = getStatusColor(d.autoStatus);
                    return (
                      <div
                        key={d.id}
                        className="px-4 py-3 flex items-center justify-between gap-3"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-semibold text-gray-900 font-mono">
                              {d.workDate.slice(5)}
                            </span>
                            {d.isConfirmed && (
                              <span className="text-[10px] text-emerald-600 font-semibold">
                                확정
                              </span>
                            )}
                          </div>
                          <div className="text-xs text-gray-500 font-mono mt-0.5">
                            {formatTime(d.checkIn)} - {formatTime(d.checkOut)}
                          </div>
                        </div>
                        <div className="flex flex-col items-end gap-1 shrink-0">
                          {d.autoStatus && (
                            <span
                              className="text-[10px] font-semibold px-2 py-0.5 rounded-full"
                              style={
                                statusColor && statusColor.startsWith("#")
                                  ? {
                                      backgroundColor: `${statusColor}20`,
                                      color: statusColor,
                                    }
                                  : { backgroundColor: "#f3f4f6", color: "#4b5563" }
                              }
                            >
                              {getStatusLabel(d.autoStatus)}
                            </span>
                          )}
                          {d.categoryName && (
                            <span
                              className="text-[10px] font-medium px-2 py-0.5 rounded-full"
                              style={
                                d.categoryColor && d.categoryColor.startsWith("#")
                                  ? {
                                      backgroundColor: `${d.categoryColor}20`,
                                      color: d.categoryColor,
                                    }
                                  : {
                                      backgroundColor: "#e0e7ff",
                                      color: "#4f46e5",
                                    }
                              }
                            >
                              {d.categoryName}
                            </span>
                          )}
                        </div>
                      </div>
                    );
                  })
                )}
              </div>

              {/* 빈 상태 안내 (데스크탑/모바일 공통) */}
              {dailies.length === 0 && (
                <div className="bg-gray-50 border border-gray-100 rounded-2xl px-4 py-3 text-xs text-gray-500">
                  이 달의 근태 기록이 없습니다.
                </div>
              )}
            </>
          )}
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

// 현재 사무실 연결 상태 + 최근 online/offline 시각
interface PresenceStatusCardProps {
  presence: PresenceSummary | null;
  onRefresh: () => void;
}

function PresenceStatusCard({ presence, onRefresh }: PresenceStatusCardProps) {
  const isOnline = presence?.currentStatus === "online";
  const isOffline = presence?.currentStatus === "offline";
  const noData = !presence || presence.currentStatus === null;

  return (
    <div className="bg-white rounded-2xl border border-gray-100 p-4 sm:p-5">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-gray-900">
          오늘 사무실 연결 상태
        </h3>
        <button
          onClick={onRefresh}
          className="text-xs font-medium text-gray-500 hover:text-gray-700 px-2 py-1 rounded hover:bg-gray-50 transition-colors"
        >
          새로고침
        </button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {/* 현재 상태 */}
        <div className="flex items-center gap-3 p-3 rounded-lg bg-gray-50">
          <div
            className={`w-10 h-10 rounded-full flex items-center justify-center ${
              isOnline
                ? "bg-emerald-100"
                : isOffline
                ? "bg-rose-100"
                : "bg-gray-100"
            }`}
          >
            {isOnline ? (
              <Wifi size={18} className="text-emerald-600" />
            ) : isOffline ? (
              <WifiOff size={18} className="text-rose-600" />
            ) : (
              <WifiOff size={18} className="text-gray-400" />
            )}
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide">
              현재 상태
            </p>
            <p
              className={`text-base font-bold ${
                isOnline
                  ? "text-emerald-600"
                  : isOffline
                  ? "text-rose-600"
                  : "text-gray-400"
              }`}
            >
              {isOnline
                ? "● 사무실"
                : isOffline
                ? "◌ 연결 끊김"
                : "오늘 기록 없음"}
            </p>
          </div>
        </div>

        {/* 마지막 연결 시각 */}
        <div className="flex items-center gap-3 p-3 rounded-lg bg-gray-50">
          <div className="w-10 h-10 rounded-full bg-emerald-50 flex items-center justify-center">
            <Wifi size={18} className="text-emerald-500" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide">
              최근 연결 시각
            </p>
            <p className="text-sm font-mono text-gray-900">
              {presence?.lastOnlineAt
                ? formatDateTime(presence.lastOnlineAt)
                : "-"}
            </p>
          </div>
        </div>

        {/* 마지막 끊김 시각 (잠정 퇴근) */}
        <div className="flex items-center gap-3 p-3 rounded-lg bg-gray-50">
          <div className="w-10 h-10 rounded-full bg-amber-50 flex items-center justify-center">
            <WifiOff size={18} className="text-amber-500" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide">
              최근 끊김 시각
            </p>
            <p className="text-sm font-mono text-gray-900">
              {presence?.lastOfflineAt
                ? formatDateTime(presence.lastOfflineAt)
                : "-"}
            </p>
            {isOffline && presence?.lastOfflineAt && (
              <p className="text-[10px] text-amber-600 mt-0.5">
                ※ 잠정 퇴근 시각 (재연결 시 자동 갱신)
              </p>
            )}
          </div>
        </div>
      </div>

      {noData && (
        <div className="mt-3 text-xs text-gray-400 text-center">
          오늘 사무실 WiFi 연결 기록이 아직 없습니다.
        </div>
      )}
    </div>
  );
}

// 시스템 동작 안내 (펼치기)
function SystemInfoBox() {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="bg-blue-50/60 border border-blue-100 rounded-2xl overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full px-4 py-3 flex items-center justify-between text-left hover:bg-blue-50 transition-colors"
      >
        <div className="flex items-center gap-2">
          <Info size={16} className="text-blue-500" />
          <span className="text-sm font-semibold text-blue-900">
            출퇴근 자동 인식 안내
          </span>
        </div>
        <ChevronDown
          size={16}
          className={`text-blue-500 transition-transform ${
            expanded ? "rotate-180" : ""
          }`}
        />
      </button>

      {expanded && (
        <div className="px-4 pb-4 space-y-3 text-xs text-blue-900/80 leading-relaxed">
          <p>
            이 시스템은 사무실 WiFi 연결 상태로 출퇴근을 자동 인식합니다.
            등록된 본인 디바이스(폰 등)가 사무실 라우터에 연결/끊김되는 시점을
            매 1분마다 기록합니다.
          </p>
          <div className="space-y-1.5">
            <p>
              <span className="font-semibold">• 출근 시각:</span> 그날 처음
              사무실 WiFi에 연결된 시각
            </p>
            <p>
              <span className="font-semibold">• 퇴근 시각:</span> 그날 마지막
              연결이 끊긴 시각 (그 이후 재연결이 없을 때만 인정)
            </p>
            <p>
              <span className="font-semibold">• 외출 후 복귀:</span> 퇴근으로
              표시됐다가 다시 연결되면 자동으로 "근무 중"으로 갱신됩니다
            </p>
            <p>
              <span className="font-semibold">• 짧은 끊김:</span> 절전 모드 /
              5GHz↔2.4GHz 전환 같은 일시적 끊김도 기록되지만, 다시 연결되면 퇴근으로
              간주되지 않습니다
            </p>
          </div>
          <div className="pt-2 border-t border-blue-100/70">
            <p className="text-[11px] text-blue-700/70">
              ℹ️ 화면의 "최근 끊김 시각"은 잠정 퇴근 시각으로, 사무실 WiFi에 다시
              연결되면 자동으로 갱신됩니다. 오늘 일과 종료 후 확정됩니다.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

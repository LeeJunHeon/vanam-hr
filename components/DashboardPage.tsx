"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Users,
  Building2,
  Smartphone,
  ClipboardList,
  UserCheck,
  Calendar,
  Clock,
  Link as LinkIcon,
  CheckCircle,
  FileText,
  Loader2,
  RefreshCw,
  Wifi,
  WifiOff,
  UserX,
  LogOut,
  Plane,
  Globe,
  X,
} from "lucide-react";
import { useCurrentEmployee } from "@/lib/useCurrentEmployee";
import type { PageId } from "@/components/Sidebar";
import DatePicker from "@/components/DatePicker";
import { todayYmd } from "@/lib/dateUtils";

// ============================================
// 공통 타입
// ============================================
type PeriodType = "day" | "month" | "year";

interface DetailItem {
  employeeId: number;
  name: string;
  departmentName: string | null;
  workDate: string;
  checkIn?: string | null;
  checkOut?: string | null;
  categoryName?: string | null;
  reason?: string | null;
}
interface AdminStats {
  period: PeriodType;
  range: { start: string; end: string };
  asOf: string;
  pendingRequests: number;
  counts: {
    absent: number;
    late: number;
    earlyLeave: number;
    leave: number;
    tripExternal: number;
  };
  details: {
    absent: DetailItem[];
    late: DetailItem[];
    earlyLeave: DetailItem[];
    leave: DetailItem[];
    tripExternal: DetailItem[];
  };
}

interface MyStats {
  employeeId: number;
  period: PeriodType;
  myAttended: number;
  myLeaveDays: number;
  myPendingRequests: number;
  myCompletedRequests: number;
  asOf: string;
}

interface CardConfig {
  key: string;
  iconKey:
    | "users"
    | "building"
    | "smartphone"
    | "clipboard"
    | "userCheck"
    | "calendar"
    | "clock"
    | "link"
    | "fileText"
    | "checkCircle"
    | "userX"
    | "logOut"
    | "plane"
    | "globe";
  color:
    | "blue"
    | "emerald"
    | "amber"
    | "purple"
    | "rose"
    | "sky"
    | "orange"
    | "violet"
    | "teal";
  // titleByPeriod === null 이면 period 무관 고정 제목 = title
  title?: string;
  titleByPeriod?: Record<PeriodType, string>;
  description?: string;
  // 클릭 시 이동할 페이지 (없으면 클릭 비활성)
  page?: PageId;
  format?: (v: number) => string;
}

const ICON_MAP = {
  users: Users,
  building: Building2,
  smartphone: Smartphone,
  clipboard: ClipboardList,
  userCheck: UserCheck,
  calendar: Calendar,
  clock: Clock,
  link: LinkIcon,
  fileText: FileText,
  checkCircle: CheckCircle,
  userX: UserX,
  logOut: LogOut,
  plane: Plane,
  globe: Globe,
};

const COLOR_MAP: Record<
  CardConfig["color"],
  { bg: string; text: string; iconBg: string }
> = {
  blue: { bg: "bg-blue-50", text: "text-blue-600", iconBg: "bg-blue-100" },
  emerald: { bg: "bg-emerald-50", text: "text-emerald-600", iconBg: "bg-emerald-100" },
  amber: { bg: "bg-amber-50", text: "text-amber-600", iconBg: "bg-amber-100" },
  purple: { bg: "bg-purple-50", text: "text-purple-600", iconBg: "bg-purple-100" },
  rose: { bg: "bg-rose-50", text: "text-rose-600", iconBg: "bg-rose-100" },
  sky: { bg: "bg-sky-50", text: "text-sky-600", iconBg: "bg-sky-100" },
  orange: { bg: "bg-orange-50", text: "text-orange-600", iconBg: "bg-orange-100" },
  violet: { bg: "bg-violet-50", text: "text-violet-600", iconBg: "bg-violet-100" },
  teal: { bg: "bg-teal-50", text: "text-teal-600", iconBg: "bg-teal-100" },
};

// ============================================
// 카드 정의
// ============================================
type AdminCardKey =
  | "pendingRequests"
  | "absent"
  | "late"
  | "earlyLeave"
  | "leave"
  | "tripExternal";

interface AdminCard {
  key: AdminCardKey;
  title: string;
  iconKey: CardConfig["iconKey"];
  color: CardConfig["color"];
  kind: "navigate" | "detail"; // navigate=페이지 이동, detail=팝업
  page?: PageId; // kind=navigate일 때
  detailKey?: keyof AdminStats["details"]; // kind=detail일 때
}

const ADMIN_CARDS: AdminCard[] = [
  { key: "pendingRequests", title: "결재 대기", iconKey: "clipboard", color: "amber", kind: "navigate", page: "approval" },
  { key: "absent", title: "결근", iconKey: "userX", color: "rose", kind: "detail", detailKey: "absent" },
  { key: "late", title: "지각", iconKey: "clock", color: "amber", kind: "detail", detailKey: "late" },
  { key: "earlyLeave", title: "조퇴", iconKey: "logOut", color: "orange", kind: "detail", detailKey: "earlyLeave" },
  { key: "leave", title: "휴가", iconKey: "calendar", color: "violet", kind: "detail", detailKey: "leave" },
  { key: "tripExternal", title: "출장 및 외근", iconKey: "globe", color: "teal", kind: "detail", detailKey: "tripExternal" },
];

const MY_CARDS: CardConfig[] = [
  {
    key: "myAttended",
    iconKey: "userCheck",
    color: "emerald",
    titleByPeriod: {
      day: "오늘 출근",
      month: "이번달 출근",
      year: "올해 출근",
    },
    description: "본인 체크인 일수",
    page: "my-attendance",
  },
  {
    key: "myLeaveDays",
    iconKey: "calendar",
    color: "rose",
    titleByPeriod: {
      day: "오늘 휴가",
      month: "이번달 휴가",
      year: "올해 휴가",
    },
    description: "본인 사용 (일)",
    format: (v) => v.toFixed(1),
    page: "my-attendance",
  },
  {
    key: "myPendingRequests",
    iconKey: "fileText",
    color: "amber",
    titleByPeriod: {
      day: "오늘 신청 대기",
      month: "이번달 신청 대기",
      year: "올해 신청 대기",
    },
    description: "본인 신청 중",
    page: "request",
  },
  {
    key: "myCompletedRequests",
    iconKey: "checkCircle",
    color: "blue",
    titleByPeriod: {
      day: "오늘 신청 완료",
      month: "이번달 신청 완료",
      year: "올해 신청 완료",
    },
    description: "본인 승인 완료",
    page: "request",
  },
];

// ============================================
// 기간 탭 + Picker
// ============================================
const PERIOD_OPTIONS: { value: PeriodType; label: string }[] = [
  { value: "day", label: "일별" },
  { value: "month", label: "월별" },
  { value: "year", label: "연도별" },
];

function PeriodTabs({
  value,
  onChange,
}: {
  value: PeriodType;
  onChange: (v: PeriodType) => void;
}) {
  return (
    <div className="inline-flex bg-gray-100 rounded-xl p-1">
      {PERIOD_OPTIONS.map((opt) => (
        <button
          key={opt.value}
          onClick={() => onChange(opt.value)}
          className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors ${
            value === opt.value
              ? "bg-white text-gray-900 shadow-sm"
              : "text-gray-500 hover:text-gray-700"
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

interface PeriodPickerProps {
  period: PeriodType;
  targetDate: string; // YYYY-MM-DD
  targetMonth: string; // YYYY-MM
  targetYear: string; // YYYY
  onChangeDate: (v: string) => void;
  onChangeMonth: (v: string) => void;
  onChangeYear: (v: string) => void;
}

function PeriodPicker({
  period,
  targetDate,
  targetMonth,
  targetYear,
  onChangeDate,
  onChangeMonth,
  onChangeYear,
}: PeriodPickerProps) {
  if (period === "day") {
    return (
      <DatePicker
        value={targetDate}
        placeholder="날짜 선택"
        onChange={(val) => onChangeDate(val)}
      />
    );
  }
  if (period === "month") {
    return (
      <input
        type="month"
        value={targetMonth}
        onChange={(e) => onChangeMonth(e.target.value)}
        className="px-3 py-1.5 text-xs font-semibold bg-white border border-gray-200 rounded-lg outline-none focus:ring-2 focus:ring-blue-500"
      />
    );
  }
  // year
  return (
    <input
      type="number"
      min={2020}
      max={2100}
      value={targetYear}
      onChange={(e) => onChangeYear(e.target.value)}
      className="w-24 px-3 py-1.5 text-xs font-semibold bg-white border border-gray-200 rounded-lg outline-none focus:ring-2 focus:ring-blue-500"
    />
  );
}

// ============================================
// PresenceCard — 이전 3열 그리드 디자인 + location
// ============================================
interface PresenceInfo {
  currentStatus: "online" | "offline" | "unknown";
  lastOnlineAt: string | null;
  lastOfflineAt: string | null;
  lastLocation: string | null;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function formatDateTime(iso: string | null): string {
  if (!iso) return "-";
  const d = new Date(iso);
  return `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())} ${pad2(
    d.getHours()
  )}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function PresenceCard({ refreshKey }: { refreshKey: number }) {
  const [info, setInfo] = useState<PresenceInfo | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchPresence = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/presence");
      if (res.ok) {
        const data = await res.json();
        setInfo({
          currentStatus: data.currentStatus ?? "unknown",
          lastOnlineAt: data.lastOnlineAt ?? null,
          lastOfflineAt: data.lastOfflineAt ?? null,
          lastLocation: data.lastLocation ?? null,
        });
      }
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchPresence();
  }, [fetchPresence, refreshKey]);

  const isOnline = info?.currentStatus === "online";
  const isOffline = info?.currentStatus === "offline";
  const noData = !info || info.currentStatus === "unknown";

  return (
    <div className="bg-white rounded-2xl border border-gray-100 p-4 sm:p-5">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-gray-900">
          오늘 나의 연결 상태
        </h3>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-gray-400 py-2">
          <Loader2 size={14} className="animate-spin" />
          로딩 중...
        </div>
      ) : (
        <>
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
                {isOnline && info?.lastLocation && (
                  <p className="text-[11px] text-gray-500 mt-0.5">
                    @ {info.lastLocation}
                  </p>
                )}
              </div>
            </div>

            {/* 최근 연결 시각 */}
            <div className="flex items-center gap-3 p-3 rounded-lg bg-gray-50">
              <div className="w-10 h-10 rounded-full bg-emerald-50 flex items-center justify-center">
                <Wifi size={18} className="text-emerald-500" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide">
                  최근 연결 시각
                </p>
                <p className="text-sm font-mono text-gray-900">
                  {info?.lastOnlineAt
                    ? formatDateTime(info.lastOnlineAt)
                    : "-"}
                </p>
              </div>
            </div>

            {/* 최근 끊김 시각 (잠정 퇴근) */}
            <div className="flex items-center gap-3 p-3 rounded-lg bg-gray-50">
              <div className="w-10 h-10 rounded-full bg-amber-50 flex items-center justify-center">
                <WifiOff size={18} className="text-amber-500" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide">
                  최근 끊김 시각
                </p>
                <p className="text-sm font-mono text-gray-900">
                  {info?.lastOfflineAt
                    ? formatDateTime(info.lastOfflineAt)
                    : "-"}
                </p>
                {isOffline && info?.lastOfflineAt && (
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
        </>
      )}
    </div>
  );
}

// ============================================
// StatCard — 클릭 가능
// ============================================
function StatCard({
  card,
  value,
  period,
  onNavigate,
  onClick,
}: {
  card: CardConfig;
  value: string;
  period: PeriodType;
  onNavigate?: (page: PageId) => void;
  onClick?: () => void;
}) {
  const Icon = ICON_MAP[card.iconKey];
  const colors = COLOR_MAP[card.color];
  const title = card.titleByPeriod
    ? card.titleByPeriod[period]
    : card.title ?? "";

  // onClick(상세 팝업 등)이 있으면 우선, 없으면 card.page로 페이지 이동
  const clickable = !!onClick || !!card.page;

  return (
    <button
      onClick={() => {
        if (onClick) {
          onClick();
          return;
        }
        if (card.page && onNavigate) onNavigate(card.page);
      }}
      disabled={!clickable}
      className={`text-left bg-white rounded-2xl border border-gray-100 p-4 sm:p-5 transition-shadow w-full ${
        clickable
          ? "hover:shadow-md hover:border-blue-200 cursor-pointer"
          : "cursor-default"
      }`}
    >
      <div className="flex items-start justify-between mb-3">
        <div
          className={`w-10 h-10 rounded-xl flex items-center justify-center ${colors.iconBg}`}
        >
          <Icon size={18} className={colors.text} />
        </div>
      </div>
      <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
        {title}
      </p>
      <p className="mt-1 text-2xl sm:text-3xl font-bold text-gray-900 font-mono">
        {value}
      </p>
      {card.description && (
        <p className="text-xs text-gray-400 mt-1">{card.description}</p>
      )}
    </button>
  );
}

// ============================================
// 상세 팝업 모달 (관리자 카드 클릭 시)
// ============================================
function DetailModal({
  title,
  items,
  onClose,
}: {
  title: string;
  items: DetailItem[];
  onClose: () => void;
}) {
  // HH:MM (ISO → 로컬, 24시간)
  const fmtHM = (iso?: string | null) => {
    if (!iso) return null;
    const d = new Date(iso);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[80vh] overflow-hidden flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-100">
          <h3 className="text-base font-bold text-gray-900">{title} <span className="text-sm font-normal text-gray-400">({items.length}건)</span></h3>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400"><X size={18} /></button>
        </div>
        <div className="overflow-y-auto">
          {items.length === 0 ? (
            <div className="px-5 py-10 text-center text-sm text-gray-400">해당 내역이 없습니다</div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-gray-500 text-xs">
                <tr>
                  <th className="text-left px-4 py-2 font-medium">이름</th>
                  <th className="text-left px-4 py-2 font-medium">부서</th>
                  <th className="text-left px-4 py-2 font-medium">날짜</th>
                  <th className="text-left px-4 py-2 font-medium">상세</th>
                </tr>
              </thead>
              <tbody>
                {items.map((it, i) => {
                  // 출장/외근 등 카테고리 항목: "출장 09:00~12:00"(시간 있으면) / "출장"(종일)
                  const s = fmtHM(it.checkIn);
                  const e = fmtHM(it.checkOut);
                  const timeText = s && e ? `${s}~${e}` : s ? `${s}~` : null;
                  return (
                    <tr key={`${it.employeeId}-${it.workDate}-${i}`} className="border-t border-gray-50">
                      <td className="px-4 py-2 font-medium text-gray-900">{it.name}</td>
                      <td className="px-4 py-2 text-gray-500">{it.departmentName ?? "-"}</td>
                      <td className="px-4 py-2 text-gray-600">{it.workDate}</td>
                      <td className="px-4 py-2 text-gray-500">
                        {it.categoryName ? (
                          // 출장/외근/휴가 등 — 카테고리명 + (있으면) 시간
                          `${it.categoryName}${timeText ? ` ${timeText}` : ""}`
                        ) : (
                          // 지각/조퇴 등 — 기존 시간 표시 유지
                          <>
                            {it.checkIn ? `${new Date(it.checkIn).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })}` : ""}
                            {it.checkOut ? `~${new Date(it.checkOut).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })}` : ""}
                          </>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

// ============================================
// Picker 초기값 헬퍼 (todayYmd는 lib/dateUtils 사용)
// ============================================
function thisMonthStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
}
function thisYearStr(): string {
  return String(new Date().getFullYear());
}

// ============================================
// 관리자 대시보드
// ============================================
function AdminDashboard({
  onNavigate,
}: {
  onNavigate: (page: PageId) => void;
}) {
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [period, setPeriod] = useState<PeriodType>("day");
  const [targetDate, setTargetDate] = useState(todayYmd());
  const [targetMonth, setTargetMonth] = useState(thisMonthStr());
  const [targetYear, setTargetYear] = useState(thisYearStr());
  const [detailModal, setDetailModal] = useState<{
    title: string;
    items: DetailItem[];
  } | null>(null);

  const fetchStats = useCallback(
    async (showRefresh = false) => {
      if (showRefresh) setRefreshing(true);
      else setLoading(true);
      try {
        const params = new URLSearchParams({ period });
        if (period === "day") params.set("targetDate", targetDate);
        else if (period === "month") params.set("targetMonth", targetMonth);
        else params.set("targetYear", targetYear);

        const res = await fetch(`/api/dashboard/stats?${params}`);
        if (res.ok) setStats(await res.json());
      } catch (e) {
        console.error(e);
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [period, targetDate, targetMonth, targetYear]
  );

  useEffect(() => {
    fetchStats();
  }, [fetchStats]);

  // 선택된 기간을 사람이 읽는 라벨로 (연도 바꿔도 정확히 반영)
  const periodLabel =
    period === "day"
      ? targetDate // "2026-06-11"
        ? `${Number(targetDate.split("-")[1])}/${Number(targetDate.split("-")[2])}` // "6/11"
        : ""
      : period === "month"
      ? targetMonth // "2026-06"
        ? `${targetMonth.split("-")[0]}년 ${Number(targetMonth.split("-")[1])}월` // "2026년 6월"
        : ""
      : targetYear // "2026"
      ? `${targetYear}년` // "2026년"
      : "";

  return (
    <div className="p-4 sm:p-6 space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold text-gray-900">
            관리자 대시보드
          </h1>
          <p className="text-sm text-gray-500 mt-0.5">
            전체 시스템 현황을 한눈에 확인합니다
            {stats && (
              <span className="ml-2 text-xs text-gray-400">
                · {new Date(stats.asOf).toLocaleString("ko-KR")} 기준
              </span>
            )}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <PeriodTabs value={period} onChange={setPeriod} />
          <PeriodPicker
            period={period}
            targetDate={targetDate}
            targetMonth={targetMonth}
            targetYear={targetYear}
            onChangeDate={setTargetDate}
            onChangeMonth={setTargetMonth}
            onChangeYear={setTargetYear}
          />
          <button
            onClick={() => { fetchStats(true); setRefreshKey((k) => k + 1); }}
            disabled={refreshing}
            className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium bg-white border border-gray-200 text-gray-600 rounded-xl hover:bg-gray-50 disabled:opacity-40"
          >
            <RefreshCw
              size={14}
              className={refreshing ? "animate-spin" : ""}
            />
            새로고침
          </button>
        </div>
      </div>

      <PresenceCard refreshKey={refreshKey} />

      {loading ? (
        <div className="flex items-center justify-center h-64">
          <Loader2 size={28} className="animate-spin text-blue-500" />
          <span className="ml-2 text-sm text-gray-500">로딩 중...</span>
        </div>
      ) : (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
          {ADMIN_CARDS.map((card) => {
            const raw =
              card.key === "pendingRequests"
                ? stats?.pendingRequests ?? 0
                : stats?.counts?.[card.key] ?? 0;
            const value = String(raw);
            const displayTitle = `${periodLabel} ${card.title}`;
            const handleClick = () => {
              if (card.kind === "navigate" && card.page) {
                onNavigate(card.page);
              } else if (card.kind === "detail" && card.detailKey) {
                setDetailModal({
                  title: displayTitle,
                  items: stats?.details?.[card.detailKey] ?? [],
                });
              }
            };
            return (
              <StatCard
                key={card.key}
                card={{ ...card, title: displayTitle }}
                value={value}
                period={period}
                onClick={handleClick}
              />
            );
          })}
        </div>
      )}

      {detailModal && (
        <DetailModal
          title={detailModal.title}
          items={detailModal.items}
          onClose={() => setDetailModal(null)}
        />
      )}
    </div>
  );
}

// ============================================
// 직원 대시보드
// ============================================
function MyDashboard({
  onNavigate,
}: {
  onNavigate: (page: PageId) => void;
}) {
  const [stats, setStats] = useState<MyStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [period, setPeriod] = useState<PeriodType>("month");
  const [targetDate, setTargetDate] = useState(todayYmd());
  const [targetMonth, setTargetMonth] = useState(thisMonthStr());
  const [targetYear, setTargetYear] = useState(thisYearStr());

  const fetchStats = useCallback(
    async (showRefresh = false) => {
      if (showRefresh) setRefreshing(true);
      else setLoading(true);
      try {
        const params = new URLSearchParams({ period });
        if (period === "day") params.set("targetDate", targetDate);
        else if (period === "month") params.set("targetMonth", targetMonth);
        else params.set("targetYear", targetYear);

        const res = await fetch(`/api/dashboard/my-stats?${params}`);
        if (res.ok) setStats(await res.json());
      } catch (e) {
        console.error(e);
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [period, targetDate, targetMonth, targetYear]
  );

  useEffect(() => {
    fetchStats();
  }, [fetchStats]);

  return (
    <div className="p-4 sm:p-6 space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold text-gray-900">
            내 대시보드
          </h1>
          <p className="text-sm text-gray-500 mt-0.5">
            본인 근태 + 결재 현황을 확인합니다
            {stats && (
              <span className="ml-2 text-xs text-gray-400">
                · {new Date(stats.asOf).toLocaleString("ko-KR")} 기준
              </span>
            )}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <PeriodTabs value={period} onChange={setPeriod} />
          <PeriodPicker
            period={period}
            targetDate={targetDate}
            targetMonth={targetMonth}
            targetYear={targetYear}
            onChangeDate={setTargetDate}
            onChangeMonth={setTargetMonth}
            onChangeYear={setTargetYear}
          />
          <button
            onClick={() => { fetchStats(true); setRefreshKey((k) => k + 1); }}
            disabled={refreshing}
            className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium bg-white border border-gray-200 text-gray-600 rounded-xl hover:bg-gray-50 disabled:opacity-40"
          >
            <RefreshCw
              size={14}
              className={refreshing ? "animate-spin" : ""}
            />
            새로고침
          </button>
        </div>
      </div>

      <PresenceCard refreshKey={refreshKey} />

      {loading ? (
        <div className="flex items-center justify-center h-64">
          <Loader2 size={28} className="animate-spin text-blue-500" />
          <span className="ml-2 text-sm text-gray-500">로딩 중...</span>
        </div>
      ) : (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
          {MY_CARDS.map((card) => {
            const raw =
              (stats as unknown as Record<string, number>)?.[card.key] ?? 0;
            const value = card.format
              ? card.format(Number(raw))
              : String(raw);
            return (
              <StatCard
                key={card.key}
                card={card}
                value={value}
                period={period}
                onNavigate={onNavigate}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

// ============================================
// 메인 컴포넌트
// ============================================
export default function DashboardPage({
  onNavigate,
}: {
  onNavigate: (page: PageId) => void;
}) {
  const { isAdmin, loading } = useCurrentEmployee();

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 size={28} className="animate-spin text-blue-500" />
        <span className="ml-2 text-sm text-gray-500">로딩 중...</span>
      </div>
    );
  }

  return isAdmin ? (
    <AdminDashboard onNavigate={onNavigate} />
  ) : (
    <MyDashboard onNavigate={onNavigate} />
  );
}

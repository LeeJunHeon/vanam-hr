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
  CheckSquare,
  FileText,
  CalendarCheck,
  CalendarOff,
  Loader2,
  RefreshCw,
} from "lucide-react";
import { useCurrentEmployee } from "@/lib/useCurrentEmployee";

interface AdminStats {
  activeEmployees: number;
  activeDepartments: number;
  activeDevices: number;
  pendingRequests: number;
  todayAttended: number;
  monthLeaveDays: number;
  shiftPatterns: number;
  mappedSsoUsers: number;
  asOf: string;
}

interface MyStats {
  employeeId: number;
  myThisMonthAttended: number;
  myThisMonthLeaveDays: number;
  myPendingRequests: number;
  myPendingApprovals: number;
  asOf: string;
}

interface CardConfig<K extends string> {
  key: K;
  title: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  color: "blue" | "emerald" | "amber" | "purple" | "rose" | "sky";
  description: string;
  format?: (v: number) => string;
}

const ADMIN_CARDS: CardConfig<keyof Omit<AdminStats, "asOf">>[] = [
  { key: "activeEmployees",   title: "활성 직원",        icon: Users,        color: "blue",    description: "현재 재직 중" },
  { key: "activeDepartments", title: "부서",             icon: Building2,    color: "purple",  description: "활성 부서 수" },
  { key: "activeDevices",     title: "등록 디바이스",    icon: Smartphone,   color: "sky",     description: "WiFi 폴링 대상" },
  { key: "pendingRequests",   title: "결재 대기",        icon: ClipboardList,color: "amber",   description: "승인 대기 중" },
  { key: "todayAttended",     title: "오늘 출근",        icon: UserCheck,    color: "emerald", description: "현재까지 체크인" },
  { key: "monthLeaveDays",    title: "이번달 휴가 사용", icon: Calendar,     color: "rose",    description: "연차/반차 합계 (일)", format: (v) => v.toFixed(1) },
  { key: "shiftPatterns",     title: "시프트 패턴",      icon: Clock,        color: "blue",    description: "운영 중인 패턴" },
  { key: "mappedSsoUsers",    title: "SSO 매핑",         icon: LinkIcon,     color: "emerald", description: "포털 SSO 연결됨" },
];

const MY_CARDS: CardConfig<keyof Omit<MyStats, "employeeId" | "asOf">>[] = [
  { key: "myThisMonthAttended",  title: "이번달 출근",      icon: CalendarCheck, color: "emerald", description: "본인 체크인 일수" },
  { key: "myThisMonthLeaveDays", title: "이번달 휴가 사용", icon: CalendarOff,   color: "rose",    description: "본인 사용 (일)", format: (v) => v.toFixed(1) },
  { key: "myPendingRequests",    title: "내 결재 대기",     icon: FileText,      color: "amber",   description: "본인 신청 중" },
  { key: "myPendingApprovals",   title: "결재할 요청",      icon: CheckSquare,   color: "blue",    description: "본인 결재함" },
];

const COLOR_MAP: Record<
  CardConfig<string>["color"],
  { bg: string; text: string; iconBg: string }
> = {
  blue:    { bg: "bg-blue-50",    text: "text-blue-600",    iconBg: "bg-blue-100" },
  emerald: { bg: "bg-emerald-50", text: "text-emerald-600", iconBg: "bg-emerald-100" },
  amber:   { bg: "bg-amber-50",   text: "text-amber-600",   iconBg: "bg-amber-100" },
  purple:  { bg: "bg-purple-50",  text: "text-purple-600",  iconBg: "bg-purple-100" },
  rose:    { bg: "bg-rose-50",    text: "text-rose-600",    iconBg: "bg-rose-100" },
  sky:     { bg: "bg-sky-50",     text: "text-sky-600",     iconBg: "bg-sky-100" },
};

function StatCard({
  card,
  value,
}: {
  card: CardConfig<string>;
  value: string;
}) {
  const Icon = card.icon;
  const colors = COLOR_MAP[card.color];
  return (
    <div className="bg-white rounded-2xl border border-gray-100 p-4 sm:p-5 hover:shadow-sm transition-shadow">
      <div className="flex items-start justify-between mb-3">
        <div
          className={`w-10 h-10 rounded-xl flex items-center justify-center ${colors.iconBg}`}
        >
          <Icon size={18} className={colors.text} />
        </div>
      </div>
      <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
        {card.title}
      </p>
      <p className="mt-1 text-2xl sm:text-3xl font-bold text-gray-900 font-mono">
        {value}
      </p>
      <p className="text-xs text-gray-400 mt-1">{card.description}</p>
    </div>
  );
}

function AdminDashboard() {
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const fetchStats = useCallback(async (showRefresh = false) => {
    if (showRefresh) setRefreshing(true);
    else setLoading(true);
    try {
      const res = await fetch("/api/dashboard/stats");
      if (res.ok) setStats(await res.json());
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    fetchStats();
  }, [fetchStats]);

  return (
    <div className="p-4 sm:p-6 space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-3">
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
        <button
          onClick={() => fetchStats(true)}
          disabled={refreshing}
          className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium bg-white border border-gray-200 text-gray-600 rounded-xl hover:bg-gray-50 disabled:opacity-40"
        >
          <RefreshCw size={14} className={refreshing ? "animate-spin" : ""} />
          새로고침
        </button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center h-64">
          <Loader2 size={28} className="animate-spin text-blue-500" />
          <span className="ml-2 text-sm text-gray-500">로딩 중...</span>
        </div>
      ) : (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
          {ADMIN_CARDS.map((card) => {
            const raw = stats?.[card.key] ?? 0;
            const value = card.format
              ? card.format(Number(raw))
              : String(raw);
            return <StatCard key={card.key} card={card} value={value} />;
          })}
        </div>
      )}
    </div>
  );
}

function MyDashboard() {
  const [stats, setStats] = useState<MyStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const fetchStats = useCallback(async (showRefresh = false) => {
    if (showRefresh) setRefreshing(true);
    else setLoading(true);
    try {
      const res = await fetch("/api/dashboard/my-stats");
      if (res.ok) setStats(await res.json());
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    fetchStats();
  }, [fetchStats]);

  return (
    <div className="p-4 sm:p-6 space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-3">
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
        <button
          onClick={() => fetchStats(true)}
          disabled={refreshing}
          className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium bg-white border border-gray-200 text-gray-600 rounded-xl hover:bg-gray-50 disabled:opacity-40"
        >
          <RefreshCw size={14} className={refreshing ? "animate-spin" : ""} />
          새로고침
        </button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center h-64">
          <Loader2 size={28} className="animate-spin text-blue-500" />
          <span className="ml-2 text-sm text-gray-500">로딩 중...</span>
        </div>
      ) : (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
          {MY_CARDS.map((card) => {
            const raw = (stats as any)?.[card.key] ?? 0;
            const value = card.format
              ? card.format(Number(raw))
              : String(raw);
            return <StatCard key={card.key} card={card} value={value} />;
          })}
        </div>
      )}
    </div>
  );
}

export default function DashboardPage() {
  const { isAdmin, loading } = useCurrentEmployee();

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 size={28} className="animate-spin text-blue-500" />
        <span className="ml-2 text-sm text-gray-500">로딩 중...</span>
      </div>
    );
  }

  return isAdmin ? <AdminDashboard /> : <MyDashboard />;
}

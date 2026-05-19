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
  Loader2,
  RefreshCw,
} from "lucide-react";

interface DashboardStats {
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

interface CardConfig {
  key: keyof Omit<DashboardStats, "asOf">;
  title: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  color: "blue" | "emerald" | "amber" | "purple" | "rose" | "sky";
  description: string;
  format?: (v: number) => string;
}

const CARDS: CardConfig[] = [
  {
    key: "activeEmployees",
    title: "활성 직원",
    icon: Users,
    color: "blue",
    description: "현재 재직 중",
  },
  {
    key: "activeDepartments",
    title: "부서",
    icon: Building2,
    color: "purple",
    description: "활성 부서 수",
  },
  {
    key: "activeDevices",
    title: "등록 디바이스",
    icon: Smartphone,
    color: "sky",
    description: "WiFi 폴링 대상",
  },
  {
    key: "pendingRequests",
    title: "결재 대기",
    icon: ClipboardList,
    color: "amber",
    description: "승인 대기 중",
  },
  {
    key: "todayAttended",
    title: "오늘 출근",
    icon: UserCheck,
    color: "emerald",
    description: "현재까지 체크인",
  },
  {
    key: "monthLeaveDays",
    title: "이번달 휴가 사용",
    icon: Calendar,
    color: "rose",
    description: "연차/반차 합계 (일)",
    format: (v) => v.toFixed(1),
  },
  {
    key: "shiftPatterns",
    title: "시프트 패턴",
    icon: Clock,
    color: "blue",
    description: "운영 중인 패턴",
  },
  {
    key: "mappedSsoUsers",
    title: "SSO 매핑",
    icon: LinkIcon,
    color: "emerald",
    description: "포털 SSO 연결됨",
  },
];

const COLOR_MAP: Record<
  CardConfig["color"],
  { bg: string; text: string; iconBg: string }
> = {
  blue: { bg: "bg-blue-50", text: "text-blue-600", iconBg: "bg-blue-100" },
  emerald: {
    bg: "bg-emerald-50",
    text: "text-emerald-600",
    iconBg: "bg-emerald-100",
  },
  amber: { bg: "bg-amber-50", text: "text-amber-600", iconBg: "bg-amber-100" },
  purple: {
    bg: "bg-purple-50",
    text: "text-purple-600",
    iconBg: "bg-purple-100",
  },
  rose: { bg: "bg-rose-50", text: "text-rose-600", iconBg: "bg-rose-100" },
  sky: { bg: "bg-sky-50", text: "text-sky-600", iconBg: "bg-sky-100" },
};

export default function DashboardPage() {
  const [stats, setStats] = useState<DashboardStats | null>(null);
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
      {/* 헤더 */}
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-3">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold text-gray-900">
            대시보드
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

      {/* 통계 카드 그리드 */}
      {loading ? (
        <div className="flex items-center justify-center h-64">
          <Loader2 size={28} className="animate-spin text-blue-500" />
          <span className="ml-2 text-sm text-gray-500">로딩 중...</span>
        </div>
      ) : (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
          {CARDS.map((card) => {
            const Icon = card.icon;
            const colors = COLOR_MAP[card.color];
            const raw = stats?.[card.key] ?? 0;
            const value = card.format
              ? card.format(Number(raw))
              : String(raw);
            return (
              <div
                key={card.key}
                className="bg-white rounded-2xl border border-gray-100 p-4 sm:p-5 hover:shadow-sm transition-shadow"
              >
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
          })}
        </div>
      )}

      {/* 향후 확장 안내 (Phase 5) */}
      <div className="bg-gray-50 border border-gray-100 rounded-2xl p-4 sm:p-5">
        <h3 className="text-sm font-semibold text-gray-700 mb-2">
          곧 추가될 정보
        </h3>
        <ul className="text-xs text-gray-500 space-y-1 list-disc list-inside">
          <li>본인 오늘 시프트 (Phase 5)</li>
          <li>본인 이번달 출근/결근/지각 통계 (Phase 5)</li>
          <li>최근 폴링 상태 (Phase 4)</li>
          <li>월별 본인 확정 상태 (Phase 5)</li>
        </ul>
      </div>
    </div>
  );
}

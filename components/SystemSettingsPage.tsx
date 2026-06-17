"use client";

import { useState } from "react";
import { Layers, Settings, Tag, Bell, CalendarDays, type LucideIcon } from "lucide-react";
import CategoriesPage from "@/components/CategoriesPage";
import PoliciesPage from "@/components/PoliciesPage";
import LookupsPage from "@/components/LookupsPage";
import NotificationSettingsPage from "@/components/NotificationSettingsPage";
import AnnualLeavePolicyPage from "@/components/AnnualLeavePolicyPage";

// Phase 6-2J: 근태 항목/정책/코드 룩업 3개 페이지를 탭 통합. 기본 탭은 categories.
// (calendar 탭은 calendar_sources를 calendar-syncer가 자동 관리하므로 UI 제거)

type SubTab = "categories" | "policies" | "lookups" | "notifications" | "annual";

const TABS: { id: SubTab; label: string; icon: LucideIcon }[] = [
  { id: "categories", label: "근태 항목", icon: Layers },
  { id: "policies", label: "정책 설정", icon: Settings },
  { id: "lookups", label: "코드 룩업", icon: Tag },
  { id: "notifications", label: "알림 설정", icon: Bell },
  { id: "annual", label: "연차 정책", icon: CalendarDays },
];

export default function SystemSettingsPage() {
  const [active, setActive] = useState<SubTab>("categories");

  return (
    <div className="p-4 sm:p-6 space-y-4">
      {/* 상단 탭 버튼 */}
      <div className="bg-white rounded-2xl border border-gray-100 p-2 flex gap-1">
        {TABS.map((tab) => {
          const Icon = tab.icon;
          const isActive = active === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setActive(tab.id)}
              className={`flex-1 flex items-center justify-center gap-2 px-3 py-2 text-sm rounded-xl transition-colors ${
                isActive
                  ? "bg-blue-600 text-white font-semibold"
                  : "text-gray-700 hover:bg-gray-100"
              }`}
            >
              <Icon size={14} />
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* 선택된 탭 내용 — 각 페이지의 기존 헤더/레이아웃 유지 */}
      <div>
        {active === "categories" && <CategoriesPage />}
        {active === "policies" && <PoliciesPage />}
        {active === "lookups" && <LookupsPage />}
        {active === "notifications" && <NotificationSettingsPage />}
        {active === "annual" && <AnnualLeavePolicyPage />}
      </div>
    </div>
  );
}

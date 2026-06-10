"use client";

import { useState } from "react";
import { signOut } from "next-auth/react";
import {
  Home, Calendar, FileText, CheckSquare,
  Users, Building2, Smartphone, Clock,
  Settings, CalendarDays, Plane,
  LogOut, X, ArrowLeft, BarChart3,
} from "lucide-react";

export type PageId =
  | "dashboard" | "my-attendance" | "request" | "approval"
  | "field-trip"
  | "attendance-overview"
  | "schedule-overview"
  | "employees" | "org" | "devices" | "shifts" | "employee-shifts"
  | "approval-lines"
  | "system-settings";

interface NavItem {
  id: PageId;
  label: string;
  icon: React.ElementType;
  group?: string;
  /** true면 admin role 사용자에게만 보임 + 라우팅 허용 */
  adminOnly?: boolean;
}

const NAV_ITEMS: NavItem[] = [
  // 일반 (그룹 헤더 없음)
  { id: "dashboard",      label: "대시보드",      icon: Home },
  { id: "my-attendance",  label: "내 근태",        icon: Calendar },
  { id: "request",        label: "휴가/근태 신청", icon: FileText },
  { id: "field-trip",     label: "출장/외근 관리", icon: Plane },
  { id: "approval",       label: "결재함",         icon: CheckSquare },
  // 관리자
  { id: "attendance-overview", label: "전체 근태 조회", icon: BarChart3,   group: "관리자", adminOnly: true },
  { id: "schedule-overview",   label: "전체 일정 조회", icon: CalendarDays, group: "관리자", adminOnly: true },
  { id: "employees",      label: "직원 관리",      icon: Users,       group: "관리자", adminOnly: true },
  { id: "org",            label: "부서/직급",      icon: Building2,   group: "관리자", adminOnly: true },
  { id: "devices",        label: "디바이스 관리",  icon: Smartphone,  group: "관리자", adminOnly: true },
  { id: "shifts",         label: "시프트 패턴",    icon: Clock,       group: "관리자", adminOnly: true },
  { id: "employee-shifts", label: "직원별 시프트",  icon: Clock,       group: "관리자", adminOnly: true },
  { id: "approval-lines", label: "결재라인 설정",  icon: Users,       group: "관리자", adminOnly: true },
  { id: "system-settings", label: "시스템 설정",   icon: Settings,    group: "관리자", adminOnly: true },
];

/**
 * admin role이어야만 접근 가능한 PageId 집합.
 * app/page.tsx 라우팅 가드에서 사용.
 */
export const ADMIN_ONLY_PAGES: ReadonlySet<PageId> = new Set(
  NAV_ITEMS.filter((i) => i.adminOnly).map((i) => i.id)
);

export function isAdminOnlyPage(page: PageId): boolean {
  return ADMIN_ONLY_PAGES.has(page);
}

interface SidebarProps {
  currentPage: PageId;
  onNavigate: (page: PageId) => void;
  isOpen: boolean;
  onClose: () => void;
  userName?: string;
  userRole?: string;
}

export default function Sidebar({
  currentPage, onNavigate, isOpen, onClose,
  userName = "-", userRole = "-",
}: SidebarProps) {
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);

  const handleNav = (page: PageId) => {
    onNavigate(page);
    if (typeof window !== "undefined" && window.innerWidth < 1024) onClose();
  };

  // CEO와 ADMIN 둘 다 관리자 메뉴 접근 가능
  const isAdmin = userRole === "admin" || userRole === "ceo";
  const visibleItems = NAV_ITEMS.filter((i) => isAdmin || !i.adminOnly);

  const renderNavItems = () => {
    let prevGroup: string | undefined = undefined;
    return visibleItems.map((item) => {
      const showDivider = item.group && item.group !== prevGroup;
      prevGroup = item.group;
      return (
        <div key={item.id}>
          {showDivider && (
            <div className="px-3 pt-3 pb-1">
              <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider px-1">
                {item.group}
              </p>
            </div>
          )}
          <button
            onClick={() => handleNav(item.id)}
            className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm transition-all ${
              currentPage === item.id
                ? "bg-blue-50 text-blue-600 font-semibold"
                : "text-gray-600 hover:bg-gray-50 hover:text-gray-900"
            }`}
          >
            <item.icon size={18} />
            {item.label}
          </button>
        </div>
      );
    });
  };

  return (
    <>
      {isOpen && (
        <div className="fixed inset-0 z-40 bg-black/40 lg:hidden" onClick={onClose} />
      )}

      <aside className={`
        fixed lg:static inset-y-0 left-0 z-50
        w-64 bg-white border-r border-gray-100 flex flex-col
        transition-transform duration-300 shrink-0
        ${isOpen ? "translate-x-0" : "-translate-x-full lg:translate-x-0 lg:w-0 lg:overflow-hidden lg:border-0"}
      `}>
        {/* 포털로 이동 */}
        <a
          href="https://vanam.synology.me"
          className="flex items-center gap-2 px-5 py-3 border-b border-gray-100 text-blue-600 hover:bg-blue-50 transition-colors"
          style={{ textDecoration: "none" }}
        >
          <ArrowLeft size={16} />
          <span className="text-sm font-semibold">VanaM 포털</span>
        </a>

        {/* 로고 */}
        <div className="px-5 py-5 border-b border-gray-100">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 bg-blue-500 rounded-lg flex items-center justify-center">
                <Users size={18} className="text-white" />
              </div>
              <div>
                <h1 className="text-sm font-bold text-gray-900">근태 관리</h1>
                <p className="text-[10px] text-gray-400">HR System</p>
              </div>
            </div>
            <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-gray-100 lg:hidden">
              <X size={18} className="text-gray-400" />
            </button>
          </div>
        </div>

        {/* 네비게이션 */}
        <nav className="flex-1 px-3 py-4 space-y-0.5 overflow-y-auto">
          {renderNavItems()}
        </nav>

        {/* 사용자 정보 + 로그아웃 */}
        <div className="px-3 py-4 border-t border-gray-100">
          <div className="flex items-center gap-3 px-3 py-2">
            <div className="w-8 h-8 bg-gray-200 rounded-full flex items-center justify-center text-xs font-bold text-gray-600 shrink-0">
              {userName.charAt(0) || "?"}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-gray-900 truncate">{userName}</p>
              <p className="text-[10px] text-gray-400">
                {userRole === "ceo"
                  ? "대표"
                  : userRole === "admin"
                  ? "관리자"
                  : userRole === "employee"
                  ? "직원"
                  : userRole === "viewer"
                  ? "조회자"
                  : userRole || "-"}
              </p>
            </div>
            <button
              onClick={() => setShowLogoutConfirm(true)}
              className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-700 transition-colors"
              title="로그아웃"
            >
              <LogOut size={16} />
            </button>
          </div>
        </div>
      </aside>

      {/* 로그아웃 확인 모달 */}
      {showLogoutConfirm && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4" style={{ backgroundColor: "rgba(0,0,0,0.4)" }}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-6 space-y-4">
            <h3 className="text-lg font-bold text-gray-900">로그아웃</h3>
            <p className="text-sm text-gray-500">로그아웃하시겠습니까?</p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setShowLogoutConfirm(false)}
                className="px-4 py-2 text-sm font-medium text-gray-600 bg-gray-100 rounded-xl hover:bg-gray-200">
                취소
              </button>
              <button onClick={() => signOut({ callbackUrl: "/login" })}
                className="px-4 py-2 text-sm font-bold text-white bg-rose-500 rounded-xl hover:bg-rose-600 transition-colors">
                로그아웃
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

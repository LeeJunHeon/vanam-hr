"use client";

import { useState, useEffect } from "react";
import { Menu } from "lucide-react";
import Sidebar, { type SidebarCurrent } from "@/components/Sidebar";
import NotificationBell from "@/components/NotificationBell";
import type { PageId } from "@/lib/menus";

// 공통 화면 틀 — 왼쪽 메뉴(Sidebar) + 상단 헤더(메뉴 열기·알림) + 본문 스크롤 영역.
// 메인 화면(app/page.tsx, 메뉴 상태로 화면 전환)과 독립 주소 화면(/work-hours)이 같이 쓴다.
// 화면 전환 방법은 쓰는 쪽이 onNavigate 로 정한다(메인은 상태 변경, 독립 화면은 /?page= 로 이동).

interface AppShellProps {
  currentPage: SidebarCurrent;
  onNavigate: (page: PageId) => void;
  /** 모바일 헤더에 보이는 화면 이름 */
  title: string;
  userName: string;
  userRole: string;
  /** 알림 클릭 시 linkPage (모르는 키 처리는 쓰는 쪽에서) */
  onNotificationNavigate: (linkPage: string) => void;
  children: React.ReactNode;
}

export default function AppShell({
  currentPage, onNavigate, title, userName, userRole, onNotificationNavigate, children,
}: AppShellProps) {
  const [sidebarOpen, setSidebarOpen] = useState(true);

  // 모바일이면 사이드바 기본 닫힘
  useEffect(() => {
    if (typeof window !== "undefined" && window.innerWidth < 1024) {
      setSidebarOpen(false);
    }
  }, []);

  return (
    <div className="flex h-screen bg-gray-50">
      <Sidebar
        currentPage={currentPage}
        onNavigate={onNavigate}
        isOpen={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        userName={userName}
        userRole={userRole}
      />

      <main className="flex-1 flex flex-col min-w-0">
        <header className="h-14 bg-white border-b border-gray-100 flex items-center justify-between px-4 sm:px-5 shrink-0">
          <div className="flex items-center">
            <button
              onClick={() => setSidebarOpen(!sidebarOpen)}
              className="p-2 rounded-lg hover:bg-gray-100 transition-colors"
            >
              <Menu size={18} className="text-gray-500" />
            </button>
            <span className="text-sm font-semibold text-gray-700 lg:hidden ml-3">
              {title}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <NotificationBell apiUrl="/api/notifications" onNavigate={onNotificationNavigate} />
          </div>
        </header>

        <div className="flex-1 overflow-y-auto">
          {children}
        </div>
      </main>
    </div>
  );
}

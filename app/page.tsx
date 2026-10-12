"use client";

import { useState, useEffect, useCallback } from "react";
import { useSession } from "next-auth/react";
import { Menu } from "lucide-react";
import Sidebar from "@/components/Sidebar";
import { DEFAULT_PAGE, isAdminOnlyPage, isPageId, type PageId } from "@/lib/menus";
import { readPageParam, writePageParam, recordMenuUsage } from "@/lib/launcher";
import NotificationBell from "@/components/NotificationBell";
import DashboardPage from "@/components/DashboardPage";
import MyAttendancePage from "@/components/MyAttendancePage";
import RequestPage from "@/components/RequestPage";
import FieldTripPage from "@/components/FieldTripPage";
import ApprovalPage from "@/components/ApprovalPage";
import EmployeesPage from "@/components/EmployeesPage";
import OrgPage from "@/components/OrgPage";
import DevicesPage from "@/components/DevicesPage";
import ShiftsPage from "@/components/ShiftsPage";
import ApprovalLinesPage from "@/components/ApprovalLinesPage";
import SystemSettingsPage from "@/components/SystemSettingsPage";
import NotMappedNoticePage from "@/components/NotMappedNoticePage";
import AttendanceOverviewPage from "@/components/AttendanceOverviewPage";
import ScheduleOverviewPage from "@/components/ScheduleOverviewPage";
import EmployeeShiftsPage from "@/components/EmployeeShiftsPage";
import AnnualLeavePage from "@/components/AnnualLeavePage";
import { useCurrentEmployee } from "@/lib/useCurrentEmployee";

const PAGE_TITLES: Record<PageId, string> = {
  dashboard: "대시보드",
  "my-attendance": "내 근태",
  request: "휴가 및 근태 신청",
  "field-trip": "출장 및 외근 관리",
  approval: "결재함",
  "attendance-overview": "전체 근태 조회",
  "schedule-overview": "전체 일정 조회",
  "annual-leave": "연차 관리",
  employees: "직원 관리",
  org: "부서/직급",
  devices: "디바이스 관리",
  shifts: "시프트 패턴",
  "employee-shifts": "직원별 시프트",
  "approval-lines": "결재라인 설정",
  "system-settings": "시스템 설정",
};

export default function Home() {
  const { data: session, status: sessionStatus } = useSession();
  const { me, loading: meLoading } = useCurrentEmployee();
  const [page, setPage] = useState<PageId>(DEFAULT_PAGE);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  // 주소의 ?page= 를 읽어 적용한 뒤에만 주소 동기화를 시작 (첫 렌더의 기본 화면으로 주소를 덮어쓰지 않게)
  const [urlReady, setUrlReady] = useState(false);

  // 외부(포털 런처·알림·푸시)에서 ?page=approval 등으로 진입 시 해당 화면으로 시작.
  // 모르는 키는 무시(기본 화면). 권한 없는 키는 아래 가드가 대시보드로 되돌린다.
  useEffect(() => {
    const p = readPageParam();
    if (p) setPage(p);
    setUrlReady(true);
  }, []);

  // 화면이 바뀔 때마다 주소의 page 파라미터를 현재 화면과 맞춘다 (replaceState, 기본 화면이면 제거).
  useEffect(() => {
    if (!urlReady) return;
    writePageParam(page);
  }, [urlReady, page]);

  // 모바일이면 사이드바 기본 닫힘
  useEffect(() => {
    if (typeof window !== "undefined" && window.innerWidth < 1024) {
      setSidebarOpen(false);
    }
  }, []);

  const userName = session?.user?.name ?? "로딩중...";
  const userRole = session?.user?.role ?? "";
  const isAdmin = userRole === "admin" || userRole === "ceo";
  // /api/me 응답 기반 — admin은 매핑 없이도 통과
  const isMapped = me?.isMapped ?? false;
  const showNotMapped = !meLoading && !isAdmin && !isMapped;

  // admin이 아닌데 admin 전용 페이지로 가려고 하면 대시보드로 강제 이동 (사용 기록 안 보냄)
  // 세션 로딩 중엔 role 을 모르므로 기다린다 — 관리자의 ?page=<관리자 메뉴> 진입이 대시보드로 튕기지 않게.
  useEffect(() => {
    if (sessionStatus === "loading") return;
    if (!isAdmin && isAdminOnlyPage(page)) {
      setPage("dashboard");
    }
  }, [sessionStatus, isAdmin, page]);

  // 사용자 조작(사이드바·대시보드 카드·알림 클릭)으로 화면을 바꾸는 유일한 경로.
  // 실제로 다른 메뉴로 옮겼을 때만 포털에 사용 기록 1건을 보낸다.
  const navigate = useCallback(
    (next: PageId) => {
      if (next === page) return;
      setPage(next);
      if (!isAdmin && isAdminOnlyPage(next)) return; // 가드가 되돌릴 화면은 기록하지 않음
      recordMenuUsage(next);
    },
    [page, isAdmin],
  );

  const renderPage = () => {
    // 매핑 안 된 일반 사용자 — 모든 페이지 대신 안내 페이지만 표시
    if (showNotMapped) {
      return (
        <NotMappedNoticePage
          userName={session?.user?.name}
          userEmail={session?.user?.email}
        />
      );
    }
    // 권한 부족 가드 (effect 동기화 전 한 프레임 보호)
    if (!isAdmin && isAdminOnlyPage(page)) {
      return <DashboardPage onNavigate={navigate} />;
    }
    switch (page) {
      case "dashboard":          return <DashboardPage onNavigate={navigate} />;
      case "my-attendance":      return <MyAttendancePage />;
      case "request":            return <RequestPage />;
      case "field-trip":         return <FieldTripPage />;
      case "approval":           return <ApprovalPage />;
      case "attendance-overview": return <AttendanceOverviewPage />;
      case "schedule-overview":   return <ScheduleOverviewPage />;
      case "annual-leave":       return <AnnualLeavePage />;
      case "employees":          return <EmployeesPage />;
      case "org":             return <OrgPage />;
      case "devices":         return <DevicesPage />;
      case "shifts":          return <ShiftsPage />;
      case "employee-shifts": return <EmployeeShiftsPage />;
      case "approval-lines":  return <ApprovalLinesPage />;
      case "system-settings": return <SystemSettingsPage />;
      default:                return <DashboardPage onNavigate={navigate} />;
    }
  };

  return (
    <div className="flex h-screen bg-gray-50">
      <Sidebar
        currentPage={page}
        onNavigate={navigate}
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
              {PAGE_TITLES[page]}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <NotificationBell
              apiUrl="/api/notifications"
              onNavigate={(linkPage) => {
                // 모르는 키면 이동·기록 둘 다 하지 않음
                if (isPageId(linkPage)) navigate(linkPage);
              }}
            />
          </div>
        </header>

        <div className="flex-1 overflow-y-auto">
          {renderPage()}
        </div>
      </main>
    </div>
  );
}

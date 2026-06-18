"use client";

import { useState, useEffect } from "react";
import { useSession } from "next-auth/react";
import { Menu } from "lucide-react";
import Sidebar, { PageId, isAdminOnlyPage } from "@/components/Sidebar";
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
import PersonalInfoPage from "@/components/PersonalInfoPage";
import NotMappedNoticePage from "@/components/NotMappedNoticePage";
import AttendanceOverviewPage from "@/components/AttendanceOverviewPage";
import ScheduleOverviewPage from "@/components/ScheduleOverviewPage";
import EmployeeShiftsPage from "@/components/EmployeeShiftsPage";
import { useCurrentEmployee } from "@/lib/useCurrentEmployee";

const PAGE_TITLES: Record<PageId, string> = {
  dashboard: "대시보드",
  "my-attendance": "내 근태",
  request: "휴가 및 근태 신청",
  "field-trip": "출장 및 외근 관리",
  approval: "결재함",
  "attendance-overview": "전체 근태 조회",
  "schedule-overview": "전체 일정 조회",
  employees: "직원 관리",
  org: "부서/직급",
  devices: "디바이스 관리",
  shifts: "시프트 패턴",
  "employee-shifts": "직원별 시프트",
  "approval-lines": "결재라인 설정",
  "system-settings": "시스템 설정",
  "personal-info": "인사정보 카드",
};

export default function Home() {
  const { data: session } = useSession();
  const { me, loading: meLoading } = useCurrentEmployee();
  const [page, setPage] = useState<PageId>("dashboard");
  const [sidebarOpen, setSidebarOpen] = useState(true);

  // 외부(포털 알림 등)에서 ?page=approval 로 진입 시 해당 탭으로 시작.
  // 최초 1회만 적용하고, 적용 후 쿼리스트링은 제거(뒤로가기/새로고침 깔끔).
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const p = params.get("page");
    const VALID: PageId[] = [
      "dashboard", "my-attendance", "request", "field-trip", "approval",
      "attendance-overview", "schedule-overview", "employees", "org",
      "devices", "shifts", "employee-shifts", "approval-lines", "system-settings",
      "personal-info",
    ];
    if (p && (VALID as string[]).includes(p)) {
      setPage(p as PageId);
      // 쿼리 제거 (히스토리 대체)
      window.history.replaceState({}, "", window.location.pathname);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  // 개인정보 카드 접근 권한 — CEO 또는 LEE Donghak(employeeId=5)
  const canAccessPersonalInfo = userRole === "ceo" || me?.id === 5;

  // admin이 아닌데 admin 전용 페이지로 가려고 하면 대시보드로 강제 이동
  useEffect(() => {
    if (!isAdmin && isAdminOnlyPage(page)) {
      setPage("dashboard");
    }
  }, [isAdmin, page]);

  // 개인정보 권한 없는데 personal-info로 가면 대시보드로
  useEffect(() => {
    if (page === "personal-info" && !canAccessPersonalInfo) {
      setPage("dashboard");
    }
  }, [page, canAccessPersonalInfo]);

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
      return <DashboardPage onNavigate={setPage} />;
    }
    switch (page) {
      case "dashboard":          return <DashboardPage onNavigate={setPage} />;
      case "my-attendance":      return <MyAttendancePage />;
      case "request":            return <RequestPage />;
      case "field-trip":         return <FieldTripPage />;
      case "approval":           return <ApprovalPage />;
      case "attendance-overview": return <AttendanceOverviewPage />;
      case "schedule-overview":   return <ScheduleOverviewPage />;
      case "employees":          return <EmployeesPage />;
      case "org":             return <OrgPage />;
      case "devices":         return <DevicesPage />;
      case "shifts":          return <ShiftsPage />;
      case "employee-shifts": return <EmployeeShiftsPage />;
      case "approval-lines":  return <ApprovalLinesPage />;
      case "system-settings": return <SystemSettingsPage />;
      case "personal-info":   return canAccessPersonalInfo ? <PersonalInfoPage /> : <DashboardPage onNavigate={setPage} />;
      default:                return <DashboardPage onNavigate={setPage} />;
    }
  };

  return (
    <div className="flex h-screen bg-gray-50">
      <Sidebar
        currentPage={page}
        onNavigate={setPage}
        isOpen={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        userName={userName}
        userRole={userRole}
        canAccessPersonalInfo={canAccessPersonalInfo}
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
              onNavigate={(linkPage) => setPage(linkPage as PageId)}
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

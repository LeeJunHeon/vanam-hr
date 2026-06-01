"use client";

import { useState, useEffect } from "react";
import { useSession } from "next-auth/react";
import { Menu } from "lucide-react";
import Sidebar, { PageId, isAdminOnlyPage } from "@/components/Sidebar";
import DashboardPage from "@/components/DashboardPage";
import MyAttendancePage from "@/components/MyAttendancePage";
import RequestPage from "@/components/RequestPage";
import ApprovalPage from "@/components/ApprovalPage";
import EmployeesPage from "@/components/EmployeesPage";
import OrgPage from "@/components/OrgPage";
import DevicesPage from "@/components/DevicesPage";
import ShiftsPage from "@/components/ShiftsPage";
import ApprovalLinesPage from "@/components/ApprovalLinesPage";
import CategoriesPage from "@/components/CategoriesPage";
import PoliciesPage from "@/components/PoliciesPage";
import CalendarPage from "@/components/CalendarPage";
import LookupsPage from "@/components/LookupsPage";
import NotMappedNoticePage from "@/components/NotMappedNoticePage";
import AttendanceOverviewPage from "@/components/AttendanceOverviewPage";
import ScheduleOverviewPage from "@/components/ScheduleOverviewPage";
import EmployeeShiftsPage from "@/components/EmployeeShiftsPage";
import { useCurrentEmployee } from "@/lib/useCurrentEmployee";

const PAGE_TITLES: Record<PageId, string> = {
  dashboard: "대시보드",
  "my-attendance": "내 근태",
  request: "휴가/근태 신청",
  approval: "결재함",
  "attendance-overview": "전체 근태 조회",
  "schedule-overview": "전체 일정 조회",
  employees: "직원 관리",
  org: "부서/직급",
  devices: "디바이스 관리",
  shifts: "시프트 패턴",
  "employee-shifts": "직원별 시프트",
  "approval-lines": "결재선 설정",
  categories: "근태 항목",
  policies: "정책 설정",
  calendar: "Calendar 연동",
  lookups: "코드 룩업",
};

export default function Home() {
  const { data: session } = useSession();
  const { me, loading: meLoading } = useCurrentEmployee();
  const [page, setPage] = useState<PageId>("dashboard");
  const [sidebarOpen, setSidebarOpen] = useState(true);

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

  // admin이 아닌데 admin 전용 페이지로 가려고 하면 대시보드로 강제 이동
  useEffect(() => {
    if (!isAdmin && isAdminOnlyPage(page)) {
      setPage("dashboard");
    }
  }, [isAdmin, page]);

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
      case "approval":           return <ApprovalPage />;
      case "attendance-overview": return <AttendanceOverviewPage />;
      case "schedule-overview":   return <ScheduleOverviewPage />;
      case "employees":          return <EmployeesPage />;
      case "org":             return <OrgPage />;
      case "devices":         return <DevicesPage />;
      case "shifts":          return <ShiftsPage />;
      case "employee-shifts": return <EmployeeShiftsPage />;
      case "approval-lines":  return <ApprovalLinesPage />;
      case "categories":      return <CategoriesPage />;
      case "policies":        return <PoliciesPage />;
      case "calendar":        return <CalendarPage />;
      case "lookups":         return <LookupsPage />;
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
      />

      <main className="flex-1 flex flex-col min-w-0">
        <header className="h-14 bg-white border-b border-gray-100 flex items-center px-4 sm:px-5 shrink-0">
          <button
            onClick={() => setSidebarOpen(!sidebarOpen)}
            className="p-2 rounded-lg hover:bg-gray-100 transition-colors"
          >
            <Menu size={18} className="text-gray-500" />
          </button>
          <span className="text-sm font-semibold text-gray-700 lg:hidden ml-3">
            {PAGE_TITLES[page]}
          </span>
        </header>

        <div className="flex-1 overflow-y-auto">
          {renderPage()}
        </div>
      </main>
    </div>
  );
}

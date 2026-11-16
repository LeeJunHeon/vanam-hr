"use client";

import AppShell from "@/components/AppShell";
import { DEFAULT_PAGE, isPageId, type PageId } from "@/lib/menus";
import { recordMenuUsage } from "@/lib/launcher";
import { withBasePath } from "@/lib/base-path";

// /work-hours(서버 화면)를 공통 틀(AppShell) 안에 보이게 하는 클라이언트 껍데기.
// 다른 메뉴를 누르면 메인 화면의 그 메뉴(/?page=…)로 옮긴다.
// 화면 내부 이동(router.push)은 쓰지 않는다 — 메인 화면은 처음 그려질 때 주소의 ?page= 를 읽는데,
// 내부 이동에서는 그 시점에 주소가 아직 바뀌기 전이라 기본 화면(대시보드)으로 덮어써진다.
// 그래서 basePath(/hr)를 붙인 주소로 페이지를 새로 연다.
export default function WorkHoursShell({
  userName,
  userRole,
  children,
}: {
  userName: string;
  userRole: string;
  children: React.ReactNode;
}) {
  const go = (page: PageId) => {
    recordMenuUsage(page);
    window.location.assign(
      withBasePath(page === DEFAULT_PAGE ? "/" : `/?page=${encodeURIComponent(page)}`)
    );
  };
  return (
    <AppShell
      currentPage="work-hours"
      onNavigate={go}
      title="근무시간 집계"
      userName={userName}
      userRole={userRole}
      onNotificationNavigate={(linkPage) => {
        if (isPageId(linkPage)) go(linkPage);
      }}
    >
      {children}
    </AppShell>
  );
}

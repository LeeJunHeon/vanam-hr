// 근태 앱 메뉴 정의 — 사이드바·화면 가드(isAdminOnlyPage)·딥링크(?page=) 검증·포털 메뉴 목록 API 가 같이 쓴다.
// 서버(route)에서도 import 하므로 React/lucide 컴포넌트는 두지 않고 아이콘은 이름(문자열)으로만 둔다.
// 아이콘 이름은 포털 런처와 맞춘 목록(PortalIconName) 안에서만 쓴다. 사이드바가 이름 → lucide 컴포넌트로 바꾼다.

export type PageId =
  | "dashboard" | "my-attendance" | "request" | "approval"
  | "field-trip"
  | "attendance-overview"
  | "schedule-overview"
  | "annual-leave"
  | "employees" | "org" | "devices" | "shifts" | "employee-shifts"
  | "approval-lines"
  | "system-settings";

/** 포털 런처가 그릴 수 있는 아이콘 이름 (포털과 공통 계약 — 바꾸지 말 것) */
export type PortalIconName =
  | "Home" | "Package" | "BarChart3" | "Clock" | "QrCode" | "Search" | "Layers" | "Target"
  | "Droplet" | "Building2" | "Users" | "FileText" | "Wrench" | "Wind" | "Sparkles" | "Settings"
  | "Cpu" | "Calendar" | "Plane" | "CheckSquare" | "CalendarDays" | "CalendarCheck" | "Smartphone"
  | "Award" | "IdCard" | "LayoutDashboard" | "ListChecks" | "ClipboardList" | "History" | "Gauge";

export interface MenuItem {
  id: PageId;
  label: string;
  icon: PortalIconName;
  group?: string;
  /** true면 admin role 사용자에게만 보임 + 라우팅 허용 */
  adminOnly?: boolean;
}

/** 기본 화면 — 주소에 ?page= 가 없을 때 */
export const DEFAULT_PAGE: PageId = "dashboard";

/** 사이드바 순서 그대로 */
export const MENU_ITEMS: readonly MenuItem[] = [
  // 일반 (그룹 헤더 없음)
  { id: "dashboard",      label: "대시보드",      icon: "Home" },
  { id: "my-attendance",  label: "내 근태",        icon: "Calendar" },
  { id: "request",        label: "휴가 및 근태 신청", icon: "FileText" },
  { id: "field-trip",     label: "출장 및 외근 관리", icon: "Plane" },
  { id: "approval",       label: "결재함",         icon: "CheckSquare" },
  // 관리자
  { id: "attendance-overview", label: "전체 근태 조회", icon: "BarChart3",   group: "관리자", adminOnly: true },
  { id: "schedule-overview",   label: "전체 일정 조회", icon: "CalendarDays", group: "관리자", adminOnly: true },
  { id: "annual-leave",   label: "연차 관리",      icon: "CalendarCheck", group: "관리자", adminOnly: true },
  { id: "employees",      label: "직원 관리",      icon: "Users",       group: "관리자", adminOnly: true },
  { id: "org",            label: "부서/직급",      icon: "Building2",   group: "관리자", adminOnly: true },
  { id: "devices",        label: "디바이스 관리",  icon: "Smartphone",  group: "관리자", adminOnly: true },
  { id: "shifts",         label: "시프트 패턴",    icon: "Clock",       group: "관리자", adminOnly: true },
  { id: "employee-shifts", label: "직원별 시프트",  icon: "Clock",       group: "관리자", adminOnly: true },
  { id: "approval-lines", label: "결재라인 설정",  icon: "Users",       group: "관리자", adminOnly: true },
  { id: "system-settings", label: "시스템 설정",   icon: "Settings",    group: "관리자", adminOnly: true },
];

const PAGE_IDS: ReadonlySet<string> = new Set(MENU_ITEMS.map((i) => i.id));

/** 알 수 없는 문자열(주소·알림 linkPage)이 메뉴 키인지 */
export function isPageId(value: unknown): value is PageId {
  return typeof value === "string" && PAGE_IDS.has(value);
}

/**
 * admin role이어야만 접근 가능한 PageId 집합.
 * app/page.tsx 라우팅 가드에서 사용.
 */
export const ADMIN_ONLY_PAGES: ReadonlySet<PageId> = new Set(
  MENU_ITEMS.filter((i) => i.adminOnly).map((i) => i.id)
);

export function isAdminOnlyPage(page: PageId): boolean {
  return ADMIN_ONLY_PAGES.has(page);
}

/** 사이드바에 보이는 메뉴 (CEO와 ADMIN 둘 다 관리자 메뉴 접근 가능) */
export function visibleMenuItems(isAdmin: boolean): MenuItem[] {
  return MENU_ITEMS.filter((i) => {
    if (i.adminOnly) return isAdmin;
    return true;
  });
}

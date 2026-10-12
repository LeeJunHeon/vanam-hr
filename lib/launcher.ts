// 포털 런처 연동 (클라이언트 전용) — 메뉴 주소(?page=) 읽기·쓰기 + 메뉴 사용 기록 전송.
// window·location 을 만지므로 반드시 useEffect / 이벤트 핸들러 안에서만 호출한다.
import { DEFAULT_PAGE, isPageId, type PageId } from "@/lib/menus";

const APP_KEY = "hr";

/** 지금 주소의 ?page= 가 아는 메뉴 키면 그 키, 아니면 null */
export function readPageParam(): PageId | null {
  if (typeof window === "undefined") return null;
  const p = new URLSearchParams(window.location.search).get("page");
  return isPageId(p) ? p : null;
}

/**
 * 주소의 page 파라미터를 현재 화면과 맞춘다 (replaceState — 히스토리 항목을 늘리지 않음).
 * 기본 화면이면 page 를 지우고, 다른 쿼리 파라미터·해시는 그대로 둔다.
 */
export function writePageParam(page: PageId): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (page === DEFAULT_PAGE) url.searchParams.delete("page");
  else url.searchParams.set("page", page);
  if (url.href === window.location.href) return;
  window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
}

/**
 * 포털에 메뉴 사용 1건을 보낸다. 실패는 조용히 무시(포털 API 배포 전엔 404 가 정상).
 * BasePathFetch 가 "/" 로 시작하는 주소에 basePath(/hr)를 붙이므로 반드시 origin 을 붙인 절대 주소로 보낸다.
 */
export function recordMenuUsage(page: PageId): void {
  if (typeof window === "undefined") return;
  try {
    const url = `${window.location.origin}/api/launcher/usage`;
    const body = JSON.stringify({ app: APP_KEY, page });
    if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
      navigator.sendBeacon(url, new Blob([body], { type: "application/json" }));
      return;
    }
    fetch(url, {
      method: "POST",
      keepalive: true,
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body,
    }).catch(() => {});
  } catch {
    /* 기록 실패는 화면 동작에 영향 없음 */
  }
}

"use client";

// 운영에서 basePath(예: /hr)가 설정되면, 코드 곳곳의 절대경로 fetch("/api/...") 호출을
// 런타임에 `${basePath}/api/...` 로 보정한다. (Next의 basePath는 fetch를 자동 보정하지 않기 때문)
// NEXT_PUBLIC_BASE_PATH 가 비어 있으면(로컬/현재 운영) 아무 것도 하지 않는다 → 무동작.
const BP = process.env.NEXT_PUBLIC_BASE_PATH || "";

if (
  BP &&
  typeof window !== "undefined" &&
  !(window as unknown as { __bpPatched?: boolean }).__bpPatched
) {
  (window as unknown as { __bpPatched?: boolean }).__bpPatched = true;
  const orig = window.fetch.bind(window);
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (
      typeof input === "string" &&
      input.startsWith("/") &&
      !input.startsWith("//") &&
      input !== BP &&
      !input.startsWith(BP + "/")
    ) {
      input = BP + input;
    }
    return orig(input, init);
  }) as typeof window.fetch;
}

export default function BasePathFetch() {
  return null;
}

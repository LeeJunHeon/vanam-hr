// basePath(운영 /hr) 보정 — NEXT_PUBLIC_BASE_PATH 가 비어 있으면(로컬) 아무 것도 붙이지 않는다.
// BasePathFetch 의 fetch 보정과 <a href>·window.open 주소가 같은 규칙을 쓴다.

export const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH || "";

/**
 * "/"로 시작하고 "//"가 아니며 아직 basePath 가 붙지 않은 경로에만 basePath 를 붙인다.
 * 그 밖(외부 주소, 프로토콜 상대 주소, 이미 붙은 경로)은 그대로.
 */
export function withBasePath(path: string, basePath: string = BASE_PATH): string {
  if (
    basePath &&
    path.startsWith("/") &&
    !path.startsWith("//") &&
    path !== basePath &&
    !path.startsWith(basePath + "/")
  ) {
    return basePath + path;
  }
  return path;
}

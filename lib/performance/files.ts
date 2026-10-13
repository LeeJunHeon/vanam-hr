// 성과표 증빙 첨부 파일 규칙 — 서버(업로드·다운로드 API)와 화면이 같이 쓴다.
// ⚠ prisma 등 서버 전용 모듈을 import 하지 말 것 (클라이언트 번들에 들어감).

/** 확장자 → MIME. MIME 은 브라우저가 보낸 file.type 을 쓰지 않고 이 표로만 정한다 */
export const PERF_FILE_EXT_MIME: Record<string, string> = {
  pdf: "application/pdf",
  hwp: "application/x-hwp",
  hwpx: "application/hwp+zip",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  csv: "text/csv",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  txt: "text/plain",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  heic: "image/heic",
  zip: "application/zip",
};

/** 허용 확장자 (소문자) */
export const PERF_FILE_EXTS = Object.keys(PERF_FILE_EXT_MIME);

/** file input accept 값 */
export const PERF_FILE_ACCEPT = PERF_FILE_EXTS.map((e) => `.${e}`).join(",");

/** 브라우저에서 바로 여는(inline) MIME — 그 밖은 내려받기(attachment) */
const INLINE_MIMES = new Set(["application/pdf", "image/png", "image/jpeg", "image/gif", "image/webp"]);

/** 증빙 칸 하나에 붙일 수 있는 파일 수 (칸의 maxFiles 기본값) */
export const EVIDENCE_MAX_FILES = 5;
/** 성과표 하나에 올릴 수 있는 파일 수 */
export const PERF_FILES_PER_SHEET = 50;
/** 파일 한 개 최대 크기 기본값(MB) — policy perf_file_max_mb 가 없거나 잘못됐을 때 */
export const PERF_FILE_DEFAULT_MAX_MB = 10;
/**
 * 파일 한 개 최대 크기 코드 상한(MB) — policy 값이 이보다 크면 이 값.
 * ⚠ next.config.ts 의 experimental.proxyClientMaxBodySize(25mb)보다 작게 유지한다
 *    (그보다 큰 요청 본문은 proxy 단계에서 잘린다).
 */
export const PERF_FILE_MAX_MB_LIMIT = 20;

const FILE_NAME_MAX = 255;

export interface PerfFileMeta {
  id: number;
  fileName: string;
  mimeType: string;
  fileSize: number;
}

/** 화면 업로드 함수의 결과 */
export type PerfUploadResult = { ok: true; file: PerfFileMeta } | { ok: false; error: string };

/** 파일 이름의 확장자 (소문자, 없으면 "") */
export function fileExt(fileName: string): string {
  const i = fileName.lastIndexOf(".");
  return i < 0 ? "" : fileName.slice(i + 1).toLowerCase();
}

/** 허용 확장자면 MIME, 아니면 null */
export function mimeForExt(ext: string): string | null {
  return Object.prototype.hasOwnProperty.call(PERF_FILE_EXT_MIME, ext) ? PERF_FILE_EXT_MIME[ext] : null;
}

/** 브라우저에서 바로 열지(inline) — pdf·png·jpg·jpeg·gif·webp */
export function isInlineMime(mimeType: string): boolean {
  return INLINE_MIMES.has(mimeType);
}

/** 허용되지 않는 형식일 때의 오류 문구 */
export function fileTypeError(): string {
  return `허용되지 않는 파일 형식입니다. (${PERF_FILE_EXTS.join(", ")})`;
}

/**
 * 저장할 파일 이름 — 경로 구분자·제어 문자를 빼고 trim, 255자 이내(확장자 유지).
 * 비면 "file.{확장자}".
 */
export function sanitizeFileName(raw: string, ext: string): string {
  const cleaned = raw.replace(/[\\/\u0000-\u001f\u007f]/g, "").trim();
  if (!cleaned) return `file.${ext}`;
  const chars = Array.from(cleaned);
  if (chars.length <= FILE_NAME_MAX) return cleaned;
  const suffix = `.${ext}`;
  const base = chars.slice(0, FILE_NAME_MAX - suffix.length).join("").trimEnd();
  return `${base}${suffix}`;
}

/** 열기·내려받기 주소 (basePath 없음 — <a href> 에는 withBasePath 로 감싼다) */
export function perfFileUrl(id: number): string {
  return `/api/performance/files/${id}`;
}

/** 메타 배열 → id 맵 */
export function filesById(files: PerfFileMeta[]): Record<number, PerfFileMeta> {
  return Object.fromEntries(files.map((f) => [f.id, f]));
}

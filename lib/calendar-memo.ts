// 캘린더 일정 메모(설명)의 "기본 틀(헤더)" 공용 헬퍼.
// 저장 형식: <헤더 3줄> + (추가 메모 있으면) "\n\n" + <추가 메모>
// 헤더 첫 줄은 항상 MEMO_HEADER_TAG 로 고정 → 추출/결합 안전.

export const MEMO_HEADER_TAG = "[VanaM HR 자동 등록]";

export function buildMemoHeader(opts: {
  name?: string | null;
  dept?: string | null;
  categoryName: string;
}): string {
  const deptSuffix = opts.dept ? ` (${opts.dept})` : "";
  return [
    MEMO_HEADER_TAG,
    `신청자: ${opts.name || "-"}${deptSuffix}`,
    `카테고리: ${opts.categoryName}`,
  ].join("\n");
}

// 저장된 전체 메모에서 '추가 메모'(헤더 아래 사용자 입력)만 추출.
// 헤더가 없으면(레거시) 전체를 메모로 간주(손실 방지).
export function extractMemoNotes(full: string | null | undefined): string {
  const text = full ?? "";
  const lines = text.split("\n");
  if (lines[0]?.trim() === MEMO_HEADER_TAG) {
    return lines.slice(3).join("\n").replace(/^\n+/, "");
  }
  return text;
}

// 저장된 전체 메모에서 기존 헤더(첫 3줄)를 추출. 헤더 없으면 fallback 반환.
export function extractMemoHeader(
  full: string | null | undefined,
  fallback: string,
): string {
  const text = full ?? "";
  const lines = text.split("\n");
  if (lines[0]?.trim() === MEMO_HEADER_TAG) {
    return lines.slice(0, 3).join("\n");
  }
  return fallback;
}

export function composeMemo(header: string, notes: string | null | undefined): string {
  const n = (notes ?? "").trim();
  return n ? `${header}\n\n${n}` : header;
}

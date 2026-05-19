// MAC 주소 정규화 + 표시용 포맷 헬퍼
// 향후 polling 데몬 / presence 페이지 등에서도 재사용

export function normalizeMacAddress(input: string): string | null {
  if (typeof input !== "string") return null;
  // 콜론, 하이픈, 공백, 점 모두 제거
  const cleaned = input.replace(/[:\-\s.]/g, "").toLowerCase();
  // 12자리 hex 검증
  if (!/^[0-9a-f]{12}$/.test(cleaned)) return null;
  return cleaned;
}

export function formatMacAddress(mac: string): string {
  // "aabbccddeeff" → "AA:BB:CC:DD:EE:FF"
  if (mac.length !== 12) return mac;
  return mac.toUpperCase().match(/.{2}/g)!.join(":");
}

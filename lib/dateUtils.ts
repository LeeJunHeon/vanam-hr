// 한국 로컬 시간 기준 YYYY-MM-DD 헬퍼.
// 컨테이너 TZ=Asia/Seoul 설정되어 있으므로 브라우저 로컬 시간 = 한국 시간.
// new Date().toISOString()은 UTC 기준이라 한국 새벽 0~9시에 어제로 표시되는 버그가 있어
// 모든 페이지가 이 헬퍼를 사용한다.

// 한국 로컬 시간 기준 오늘 YYYY-MM-DD
export function todayYmd(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

// 한국 로컬 시간 기준 이번달 1일 YYYY-MM-DD
export function firstOfMonthYmd(): string {
  const d = new Date();
  d.setDate(1);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

// 임의의 Date를 한국 로컬 기준 YYYY-MM-DD로
export function ymdFromDate(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

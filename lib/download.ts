// 클라 공용 파일 다운로드 헬퍼.
// fetch → 에러면 서버 error 메시지로 throw, 성공이면 Content-Disposition 파일명으로 저장.
export async function downloadFile(
  url: string,
  init?: RequestInit,
  fallbackName = "download.xlsx"
): Promise<void> {
  const res = await fetch(url, init);
  if (!res.ok) {
    let msg = `다운로드 실패 (${res.status})`;
    try {
      const j = await res.json();
      if (j?.error) msg = j.error;
    } catch {
      // JSON 파싱 실패 시 기본 메시지 유지
    }
    throw new Error(msg);
  }

  // Content-Disposition 의 filename*=UTF-8'' 파싱
  let filename = fallbackName;
  const cd = res.headers.get("Content-Disposition") ?? "";
  const star = cd.match(/filename\*=UTF-8''([^;]+)/i);
  if (star?.[1]) {
    try {
      filename = decodeURIComponent(star[1]);
    } catch {
      // 디코딩 실패 시 fallback 유지
    }
  }

  const blob = await res.blob();
  const objUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = objUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(objUrl), 1000);
}

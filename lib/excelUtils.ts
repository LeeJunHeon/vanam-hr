import { downloadFile } from "@/lib/download";

// 클라 공용 엑셀 내보내기 (기존 CSV 유틸 대체).
// 서버 POST /api/export/xlsx 로 표 데이터를 보내 xlsx를 받아 저장한다.
// (exceljs는 서버에서만 import — 여기서는 절대 import하지 않는다)
export async function exportExcel(
  headers: string[],
  rows: (string | number | null | undefined)[][],
  filename: string, // 예: "직원_2026-07-13.xlsx"
  sheetName = "Sheet1"
): Promise<void> {
  await downloadFile(
    "/api/export/xlsx",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sheetName, headers, rows, filename }),
    },
    filename
  );
}

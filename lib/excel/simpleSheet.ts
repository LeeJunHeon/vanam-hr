import ExcelJS from "exceljs";

// 서버 전용 범용 단순표 워크북 생성기.
// 모든 셀은 String(v ?? "")로 강제해 null 안전을 보장한다 (CSV escape 버그의 근본 방지).
export function buildSimpleWorkbook(p: {
  sheetName: string;
  headers: string[];
  rows: unknown[][];
}): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(p.sheetName || "Sheet1");

  // 1행 = 헤더
  const headerRow = ws.addRow(p.headers.map((h) => String(h ?? "")));
  headerRow.eachCell((cell) => {
    cell.font = { bold: true };
    cell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FFF3F4F6" },
    };
    cell.border = { bottom: { style: "thin", color: { argb: "FFD1D5DB" } } };
  });

  // 데이터 행 (모든 셀 문자열 강제)
  for (const row of p.rows) {
    ws.addRow(row.map((v) => String(v ?? "")));
  }

  // 1행 고정
  ws.views = [{ state: "frozen", ySplit: 1 }];

  // 열 너비 = 열별 내용 최대 길이 기준 (min 8, max 40)
  const colCount = p.headers.length;
  for (let c = 0; c < colCount; c++) {
    let maxLen = String(p.headers[c] ?? "").length;
    for (const row of p.rows) {
      const len = String(row[c] ?? "").length;
      if (len > maxLen) maxLen = len;
    }
    ws.getColumn(c + 1).width = Math.min(40, Math.max(8, maxLen + 2));
  }

  return wb;
}

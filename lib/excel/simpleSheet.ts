import ExcelJS from "exceljs";

// 한글/한자/전각은 폭 2로 계산 (Excel 열 너비 근사)
function displayLen(s: string): number {
  // U+1100–11FF, U+3130–318F, U+AC00–D7A3(한글) / U+4E00–9FFF(한자)
  // / U+3000–303F, U+FF00–FFEF(전각) 은 폭 2로 계산.
  const wide =
    /[ᄀ-ᇿ㄰-㆏가-힣一-鿿　-〿＀-￯]/;
  let n = 0;
  for (const ch of s) {
    n += wide.test(ch) ? 2 : 1;
  }
  return n;
}

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

  // 열 너비 = 열별 내용 최대 표시폭 기준 (한글 폭 2, min 8, max 50)
  const colCount = p.headers.length;
  for (let c = 0; c < colCount; c++) {
    let maxLen = displayLen(String(p.headers[c] ?? ""));
    for (const row of p.rows) {
      const len = displayLen(String(row[c] ?? ""));
      if (len > maxLen) maxLen = len;
    }
    ws.getColumn(c + 1).width = Math.min(50, Math.max(8, maxLen + 2));
  }

  return wb;
}

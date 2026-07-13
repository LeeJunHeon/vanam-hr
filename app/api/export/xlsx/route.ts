import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-helpers";
import { buildSimpleWorkbook } from "@/lib/excel/simpleSheet";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/export/xlsx — 범용 단순표 xlsx 생성.
// 데이터는 클라이언트가 이미 화면에서 본 것이므로 인증만 확인(추가 권한 노출 없음).
export async function POST(request: Request) {
  const r = await requireSession();
  if (!r.ok) return r.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "잘못된 요청 본문입니다." }, { status: 400 });
  }

  const { sheetName, headers, rows, filename } = (body ?? {}) as {
    sheetName?: unknown;
    headers?: unknown;
    rows?: unknown;
    filename?: unknown;
  };

  if (!Array.isArray(headers) || headers.length < 1 || headers.length > 200) {
    return NextResponse.json(
      { error: "headers는 1~200개여야 합니다." },
      { status: 400 }
    );
  }
  if (!Array.isArray(rows) || rows.length > 50000) {
    return NextResponse.json(
      { error: "rows는 최대 50000행까지 가능합니다." },
      { status: 400 }
    );
  }
  if (!rows.every((row) => Array.isArray(row))) {
    return NextResponse.json(
      { error: "rows의 각 행은 배열이어야 합니다." },
      { status: 400 }
    );
  }

  const safeSheetName =
    typeof sheetName === "string" && sheetName.trim() ? sheetName : "Sheet1";
  const rawName =
    typeof filename === "string" && filename.trim() ? filename : "export";
  const safeFilename = rawName.endsWith(".xlsx") ? rawName : `${rawName}.xlsx`;

  const wb = buildSimpleWorkbook({
    sheetName: safeSheetName,
    headers: headers.map((h) => String(h ?? "")),
    rows: rows as unknown[][],
  });

  const buffer = await wb.xlsx.writeBuffer();
  const bytes = new Uint8Array(buffer as ArrayBuffer);

  return new Response(bytes, {
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="export.xlsx"; filename*=UTF-8''${encodeURIComponent(
        safeFilename
      )}`,
      "Cache-Control": "no-store",
    },
  });
}

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/auth-helpers";
import {
  PERF_FILES_PER_SHEET,
  fileExt,
  fileTypeError,
  mimeForExt,
  sanitizeFileName,
} from "@/lib/performance/files";
import { PERF_FORM_VERSION } from "@/lib/performance/form";
import { checkQuarter, getSheetAccess, parseYearQuarter } from "@/lib/performance/rules";
import {
  PERF_FILE_META_SELECT,
  cycleDates,
  loadFileMaxMb,
  loadStartQuarter,
  perfTodayYmd,
  requireEmployeeId,
} from "@/lib/performance/server";

export const dynamic = "force-dynamic";

// POST /api/performance/my/files — 증빙 파일 올리기 (multipart: year, quarter, file)
// 칸 값에 id 를 넣는 것은 화면이 한다(자동 저장). 어디에도 쓰이지 않는 파일은 저장·제출 때 서버가 정리한다.
export async function POST(request: NextRequest) {
  try {
    const sessionR = await requireSession();
    if (!sessionR.ok) return sessionR.response;
    const empR = requireEmployeeId(sessionR.session);
    if (!empR.ok) return empR.response;
    const { employeeId } = empR;

    const maxMb = await loadFileMaxMb();
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      // 본문이 너무 커서 잘렸거나 multipart 가 아닌 경우
      return NextResponse.json(
        { error: `파일을 읽지 못했습니다. 파일 크기는 ${maxMb}MB를 넘을 수 없습니다.` },
        { status: 400 }
      );
    }

    const yq = parseYearQuarter(form.get("year"), form.get("quarter"));
    if (!yq) return NextResponse.json({ error: "연도와 분기가 올바르지 않습니다." }, { status: 400 });
    const todayYmd = perfTodayYmd();
    const quarterError = checkQuarter(yq, todayYmd, await loadStartQuarter());
    if (quarterError) return NextResponse.json({ error: quarterError }, { status: 400 });

    const file = form.get("file");
    if (!file || typeof file === "string") {
      return NextResponse.json({ error: "파일이 없습니다." }, { status: 400 });
    }
    const ext = fileExt(file.name || "");
    const mimeType = mimeForExt(ext);
    if (!mimeType) return NextResponse.json({ error: fileTypeError() }, { status: 400 });
    if (file.size === 0) {
      return NextResponse.json({ error: "빈 파일은 올릴 수 없습니다." }, { status: 400 });
    }
    if (file.size > maxMb * 1024 * 1024) {
      return NextResponse.json({ error: `파일 크기는 ${maxMb}MB를 넘을 수 없습니다.` }, { status: 400 });
    }

    // 편집 가능 검사 + 성과표가 없으면 draft 로 만든다 (PUT my/sheet 와 같은 규칙)
    const ensureSheet = () => prisma.$transaction(async (tx) => {
      const [sheet, cycle] = await Promise.all([
        tx.perfSheet.findUnique({
          where: { employeeId_year_quarter: { employeeId, ...yq } },
          select: { id: true, status: true },
        }),
        tx.perfCycle.findUnique({ where: { year_quarter: yq } }),
      ]);
      const access = getSheetAccess({
        ...yq,
        todayYmd,
        sheetStatus: sheet?.status ?? null,
        cycle: cycle ? cycleDates(cycle) : null,
        isTarget: cycle ? cycle.targetEmployeeIds.includes(employeeId) : false,
      });
      if (!access.canEdit) return { ok: false as const, reason: access.reason };
      if (sheet) return { ok: true as const, sheetId: sheet.id };
      const created = await tx.perfSheet.create({
        data: { employeeId, ...yq, formVersion: PERF_FORM_VERSION, status: "draft" },
        select: { id: true },
      });
      return { ok: true as const, sheetId: created.id };
    });
    // 첫 저장과 동시에 들어와 같은 행을 만들려 하면(유니크 충돌) 한 번 더 시도
    let result: Awaited<ReturnType<typeof ensureSheet>>;
    try {
      result = await ensureSheet();
    } catch (e) {
      if ((e as { code?: string })?.code !== "P2002") throw e;
      result = await ensureSheet();
    }
    if (!result.ok) {
      return NextResponse.json({ error: result.reason ?? "수정할 수 없습니다." }, { status: 409 });
    }

    const count = await prisma.perfFile.count({ where: { sheetId: result.sheetId } });
    if (count >= PERF_FILES_PER_SHEET) {
      return NextResponse.json(
        { error: `성과표 하나에 파일은 ${PERF_FILES_PER_SHEET}개까지 올릴 수 있습니다.` },
        { status: 400 }
      );
    }

    const data = new Uint8Array(await file.arrayBuffer());
    const created = await prisma.perfFile.create({
      data: {
        sheetId: result.sheetId,
        fileName: sanitizeFileName(file.name || "", ext),
        mimeType,
        fileSize: data.length,
        fileData: data,
      },
      select: PERF_FILE_META_SELECT,
    });
    return NextResponse.json(created);
  } catch (error) {
    console.error("POST /api/performance/my/files error:", error);
    return NextResponse.json({ error: "파일 올리기 실패" }, { status: 500 });
  }
}

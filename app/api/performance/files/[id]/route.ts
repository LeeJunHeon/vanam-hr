import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { isAdminSession, requireSession } from "@/lib/auth-helpers";
import { isInlineMime } from "@/lib/performance/files";
import { collectEvidenceFileIds, sanitizeContent } from "@/lib/performance/form";

export const dynamic = "force-dynamic";

const NOT_FOUND = "파일을 찾을 수 없습니다.";

// GET /api/performance/files/[id] — 증빙 파일 열기·내려받기 (직원·관리자 공용)
// 허용: 그 성과표의 본인, 또는 관리자이면서 제출 이력이 있고 제출본(submitted_content)이 그 파일을 참조할 때.
// 그 밖은 파일이 있든 없든 404. 권한 확인은 메타만 읽어서 하고, 통과한 뒤에 file_data 를 읽는다.
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const r = await requireSession();
    if (!r.ok) return r.response;
    const { session } = r;

    const { id: idRaw } = await params;
    const id = Number(idRaw);
    if (!Number.isInteger(id) || id <= 0) {
      return NextResponse.json({ error: "잘못된 파일 id입니다." }, { status: 400 });
    }

    const meta = await prisma.perfFile.findUnique({
      where: { id },
      select: {
        fileName: true,
        mimeType: true,
        sheet: { select: { employeeId: true, submittedAt: true, submittedContent: true } },
      },
    });
    if (!meta) return NextResponse.json({ error: NOT_FOUND }, { status: 404 });

    const isOwner = meta.sheet.employeeId === session.user.employeeId;
    const adminCanSee =
      isAdminSession(session) &&
      meta.sheet.submittedAt != null &&
      collectEvidenceFileIds(sanitizeContent(meta.sheet.submittedContent)).includes(id);
    if (!isOwner && !adminCanSee) {
      return NextResponse.json({ error: NOT_FOUND }, { status: 404 });
    }

    const row = await prisma.perfFile.findUnique({ where: { id }, select: { fileData: true } });
    if (!row) return NextResponse.json({ error: NOT_FOUND }, { status: 404 });

    const body = Buffer.from(row.fileData);
    const disposition = isInlineMime(meta.mimeType) ? "inline" : "attachment";
    return new NextResponse(body, {
      headers: {
        "Content-Type": meta.mimeType,
        "Content-Length": String(body.length),
        // 한글 파일명 대응 (근태 첨부와 같은 방식)
        "Content-Disposition": `${disposition}; filename*=UTF-8''${encodeURIComponent(meta.fileName)}`,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
      },
    });
  } catch (error) {
    console.error("GET /api/performance/files/[id] error:", error);
    return NextResponse.json({ error: "파일 열기 실패" }, { status: 500 });
  }
}

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession, isAdminSession } from "@/lib/auth-helpers";

/** 이미지/PDF는 브라우저에서 미리보기, 그 외(hwp/doc 등)는 다운로드 */
function isInlineType(mimeType: string): boolean {
  return mimeType.startsWith("image/") || mimeType === "application/pdf";
}

export async function GET(
  _request: NextRequest,
  ctx: { params: Promise<{ id: string; fileId: string }> }
) {
  const r = await requireSession();
  if (!r.ok) return r.response;
  const { session } = r;

  const { id: idStr, fileId: fileIdStr } = await ctx.params;
  const id = Number(idStr);
  const fileId = Number(fileIdStr);
  if (!Number.isInteger(id) || !Number.isInteger(fileId)) {
    return NextResponse.json({ error: "id가 올바르지 않습니다." }, { status: 400 });
  }

  const daily = await prisma.attendanceDaily.findUnique({
    where: { id },
    select: { id: true, employeeId: true },
  });
  if (!daily) {
    return NextResponse.json({ error: "근태 기록을 찾을 수 없습니다." }, { status: 404 });
  }

  // 권한: 본인 또는 관리자
  if (daily.employeeId !== session.user.employeeId && !isAdminSession(session)) {
    return NextResponse.json({ error: "조회 권한이 없습니다." }, { status: 403 });
  }

  const file = await prisma.attendanceReasonFile.findUnique({
    where: { id: fileId },
    select: { dailyId: true, fileName: true, mimeType: true, fileData: true },
  });
  if (!file || file.dailyId !== id) {
    return NextResponse.json({ error: "첨부파일을 찾을 수 없습니다." }, { status: 404 });
  }

  const buffer = Buffer.from(file.fileData, "base64");
  const disposition = isInlineType(file.mimeType) ? "inline" : "attachment";

  return new NextResponse(buffer, {
    headers: {
      "Content-Type": file.mimeType,
      "Content-Length": String(buffer.length),
      // 한글 파일명 대응
      "Content-Disposition": `${disposition}; filename*=UTF-8''${encodeURIComponent(
        file.fileName
      )}`,
    },
  });
}

export async function DELETE(
  _request: NextRequest,
  ctx: { params: Promise<{ id: string; fileId: string }> }
) {
  const r = await requireSession();
  if (!r.ok) return r.response;
  const { session } = r;

  const { id: idStr, fileId: fileIdStr } = await ctx.params;
  const id = Number(idStr);
  const fileId = Number(fileIdStr);
  if (!Number.isInteger(id) || !Number.isInteger(fileId)) {
    return NextResponse.json({ error: "id가 올바르지 않습니다." }, { status: 400 });
  }

  const daily = await prisma.attendanceDaily.findUnique({
    where: { id },
    select: { id: true, employeeId: true },
  });
  if (!daily) {
    return NextResponse.json({ error: "근태 기록을 찾을 수 없습니다." }, { status: 404 });
  }

  // 권한: 본인만 삭제 가능
  if (daily.employeeId !== session.user.employeeId) {
    return NextResponse.json(
      { error: "본인 첨부파일만 삭제할 수 있습니다." },
      { status: 403 }
    );
  }

  const file = await prisma.attendanceReasonFile.findUnique({
    where: { id: fileId },
    select: { id: true, dailyId: true },
  });
  if (!file || file.dailyId !== id) {
    return NextResponse.json({ error: "첨부파일을 찾을 수 없습니다." }, { status: 404 });
  }

  await prisma.attendanceReasonFile.delete({ where: { id: fileId } });
  return NextResponse.json({ ok: true });
}

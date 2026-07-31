import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession, isAdminSession } from "@/lib/auth-helpers";

// 확장자 화이트리스트 (MIME은 브라우저별로 제각각이라 확장자로 검증)
const ALLOWED_EXT = [
  "jpg",
  "jpeg",
  "png",
  "heic",
  "webp",
  "pdf",
  "hwp",
  "hwpx",
  "doc",
  "docx",
] as const;

const EXT_MIME: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  heic: "image/heic",
  webp: "image/webp",
  pdf: "application/pdf",
  hwp: "application/x-hwp",
  hwpx: "application/hwp+zip",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

const MAX_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_COUNT = 3;

function extOf(fileName: string): string {
  const i = fileName.lastIndexOf(".");
  return i < 0 ? "" : fileName.slice(i + 1).toLowerCase();
}

export async function GET(
  _request: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const r = await requireSession();
  if (!r.ok) return r.response;
  const { session } = r;

  const { id: idStr } = await ctx.params;
  const id = Number(idStr);
  if (!Number.isInteger(id)) {
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

  // fileData는 목록이 무거워지므로 제외
  const files = await prisma.attendanceReasonFile.findMany({
    where: { dailyId: id },
    select: {
      id: true,
      fileName: true,
      mimeType: true,
      fileSize: true,
      createdAt: true,
    },
    orderBy: { id: "asc" },
  });

  return NextResponse.json(files);
}

export async function POST(
  request: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const r = await requireSession();
  if (!r.ok) return r.response;
  const { session } = r;

  const { id: idStr } = await ctx.params;
  const id = Number(idStr);
  if (!Number.isInteger(id)) {
    return NextResponse.json({ error: "id가 올바르지 않습니다." }, { status: 400 });
  }

  const daily = await prisma.attendanceDaily.findUnique({
    where: { id },
    select: { id: true, employeeId: true, autoStatus: true },
  });
  if (!daily) {
    return NextResponse.json({ error: "근태 기록을 찾을 수 없습니다." }, { status: 404 });
  }

  // 권한: 본인만 첨부 가능
  if (daily.employeeId !== session.user.employeeId) {
    return NextResponse.json(
      { error: "본인 근태에만 첨부할 수 있습니다." },
      { status: 403 }
    );
  }

  if (daily.autoStatus !== "late" && daily.autoStatus !== "early_leave") {
    return NextResponse.json(
      { error: "지각/조퇴 기록에만 첨부할 수 있습니다." },
      { status: 400 }
    );
  }

  const formData = await request.formData();
  const file = formData.get("file");
  if (!file || typeof file === "string") {
    return NextResponse.json({ error: "파일이 없습니다." }, { status: 400 });
  }

  const fileName = file.name || "attachment";
  const ext = extOf(fileName);
  if (!(ALLOWED_EXT as readonly string[]).includes(ext)) {
    return NextResponse.json(
      { error: `허용되지 않는 파일 형식입니다. (${ALLOWED_EXT.join(", ")})` },
      { status: 400 }
    );
  }

  if (file.size > MAX_SIZE) {
    return NextResponse.json(
      { error: "파일 크기는 10MB를 초과할 수 없습니다." },
      { status: 400 }
    );
  }

  const existing = await prisma.attendanceReasonFile.count({ where: { dailyId: id } });
  if (existing >= MAX_COUNT) {
    return NextResponse.json({ error: "첨부는 최대 3개까지 가능합니다." }, { status: 400 });
  }

  const mimeType = file.type || EXT_MIME[ext] || "application/octet-stream";
  const buffer = Buffer.from(await file.arrayBuffer());

  const created = await prisma.attendanceReasonFile.create({
    data: {
      dailyId: id,
      fileName,
      mimeType,
      fileData: buffer.toString("base64"),
      fileSize: buffer.length,
    },
    select: { id: true, fileName: true, fileSize: true },
  });

  return NextResponse.json(created);
}

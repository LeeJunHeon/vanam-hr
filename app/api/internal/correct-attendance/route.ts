import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireHrWriteAuth } from "@/lib/internal-write-auth";
import { resolveHrIdentity } from "@/lib/internal-identity";
import { createAttendanceRequest } from "@/lib/create-attendance-request";

export const dynamic = "force-dynamic";

// POST /api/internal/correct-attendance — 챗 근태정정 신청.
// employeeId는 신원(x-acting-user-email→resolveHrIdentity)에서만 → 본인 명의로만(위조 불가).
// date + checkIn/checkOut(HH:MM)을 YYYY-MM-DDTHH:MM로 결합 → createAttendanceRequest(정정 분기).
// HR 컨테이너 TZ=Asia/Seoul → new Date가 KST로 해석(웹 datetime-local과 동일).
export async function POST(request: Request) {
  const auth = requireHrWriteAuth(request);
  if (!auth.ok) return auth.response;

  const identity = await resolveHrIdentity(auth.actingEmail);
  if (!Number.isInteger(identity.employeeId)) {
    return NextResponse.json(
      { error: "본인 직원 정보가 매핑되어 있지 않습니다. 관리자에게 직원 등록을 요청하세요." },
      { status: 403 }
    );
  }

  let body: { correctionCategory?: unknown; date?: unknown; checkIn?: unknown; checkOut?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const categoryName = typeof body.correctionCategory === "string" ? body.correctionCategory.trim() : "";
  const date = typeof body.date === "string" ? body.date.trim() : "";
  const checkIn = typeof body.checkIn === "string" ? body.checkIn.trim() : "";
  const checkOut = typeof body.checkOut === "string" ? body.checkOut.trim() : "";

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json({ error: "정정 날짜(date)가 필요합니다 (YYYY-MM-DD)." }, { status: 400 });
  }
  if (!checkIn && !checkOut) {
    return NextResponse.json({ error: "정정 출근 시각과 퇴근 시각 중 하나 이상 입력하세요." }, { status: 400 });
  }
  const hhmm = /^\d{2}:\d{2}$/;
  if (checkIn && !hhmm.test(checkIn)) {
    return NextResponse.json({ error: "정정 출근 시각 형식이 잘못되었습니다 (HH:MM)." }, { status: 400 });
  }
  if (checkOut && !hhmm.test(checkOut)) {
    return NextResponse.json({ error: "정정 퇴근 시각 형식이 잘못되었습니다 (HH:MM)." }, { status: 400 });
  }

  // 정정 항목(correction 타입, 활성)만 허용
  let catId: number | null = null;
  if (categoryName) {
    const cat = await prisma.attendanceCategory.findFirst({
      where: { name: categoryName, isActive: true, type: "correction" },
      select: { id: true },
    });
    if (!cat) {
      return NextResponse.json({ error: `'${categoryName}' 정정 항목을 찾을 수 없습니다.` }, { status: 400 });
    }
    catId = cat.id;
  } else {
    // 항목 미지정 시: 활성 correction 항목이 하나뿐이면 자동 사용
    const corrections = await prisma.attendanceCategory.findMany({
      where: { isActive: true, type: "correction" },
      orderBy: { sortOrder: "asc" },
      select: { id: true, name: true },
    });
    if (corrections.length === 1) {
      catId = corrections[0].id;
    } else if (corrections.length === 0) {
      return NextResponse.json({ error: "정정 항목이 설정돼 있지 않습니다. 관리자에게 문의하세요." }, { status: 400 });
    } else {
      return NextResponse.json({ error: `정정 항목을 지정해주세요 (${corrections.map((c) => c.name).join(", ")}).` }, { status: 400 });
    }
  }

  const result = await createAttendanceRequest({
    employeeId: identity.employeeId as number,
    categoryId: catId,
    startDate: date,
    endDate: date,
    correctedCheckIn: checkIn ? `${date}T${checkIn}` : null,
    correctedCheckOut: checkOut ? `${date}T${checkOut}` : null,
  });

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json({ ok: true, id: result.id, status: result.status }, { status: 201 });
}

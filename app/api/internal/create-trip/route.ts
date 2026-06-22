import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireHrWriteAuth } from "@/lib/internal-write-auth";
import { resolveHrIdentity } from "@/lib/internal-identity";

export const dynamic = "force-dynamic";

// YYYY-MM-DD → UTC midnight Date. 잘못된 형식이면 null.
function parseYmd(s: unknown): Date | null {
  if (typeof s !== "string") return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(s + "T00:00:00.000Z");
  return isNaN(d.getTime()) ? null : d;
}

// POST /api/internal/create-trip — 챗 그룹 출장(이벤트) 생성.
// 주최자(createdById)는 신원(x-acting-user-email→resolveHrIdentity)에서만 결정 → 본인 명의로만(위조 불가).
// 웹 POST /api/trip-events 와 동일 규칙. 참석자 초대는 별도 작업.
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

  let body: {
    name?: unknown; location?: unknown; description?: unknown;
    startDate?: unknown; endDate?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) {
    return NextResponse.json({ error: "출장명(name)은 필수입니다." }, { status: 400 });
  }
  if (name.length > 200) {
    return NextResponse.json({ error: "출장명은 200자 이하여야 합니다." }, { status: 400 });
  }

  const location =
    typeof body.location === "string" && body.location.trim().length > 0
      ? body.location.trim()
      : null;
  if (location && location.length > 200) {
    return NextResponse.json({ error: "장소(location)는 200자 이하여야 합니다." }, { status: 400 });
  }

  const description =
    typeof body.description === "string" && body.description.trim().length > 0
      ? body.description.trim()
      : null;

  const start = parseYmd(body.startDate);
  const end = parseYmd(body.endDate);
  if (!start || !end) {
    return NextResponse.json(
      { error: "startDate, endDate 형식이 잘못되었습니다 (YYYY-MM-DD)." },
      { status: 400 }
    );
  }
  if (start.getTime() > end.getTime()) {
    return NextResponse.json(
      { error: "startDate는 endDate보다 빠르거나 같아야 합니다." },
      { status: 400 }
    );
  }

  // 생성 시점 역할 스냅샷 (admin/ceo면 creator_is_admin=true)
  const creatorIsAdmin = identity.role === "admin" || identity.role === "ceo";

  const created = await prisma.tripEvent.create({
    data: {
      name,
      location,
      description,
      startDate: start,
      endDate: end,
      createdById: identity.employeeId as number,
      creatorIsAdmin,
      status: "active",
    },
    select: { id: true, name: true, startDate: true, endDate: true },
  });

  return NextResponse.json(
    {
      ok: true,
      id: created.id,
      name: created.name,
      startDate: created.startDate.toISOString().split("T")[0],
      endDate: created.endDate.toISOString().split("T")[0],
    },
    { status: 201 }
  );
}

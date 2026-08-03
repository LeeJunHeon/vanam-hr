import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/auth-helpers";

const ALLOWED_PAGE_SIZES = [10, 20, 50];

// GET /api/my-trips — 본인이 다녀온(다녀올) 출장/외근 목록. 출장보고서 작성 대상.
// 두 소스를 합친다:
//   (a) 그룹출장 참가 (trip_participants) — 초대 수락 + 결재 완료된 건만
//   (b) 단건 출장/외근 신청 (attendance_requests) — 승인된 건만
// 그룹출장이 자동 생성한 attendance_request(external_source='trip')는 (a)와 중복되므로 제외.

// @db.Date는 UTC 자정으로 오간다.
function ymd(d: Date | null): string | null {
  return d ? d.toISOString().split("T")[0] : null;
}

// @db.Time은 1970-01-01 기준 Date로 온다 — KST 변환 없이 UTC 시각 그대로 읽는다.
function hhmm(t: Date | null): string | null {
  if (!t) return null;
  const h = String(t.getUTCHours()).padStart(2, "0");
  const m = String(t.getUTCMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}

export interface MyTripRow {
  kind: "trip" | "request";
  refId: number;
  title: string;
  location: string | null;
  startDate: string | null;
  endDate: string | null;
  myDates: { date: string | null; startTime: string | null; endTime: string | null }[];
  report: { id: number; status: string; submittedAt: string | null } | null;
}

export async function GET(request: NextRequest) {
  try {
    const sessionR = await requireSession();
    if (!sessionR.ok) return sessionR.response;
    const employeeId = sessionR.session.user.employeeId;
    if (!Number.isInteger(employeeId)) {
      return NextResponse.json(
        { error: "본인 직원 정보가 매핑되어 있지 않습니다." },
        { status: 403 }
      );
    }
    const empId = employeeId as number;

    // 페이지네이션 + 상태 필터 (missing = 보고서 없음 또는 draft)
    const sp = new URL(request.url).searchParams;
    const statusFilter = sp.get("status"); // all | missing | submitted
    const pageRaw = Number(sp.get("page"));
    const page = Number.isInteger(pageRaw) && pageRaw >= 1 ? pageRaw : 1;
    const sizeRaw = Number(sp.get("pageSize"));
    const pageSize = ALLOWED_PAGE_SIZES.includes(sizeRaw) ? sizeRaw : 20;

    const [participants, requests] = await Promise.all([
      // (a) 그룹출장 — 초대 수락 + 결재 완료(approved 또는 결재불요 not_required)
      prisma.tripParticipant.findMany({
        where: {
          employeeId: empId,
          inviteStatus: "accepted",
          approvalStatus: { in: ["approved", "not_required"] },
        },
        take: 500,
        orderBy: { tripEvent: { endDate: "desc" } },
        include: {
          tripEvent: {
            select: { name: true, location: true, startDate: true, endDate: true },
          },
          dates: {
            orderBy: { attendDate: "asc" },
            select: { attendDate: true, startTime: true, endTime: true },
          },
          report: {
            select: { id: true, status: true, submittedAt: true },
          },
        },
      }),
      // (b) 단건 신청 — 그룹출장이 만든 자동 행(external_source='trip')은 제외
      prisma.attendanceRequest.findMany({
        where: {
          employeeId: empId,
          category: { code: { in: ["BUSINESS_TRIP", "EXTERNAL_WORK"] } },
          OR: [{ externalSource: null }, { externalSource: { not: "trip" } }],
          status: { in: ["approved", "auto_approved"] },
        },
        take: 500,
        orderBy: { endDate: "desc" },
        include: {
          category: { select: { name: true } },
          tripReport: { select: { id: true, status: true, submittedAt: true } },
        },
      }),
    ]);

    const tripRows: MyTripRow[] = participants.map((p) => ({
      kind: "trip",
      refId: p.id,
      title: p.tripEvent?.name ?? "출장",
      location: p.tripEvent?.location ?? null,
      startDate: ymd(p.tripEvent?.startDate ?? null),
      endDate: ymd(p.tripEvent?.endDate ?? null),
      myDates: p.dates.map((d) => ({
        date: ymd(d.attendDate),
        startTime: hhmm(d.startTime),
        endTime: hhmm(d.endTime),
      })),
      report: p.report
        ? {
            id: p.report.id,
            status: p.report.status,
            submittedAt: p.report.submittedAt?.toISOString() ?? null,
          }
        : null,
    }));

    const requestRows: MyTripRow[] = requests.map((r) => {
      const reason = (r.reason ?? "").trim();
      const base = r.category?.name ?? "출장/외근";
      return {
        kind: "request",
        refId: r.id,
        title: reason ? `${base} · ${reason.slice(0, 40)}` : base,
        location: null,
        startDate: ymd(r.startDate),
        endDate: ymd(r.endDate),
        myDates: [],
        report: r.tripReport
          ? {
              id: r.tripReport.id,
              status: r.tripReport.status,
              submittedAt: r.tripReport.submittedAt?.toISOString() ?? null,
            }
          : null,
      };
    });

    // 두 소스를 합쳐 종료일 내림차순 (endDate 없는 건은 뒤로)
    const merged = [...tripRows, ...requestRows].sort((a, b) =>
      (b.endDate ?? "").localeCompare(a.endDate ?? "")
    );

    // 미제출 = 보고서 없음 또는 draft(작성중)
    const filtered =
      statusFilter === "missing"
        ? merged.filter((r) => r.report?.status !== "submitted")
        : statusFilter === "submitted"
        ? merged.filter((r) => r.report?.status === "submitted")
        : merged;

    const total = filtered.length;
    const start = (page - 1) * pageSize;
    const rows = filtered.slice(start, start + pageSize);

    return NextResponse.json({ rows, total, page, pageSize });
  } catch (error) {
    console.error("GET /api/my-trips error:", error);
    return NextResponse.json({ error: "출장 목록 조회 실패" }, { status: 500 });
  }
}

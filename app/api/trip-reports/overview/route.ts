import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession, isAdminSession } from "@/lib/auth-helpers";

// GET /api/trip-reports/overview — 전 직원 출장/외근 + 보고서 작성 현황 (관리자 열람 전용).
// 대상 선정 조건(where)은 app/api/my-trips/route.ts와 문자 그대로 동일해야 한다.
// 본인 화면과 관리자 화면이 서로 다른 모수를 보면 "미작성" 집계가 어긋난다.

function ymd(d: Date | null): string | null {
  return d ? d.toISOString().split("T")[0] : null;
}

// @db.Time은 1970-01-01 기준 Date로 온다 — UTC 성분이 저장된 벽시계 시각.
function hhmm(t: Date | null): string | null {
  if (!t) return null;
  const h = String(t.getUTCHours()).padStart(2, "0");
  const m = String(t.getUTCMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}

const ALLOWED_PAGE_SIZES = [10, 20, 50];

interface OverviewRow {
  kind: "trip" | "request";
  refId: number;
  employeeId: number;
  employeeName: string;
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
    if (!isAdminSession(sessionR.session)) {
      return NextResponse.json(
        { error: "관리자 권한이 필요합니다." },
        { status: 403 }
      );
    }

    const sp = new URL(request.url).searchParams;
    const statusFilter = sp.get("status"); // missing | draft | submitted
    const empParam = sp.get("employeeId");
    const employeeId = empParam ? Number(empParam) : null;
    if (empParam && !Number.isInteger(employeeId)) {
      return NextResponse.json(
        { error: "employeeId가 올바르지 않습니다." },
        { status: 400 }
      );
    }

    // 페이지네이션 — pageSize는 화이트리스트만 허용
    const pageRaw = Number(sp.get("page"));
    const page = Number.isInteger(pageRaw) && pageRaw >= 1 ? pageRaw : 1;
    const sizeRaw = Number(sp.get("pageSize"));
    const pageSize = ALLOWED_PAGE_SIZES.includes(sizeRaw) ? sizeRaw : 20;

    const [participants, requests] = await Promise.all([
      // (a) 그룹출장 — my-trips와 동일 조건 (초대 수락 + 결재 완료)
      prisma.tripParticipant.findMany({
        where: {
          ...(employeeId != null ? { employeeId } : {}),
          inviteStatus: "accepted",
          approvalStatus: { in: ["approved", "not_required"] },
        },
        take: 500,
        orderBy: { tripEvent: { endDate: "desc" } },
        include: {
          employee: { select: { id: true, name: true } },
          tripEvent: {
            select: { name: true, location: true, startDate: true, endDate: true },
          },
          dates: {
            orderBy: { attendDate: "asc" },
            select: { attendDate: true, startTime: true, endTime: true },
          },
          report: { select: { id: true, status: true, submittedAt: true } },
        },
      }),
      // (b) 단건 신청 — my-trips와 동일 조건 (그룹출장 자동 행 제외)
      prisma.attendanceRequest.findMany({
        where: {
          ...(employeeId != null ? { employeeId } : {}),
          category: { code: { in: ["BUSINESS_TRIP", "EXTERNAL_WORK"] } },
          OR: [{ externalSource: null }, { externalSource: { not: "trip" } }],
          status: { in: ["approved", "auto_approved"] },
        },
        take: 500,
        orderBy: { endDate: "desc" },
        include: {
          employee: { select: { id: true, name: true } },
          category: { select: { name: true } },
          tripReport: { select: { id: true, status: true, submittedAt: true } },
        },
      }),
    ]);

    const tripRows: OverviewRow[] = participants.map((p) => ({
      kind: "trip",
      refId: p.id,
      employeeId: p.employeeId,
      employeeName: p.employee?.name ?? "-",
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

    const requestRows: OverviewRow[] = requests.map((r) => {
      const reason = (r.reason ?? "").trim();
      const base = r.category?.name ?? "출장/외근";
      return {
        kind: "request",
        refId: r.id,
        employeeId: r.employeeId,
        employeeName: r.employee?.name ?? "-",
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

    const merged = [...tripRows, ...requestRows].sort((a, b) =>
      (b.endDate ?? "").localeCompare(a.endDate ?? "")
    );

    // 탭 배지용 — 상태칩과 무관하게 (직원 필터만 적용된) 미작성 건수
    const missingTotal = merged.filter((r) => r.report == null).length;

    let filtered = merged;
    if (statusFilter === "missing") {
      filtered = merged.filter((r) => r.report == null);
    } else if (statusFilter === "draft" || statusFilter === "submitted") {
      filtered = merged.filter((r) => r.report?.status === statusFilter);
    }

    const total = filtered.length;
    const start = (page - 1) * pageSize;
    const rows = filtered.slice(start, start + pageSize);

    return NextResponse.json({ rows, total, page, pageSize, missingTotal });
  } catch (error) {
    console.error("GET /api/trip-reports/overview error:", error);
    return NextResponse.json(
      { error: "보고서 현황 조회 실패" },
      { status: 500 }
    );
  }
}

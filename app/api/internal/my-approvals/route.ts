import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireHrPortalAuth } from "@/lib/internal-portal-auth";
import { resolveHrIdentity } from "@/lib/internal-identity";
import {
  pendingAttendanceWhere,
  pendingTripWhere,
  myTripInviteWhere,
  countPendingInbox,
  describeAttendanceApproval,
  delegateHoursOf,
  DELEGATE_HOURS_DEPARTMENT_SELECT,
} from "@/lib/approval-inbox";

export const dynamic = "force-dynamic";

const ymd = (d: Date) => d.toISOString().split("T")[0];

// GET /api/internal/my-approvals — 챗 "결재 대기". 웹 결재함 "결재 대기" 탭과 같은 범위(lib/approval-inbox).
// - approvals: 근태·휴가 결재 (대표는 전사 대기 건). canApprove·statusText 는 웹 카드와 같은 함수.
// - tripApprovals: 출장 참여 결재(수락한 참여자만)를 출장별로 묶음.
// - tripInvites: 내가 아직 응답하지 않은 출장 초대.
// - counts: 웹 대시보드 결재 대기 숫자와 같은 countPendingInbox 결과.
// mapped / approvals 이름은 포털 하위 호환을 위해 유지.
export async function GET(request: NextRequest) {
  const auth = requireHrPortalAuth(request);
  if (!auth.ok) return auth.response;
  const identity = await resolveHrIdentity(auth.actingEmail);
  if (!Number.isInteger(identity.employeeId)) {
    return NextResponse.json({ mapped: false, approvals: [] });
  }
  const approverId = identity.employeeId as number;
  const viewer = { approverId, role: identity.role };

  const [rows, tripParts, invites, counts] = await Promise.all([
    prisma.attendanceRequest.findMany({
      where: pendingAttendanceWhere(viewer),
      orderBy: [{ requestedAt: "desc" }],
      include: {
        employee: {
          select: {
            name: true,
            department: { select: { name: true, ...DELEGATE_HOURS_DEPARTMENT_SELECT } },
          },
        },
        category: { select: { name: true } },
      },
    }),
    prisma.tripParticipant.findMany({
      where: pendingTripWhere(viewer),
      orderBy: [{ createdAt: "asc" }],
      select: {
        tripEventId: true,
        employee: { select: { name: true, department: { select: { name: true } } } },
        dates: { orderBy: [{ attendDate: "asc" }], select: { attendDate: true } },
        tripEvent: { select: { id: true, name: true, startDate: true, endDate: true } },
      },
    }),
    prisma.tripParticipant.findMany({
      where: myTripInviteWhere(approverId),
      orderBy: [{ createdAt: "asc" }],
      select: {
        dates: { orderBy: [{ attendDate: "asc" }], select: { attendDate: true } },
        tripEvent: { select: { id: true, name: true, startDate: true, endDate: true } },
      },
    }),
    countPendingInbox(viewer),
  ]);

  // 결재 대기자 이름 (statusText 표시용)
  const approverIdSet = Array.from(new Set(rows.flatMap((r) => r.approverIds ?? [])));
  const nameMap = new Map<number, string>();
  if (approverIdSet.length > 0) {
    const emps = await prisma.employee.findMany({
      where: { id: { in: approverIdSet } },
      select: { id: true, name: true },
    });
    for (const e of emps) nameMap.set(e.id, e.name);
  }

  // 출장 참여 결재 — 출장(이벤트)별로 묶음 (웹 결재함 출장 카드 1장 = 이벤트 1건)
  const byEvent = new Map<number, typeof tripParts>();
  for (const p of tripParts) {
    const arr = byEvent.get(p.tripEventId) ?? [];
    arr.push(p);
    byEvent.set(p.tripEventId, arr);
  }

  return NextResponse.json({
    mapped: true,
    approvals: rows.map((r) => {
      const { canApprove, statusText } = describeAttendanceApproval({
        request: r,
        approverId,
        viewerRole: identity.role,
        viewerEmployeeId: approverId,
        autoDelegateHours: delegateHoursOf(r.employee?.department),
        nameMap,
      });
      return {
        requesterName: r.employee?.name ?? null,
        departmentName: r.employee?.department?.name ?? null,
        categoryName: r.category?.name ?? null,
        startDate: ymd(r.startDate),
        endDate: ymd(r.endDate),
        canApprove,
        statusText,
      };
    }),
    tripApprovals: [...byEvent.values()].map((ps) => {
      const ev = ps[0].tripEvent;
      return {
        tripEventId: ev.id,
        tripName: ev.name,
        startDate: ymd(ev.startDate),
        endDate: ymd(ev.endDate),
        participants: ps.map((p) => ({
          name: p.employee?.name ?? null,
          departmentName: p.employee?.department?.name ?? null,
          dates: p.dates.map((d) => ymd(d.attendDate)),
        })),
      };
    }),
    tripInvites: invites.map((p) => ({
      tripEventId: p.tripEvent.id,
      tripName: p.tripEvent.name,
      startDate: ymd(p.tripEvent.startDate),
      endDate: ymd(p.tripEvent.endDate),
      dates: p.dates.map((d) => ymd(d.attendDate)),
    })),
    counts,
  });
}

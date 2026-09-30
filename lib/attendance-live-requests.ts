import type { Prisma } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/prisma";

// 근태 반영(승인·취소·정정)에서 같이 쓰는 "살아 있는 신청" 조회·판정.
// aggregator(get_active_requests, 종일 판정)와 같은 기준이어야 한다 — 한쪽을 바꾸면 다른 쪽도.

type Db = Prisma.TransactionClient | typeof prisma;

// 살아 있는 신청 상태
export const LIVE_REQUEST_STATUSES = ["approved", "auto_approved", "auto_delegated"];

// 휴가·외근 카테고리 type (근태 정정 'correction' 제외)
export const LEAVE_WORK_CATEGORY_TYPES = ["leave", "long_leave", "work"];

export function isLeaveWorkCategoryType(type: string | null | undefined): boolean {
  return !!type && LEAVE_WORK_CATEGORY_TYPES.includes(type);
}

// 수동 보호 행 — 근태 정정 등으로 사람이 고친 행. 다른 신청의 승인·취소로 시각을 바꾸지 않는다.
export function isProtectedManualRow(
  row: { isOverridden: boolean; overrideSource: string | null } | null | undefined
): boolean {
  return !!row && row.isOverridden && (row.overrideSource ?? "") !== "calendar";
}

function kstYmd(d: Date): string {
  return new Date(d.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

// 종일 판정 — aggregator 와 동일: 시각 한쪽이라도 없거나, 두 시각의 KST 날짜가 다르면(다일 시간형) 종일.
export function isAllDayRequest(
  correctedCheckIn: Date | null,
  correctedCheckOut: Date | null
): boolean {
  if (!correctedCheckIn || !correctedCheckOut) return true;
  return kstYmd(correctedCheckIn) !== kstYmd(correctedCheckOut);
}

export interface LiveLeaveWorkRequest {
  id: number;
  categoryId: number;
  correctedCheckIn: Date | null;
  correctedCheckOut: Date | null;
}

// 그 날(workDate, UTC 자정 date)을 덮는 살아 있는 휴가·외근. 출처 무관(hr, google_calendar, trip).
// excludeId 가 있으면 그 신청은 뺀다(취소 중인 신청 등). id 오름차순.
export async function findLiveLeaveWorkRequests(
  db: Db,
  employeeId: number,
  workDate: Date,
  excludeId?: number
): Promise<LiveLeaveWorkRequest[]> {
  return db.attendanceRequest.findMany({
    where: {
      employeeId,
      status: { in: LIVE_REQUEST_STATUSES },
      startDate: { lte: workDate },
      endDate: { gte: workDate },
      category: { type: { in: LEAVE_WORK_CATEGORY_TYPES } },
      ...(excludeId !== undefined ? { id: { not: excludeId } } : {}),
    },
    select: {
      id: true,
      categoryId: true,
      correctedCheckIn: true,
      correctedCheckOut: true,
    },
    orderBy: { id: "asc" },
  });
}

// 그 날 살아 있는 "종일" 휴가·외근이 있는가.
export async function hasLiveAllDayLeaveWork(
  db: Db,
  employeeId: number,
  workDate: Date
): Promise<boolean> {
  const reqs = await findLiveLeaveWorkRequests(db, employeeId, workDate);
  return reqs.some((r) => isAllDayRequest(r.correctedCheckIn, r.correctedCheckOut));
}

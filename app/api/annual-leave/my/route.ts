import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-helpers";
import { getRemainingDays, computePendingLeaveDays } from "@/lib/annual-leave";

export async function GET(request: NextRequest) {
  const r = await requireSession();
  if (!r.ok) return r.response;
  const { session } = r;

  const employeeId = session.user.employeeId;
  if (!Number.isInteger(employeeId)) {
    // 매핑 안 된 사용자 — 연차 정보 없음
    return NextResponse.json({
      mapped: false,
      year: new Date().getFullYear(),
      granted: 0,
      used: 0,
      remaining: 0,
      pending: 0,
    });
  }

  const { searchParams } = new URL(request.url);
  const year = Number(searchParams.get("year")) || new Date().getFullYear();

  const { granted, initialUsed, systemUsed, remaining } = await getRemainingDays(
    employeeId as number,
    year
  );
  // 결재 대기 연차(그 연도 안 날짜만) — 신청 가능 = 잔여 − 결재 대기
  const pending = await computePendingLeaveDays(employeeId as number, year);

  return NextResponse.json({
    mapped: true,
    year,
    granted,
    // 사용 = 도입 전 사용 + 시스템 사용 (전체 사용량)
    used: initialUsed + systemUsed,
    remaining,
    pending,
  });
}

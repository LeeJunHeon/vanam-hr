import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireHrPortalAuth } from "@/lib/internal-portal-auth";
import { resolveHrIdentity } from "@/lib/internal-identity";
import { canViewAllEmployees } from "@/lib/auth-helpers";
import { isLeaveCategoryType, isWorkCategoryType } from "@/lib/category-kind";
import { rowEvalKeys } from "@/lib/attendance-summary";
import { loadTodayWorkDate } from "@/lib/kst-date";
import { computeRealtimeStatus, loadCurrentPresence } from "@/lib/realtime-presence";
import { loadAttendancePolicy } from "@/lib/attendance-policy";

export const dynamic = "force-dynamic";

// GET /api/internal/team-attendance?date=YYYY-MM-DD — 출근 현황(권한 스코프).
// 기본 = 오늘 근무일(work_date_cutoff_hour 기준 — 실시간 현황과 같은 날).
// 사람마다 한 칸: 휴가(type leave) / 출장·외근·재택(type work) / 결근(평가 absent) / 출근(출근 시각 있음) / 미출근.
// 지각·조퇴는 출근한 사람 중 평가 키로 따로 센다(겹침 허용). 기존 응답 필드 이름은 유지한다(포털 구버전 호환).
// CEO/인사담당=전체, 부서장=자기 부서, 그 외=권한없음. isHrOnly(인사카드 전용)는 제외.
export async function GET(request: NextRequest) {
  const auth = requireHrPortalAuth(request);
  if (!auth.ok) return auth.response;
  const identity = await resolveHrIdentity(auth.actingEmail);

  const synthetic = {
    user: {
      role: identity.role,
      departmentId: identity.departmentId,
      employeeId: identity.employeeId,
    },
  } as unknown as Parameters<typeof canViewAllEmployees>[0];

  let scope: "all" | "department";
  let deptId: number | null = null;
  if (canViewAllEmployees(synthetic)) {
    scope = "all";
  } else if (identity.role === "admin" && identity.departmentId != null) {
    scope = "department";
    deptId = identity.departmentId;
  } else {
    return NextResponse.json({ allowed: false });
  }

  // 대상 날짜 (param date=YYYY-MM-DD, 없으면 오늘 근무일)
  const KST = 9 * 60 * 60 * 1000;
  const dateParam = new URL(request.url).searchParams.get("date");
  let y: number, m: number, dd: number;
  const { date: todayWorkDate, cutoffHour } = await loadTodayWorkDate(prisma);
  if (dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
    const p = dateParam.split("-");
    y = Number(p[0]); m = Number(p[1]) - 1; dd = Number(p[2]);
  } else {
    y = todayWorkDate.getUTCFullYear(); m = todayWorkDate.getUTCMonth(); dd = todayWorkDate.getUTCDate();
  }
  const start = new Date(Date.UTC(y, m, dd));
  const end = new Date(Date.UTC(y, m, dd + 1));
  const isToday = start.getTime() === todayWorkDate.getTime();

  const empWhere: any = { isActive: true, isHrOnly: false };
  if (scope === "department") empWhere.departmentId = deptId;

  const employees = await prisma.employee.findMany({
    where: empWhere,
    select: { id: true, name: true, department: { select: { name: true } } },
    orderBy: { id: "asc" },
  });
  const empIds = employees.map((e) => e.id);

  const dailies = await prisma.attendanceDaily.findMany({
    where: { employeeId: { in: empIds }, workDate: { gte: start, lt: end } },
    select: {
      employeeId: true,
      checkIn: true,
      checkOut: true,
      autoStatus: true,
      isLate: true,
      isEarlyLeave: true,
      category: { select: { name: true, code: true, type: true } },
    },
  });
  const dailyMap = new Map<number, (typeof dailies)[number]>();
  for (const d of dailies) dailyMap.set(d.employeeId, d);

  // 오늘 근무일이면 지금 연결 상태도 본다 — 근무일 경계를 넘어 연결된 채라 아직 출근 행이 없는 사람을
  // 미출근으로 세지 않기 위해(lib/realtime-presence 공용 판정, 실시간 현황과 같음).
  const presence = isToday
    ? await loadCurrentPresence(prisma, empIds, todayWorkDate, cutoffHour)
    : new Map();
  const graceMs = isToday ? (await loadAttendancePolicy(prisma)).debounceMinutes * 60 * 1000 : 0;
  const nowMs = Date.now();
  const connectedNow = (empId: number) => {
    const pr = presence.get(empId);
    return !!pr && computeRealtimeStatus({
      latestStatus: pr.status, latestCheckedAt: pr.checkedAt, graceMs, now: nowMs,
    }) === "working";
  };

  const hm = (dt: Date | null) =>
    dt ? new Date(dt.getTime() + KST).toISOString().slice(11, 16) : null;

  let present = 0, late = 0, earlyLeave = 0, leave = 0, work = 0, absent = 0, pending = 0;
  const lateList: Array<{ name: string | null; checkIn: string | null }> = [];
  const earlyLeaveList: Array<{ name: string | null; checkOut: string | null }> = [];
  const absentList: Array<{ name: string | null; departmentName: string | null }> = [];
  const leaveList: Array<{ name: string | null; categoryName: string | null }> = [];
  const workList: Array<{ name: string | null; categoryName: string | null }> = [];

  for (const e of employees) {
    const d = dailyMap.get(e.id);
    const cat = d?.category;
    if (cat && isLeaveCategoryType(cat.type)) {
      leave++;
      leaveList.push({ name: e.name, categoryName: cat.name ?? null });
      continue;
    }
    if (cat && isWorkCategoryType(cat.type)) {
      work++;
      workList.push({ name: e.name, categoryName: cat.name ?? null });
      continue;
    }
    const keys = d ? rowEvalKeys(d) : [];
    if (keys.includes("absent")) {
      absent++;
      absentList.push({ name: e.name, departmentName: e.department?.name ?? null });
      continue;
    }
    if (d?.checkIn) {
      present++;
      if (keys.includes("late")) {
        late++;
        lateList.push({ name: e.name, checkIn: hm(d.checkIn) });
      }
      if (keys.includes("early_leave")) {
        earlyLeave++;
        earlyLeaveList.push({ name: e.name, checkOut: hm(d.checkOut) });
      }
      continue;
    }
    if (isToday && connectedNow(e.id)) {
      // 휴가·근무 구분·결근·출근 시각은 없지만 지금 연결 중 → 출근으로 센다(지각·조퇴 목록은 행 기준)
      present++;
      continue;
    }
    pending++;
  }

  return NextResponse.json({
    allowed: true,
    scope,
    date: `${y}-${String(m + 1).padStart(2, "0")}-${String(dd).padStart(2, "0")}`,
    total: employees.length,
    // present = 출근한 사람(지각·조퇴 포함), leave = 휴가만, work = 출장·외근·재택, pending = 미출근
    present, late, earlyLeave, leave, work, absent, pending,
    lateList, earlyLeaveList, absentList, leaveList, workList,
  });
}

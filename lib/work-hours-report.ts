// 근무시간 집계 화면(/work-hours) 데이터 조회 — 서버 전용. 계산·표시 규칙은 lib/work-hours.
import { prisma } from "@/lib/prisma";
import type { DailyRecordInput } from "@/lib/work-hours";

export interface WorkHoursEmployee {
  id: number;
  name: string;
  departmentName: string | null;
  isActive: boolean;
}

/**
 * 기간 안의 대상 직원과 근태 행.
 *  - 재직자 전원 + 퇴사자(isActive=false)는 그 기간에 근태 기록이 있을 때만
 *  - isHrOnly 직원은 근태 대상이 아니므로 뺀다(전체 근태 조회와 같게)
 *  - departmentFilter 가 있으면 그 부서만
 * extraEmployeeId: 상세로 지정한 직원이 목록 조건에 안 걸려도 그 직원의 근태 행은 함께 읽는다.
 */
export async function loadWorkHoursData(params: {
  start: string;
  end: string;
  departmentFilter: number | null;
  extraEmployeeId: number | null;
}): Promise<{ employees: WorkHoursEmployee[]; records: Map<number, Map<string, DailyRecordInput>> }> {
  const { start, end, departmentFilter, extraEmployeeId } = params;
  const range = { gte: new Date(start + "T00:00:00.000Z"), lte: new Date(end + "T00:00:00.000Z") };

  const employees = await prisma.employee.findMany({
    where: {
      isHrOnly: false,
      ...(departmentFilter !== null && { departmentId: departmentFilter }),
      OR: [{ isActive: true }, { attendanceDailies: { some: { workDate: range } } }],
    },
    select: { id: true, name: true, isActive: true, department: { select: { name: true } } },
    orderBy: [{ department: { sortOrder: "asc" } }, { employeeNo: "asc" }],
  });

  const ids = employees.map((e) => e.id);
  if (extraEmployeeId !== null && !ids.includes(extraEmployeeId)) ids.push(extraEmployeeId);

  const rows =
    ids.length > 0
      ? await prisma.attendanceDaily.findMany({
          where: { employeeId: { in: ids }, workDate: range },
          select: {
            employeeId: true,
            workDate: true,
            checkIn: true,
            checkOut: true,
            originalCheckIn: true,
            originalCheckOut: true,
            isOverridden: true,
            overrideSource: true,
            autoStatus: true,
            category: { select: { name: true, type: true } },
          },
        })
      : [];

  const records = new Map<number, Map<string, DailyRecordInput>>();
  for (const r of rows) {
    const workDate = r.workDate.toISOString().slice(0, 10);
    let m = records.get(r.employeeId);
    if (!m) records.set(r.employeeId, (m = new Map()));
    m.set(workDate, {
      workDate,
      checkIn: r.checkIn,
      checkOut: r.checkOut,
      originalCheckIn: r.originalCheckIn,
      originalCheckOut: r.originalCheckOut,
      isOverridden: r.isOverridden,
      overrideSource: r.overrideSource,
      autoStatus: r.autoStatus,
      categoryName: r.category?.name ?? null,
      categoryType: r.category?.type ?? null,
    });
  }

  return {
    employees: employees.map((e) => ({
      id: e.id,
      name: e.name,
      departmentName: e.department?.name ?? null,
      isActive: e.isActive,
    })),
    records,
  };
}

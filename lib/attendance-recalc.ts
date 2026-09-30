import type { Prisma } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { kstTodayMidnightUtc } from "@/lib/kst-date";

// 지난 날짜의 근태 재계산 표시.
// 근태 신청이 뒤늦게 생기거나 바뀌어(예: 출장이 늦게 확정돼 지난 날짜에 출장 근태가 생김)
// 이미 계산된 attendance_daily 가 맞지 않게 된 날을 needs_recalc=true 로 표시한다.
// 표시된 날은 aggregator 의 재계산 루프가 당일과 같은 규칙으로 다시 계산한다.
// 여기서는 근태표 값(상태·카테고리 등)을 직접 쓰지 않는다.

type Db = Prisma.TransactionClient | typeof prisma;

// 오늘(KST) 미만 날짜만 (employee_id, work_date) 에 needs_recalc=true.
// 행이 없으면 needs_recalc 만 켠 빈 행을 만든다. 반환: 표시한 날짜(YYYY-MM-DD).
export async function markAttendanceRecalc(
  db: Db,
  employeeId: number,
  dates: Date[]
): Promise<string[]> {
  const today = kstTodayMidnightUtc();
  const marked: string[] = [];
  const seen = new Set<string>();
  for (const d of dates) {
    const day = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    if (day.getTime() >= today.getTime()) continue;
    const ymd = day.toISOString().split("T")[0];
    if (seen.has(ymd)) continue;
    seen.add(ymd);
    await db.attendanceDaily.upsert({
      where: { employeeId_workDate: { employeeId, workDate: day } },
      update: { needsRecalc: true },
      create: { employeeId, workDate: day, needsRecalc: true },
    });
    marked.push(ymd);
  }
  return marked;
}

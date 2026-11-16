// 성과 제출 시작 알림(perf_open) 발송 — 서버 전용. 받을 사람 판정은 lib/performance/open-notify-plan.
//   회차 만들기(POST /api/performance/cycles)·고치기(PUT …/[id]) → 바로
//   매일 점검(POST /api/internal/sweep-trip-reports, aggregator 가 하루 1회·trip_report_remind_hour 이후 호출) → 그날 시작한 회차
// 중복 방지: notifications 의 type='perf_open' + link_ref_id=회차 id 기록(앱 알림이 켜져 있을 때 남는다).
// 이 함수는 예외를 밖으로 던지지 않는다 — 실패는 로그로 남기고 회차 생성·수정·점검은 그대로 진행된다.
import { prisma } from "@/lib/prisma";
import { createNotifications, getChannelFlags } from "@/lib/notify";
import { quarterLabel } from "@/lib/performance/rules";
import { dateToYmd, perfTodayYmd } from "@/lib/performance/server";
import {
  perfOpenMessage,
  planPerfOpenRecipients,
  type PerfOpenCycleDates,
  type PerfOpenTrigger,
} from "@/lib/performance/open-notify-plan";

export const PERF_OPEN_TYPE = "perf_open";

// 시각 → KST 날짜 "YYYY-MM-DD"
function kstYmdOf(d: Date): string {
  return new Date(d.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** 회차 하나에 perf_open 을 보낸다. 반환: 보낸 사람 수 (실패 시 0) */
export async function notifyPerfOpen(
  cycleId: number,
  trigger: PerfOpenTrigger,
  before?: PerfOpenCycleDates
): Promise<number> {
  try {
    const cycle = await prisma.perfCycle.findUnique({ where: { id: cycleId } });
    if (!cycle) return 0;
    const today = perfTodayYmd();
    const dates = {
      submitStart: dateToYmd(cycle.submitStart),
      submitEnd: dateToYmd(cycle.submitEnd),
      targetEmployeeIds: cycle.targetEmployeeIds,
    };
    if (!(dates.submitStart <= today && today <= dates.submitEnd)) return 0;

    const targets = cycle.targetEmployeeIds;
    const [flags, active, submitted, notified] = await Promise.all([
      getChannelFlags(PERF_OPEN_TYPE),
      prisma.employee.findMany({
        where: { id: { in: targets }, isActive: true },
        select: { id: true },
      }),
      prisma.perfSheet.findMany({
        where: {
          year: cycle.year,
          quarter: cycle.quarter,
          employeeId: { in: targets },
          submittedAt: { not: null },
        },
        select: { employeeId: true },
      }),
      prisma.notification.findMany({
        where: { type: PERF_OPEN_TYPE, linkRefId: BigInt(cycle.id), employeeId: { in: targets } },
        select: { employeeId: true },
        distinct: ["employeeId"],
      }),
    ]);

    const recipients = planPerfOpenRecipients({
      trigger,
      today,
      cycle: { ...dates, changedYmd: kstYmdOf(cycle.updatedAt) },
      before,
      activeIds: new Set(active.map((e) => e.id)),
      submittedIds: new Set(submitted.map((s) => s.employeeId)),
      notifiedIds: new Set(notified.map((n) => n.employeeId)),
      appChannel: flags.app,
    });
    if (recipients.length === 0) return 0;

    const { title, body } = perfOpenMessage(quarterLabel(cycle.year, cycle.quarter), dates);
    await createNotifications({
      employeeIds: recipients,
      type: PERF_OPEN_TYPE,
      title,
      body,
      linkPage: "my-performance",
      linkRefId: cycle.id,
      sourceType: "perf_cycle",
    });
    console.info(`[perf_open] 회차 #${cycle.id} (${trigger}) ${recipients.length}명에게 발송`);
    return recipients.length;
  } catch (e) {
    console.error(`[perf_open] 회차 #${cycleId} (${trigger}) 알림 발송 실패:`, e);
    return 0;
  }
}

/** 매일 점검 — 오늘 제출 기간이 열린 회차 전부. 반환: 보낸 사람 수 합계 */
export async function sweepPerfOpen(): Promise<number> {
  try {
    const today = new Date(`${perfTodayYmd()}T00:00:00.000Z`);
    const open = await prisma.perfCycle.findMany({
      where: { submitStart: { lte: today }, submitEnd: { gte: today } },
      select: { id: true },
    });
    let sent = 0;
    for (const c of open) sent += await notifyPerfOpen(c.id, "sweep");
    return sent;
  } catch (e) {
    console.error("[perf_open] 매일 점검 실패:", e);
    return 0;
  }
}

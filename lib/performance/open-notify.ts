// 성과 회차 등록 알림(perf_open) 발송 — 서버 전용. 받을 사람·문구는 lib/performance/open-notify-plan.
//   회차 만들기(POST /api/performance/cycles) → 대상자 전원
//   회차 고치기(PUT /api/performance/cycles/[id]) → 새로 추가된 대상자만
// 이 함수는 예외를 밖으로 던지지 않는다 — 실패는 로그로 남기고 회차 생성·수정은 그대로 성공한다.
import { prisma } from "@/lib/prisma";
import { createNotifications } from "@/lib/notify";
import { quarterLabel } from "@/lib/performance/rules";
import { dateToYmd, perfTodayYmd } from "@/lib/performance/server";
import {
  perfOpenMessage,
  planPerfOpenRecipients,
  type PerfOpenTrigger,
} from "@/lib/performance/open-notify-plan";

export const PERF_OPEN_TYPE = "perf_open";

/** 회차 하나에 perf_open 을 보낸다. 반환: 보낸 사람 수 (실패 시 0) */
export async function notifyPerfOpen(
  cycleId: number,
  trigger: PerfOpenTrigger,
  beforeTargetEmployeeIds?: number[]
): Promise<number> {
  try {
    const cycle = await prisma.perfCycle.findUnique({ where: { id: cycleId } });
    if (!cycle) return 0;

    const active = await prisma.employee.findMany({
      where: { id: { in: cycle.targetEmployeeIds }, isActive: true },
      select: { id: true },
    });
    const recipients = planPerfOpenRecipients({
      trigger,
      targetEmployeeIds: cycle.targetEmployeeIds,
      beforeTargetEmployeeIds,
      activeIds: new Set(active.map((e) => e.id)),
    });
    if (recipients.length === 0) return 0;

    const { title, body } = perfOpenMessage(
      quarterLabel(cycle.year, cycle.quarter),
      { submitStart: dateToYmd(cycle.submitStart), submitEnd: dateToYmd(cycle.submitEnd) },
      perfTodayYmd()
    );
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

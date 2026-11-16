// 성과 제출 시작 알림(perf_open) — 누구에게 보낼지 정하는 순수 함수. DB·서버 전용 모듈 없이 돈다.
// 실제 조회·발송은 lib/performance/open-notify.ts.
//
// 보내는 때:
//  - create : 회차를 만들 때 제출 기간이 이미 열려 있으면(시작일 ≤ 오늘 ≤ 마감일) 대상자 전원
//  - update : 수정 뒤 기간이 열려 있을 때 — 수정 전에도 열려 있었으면 새로 추가된 대상자만,
//             수정으로 열리게 됐으면(시작일을 오늘 이하로 당김 등) 대상자 전원
//  - sweep  : 매일 점검. 기간이 열린 회차의 대상자 중 아직 못 받은 사람
//             (앱 알림이 꺼져 있으면 받은 기록이 남지 않으므로, 시작일 당일이고 오늘 이전에 만들어/고쳐진
//              회차만 — 오늘 만들거나 고친 회차는 그때 이미 보냈다)
// 공통 제외: 퇴사자(isActive=false), 이미 제출한 사람(submittedAt 있음), 이미 받은 사람(앱 알림 기록)

export type PerfOpenTrigger = "create" | "update" | "sweep";

export interface PerfOpenCycleDates {
  submitStart: string; // YYYY-MM-DD
  submitEnd: string;
  targetEmployeeIds: number[];
}

export interface PerfOpenPlanInput {
  trigger: PerfOpenTrigger;
  today: string; // KST YYYY-MM-DD
  cycle: PerfOpenCycleDates & {
    /** 회차를 마지막으로 만들거나 고친 날 (KST YYYY-MM-DD) — sweep 의 앱 알림 꺼짐 분기에서만 쓴다 */
    changedYmd: string;
  };
  /** update 일 때 수정 전 값 */
  before?: PerfOpenCycleDates;
  activeIds: ReadonlySet<number>;
  submittedIds: ReadonlySet<number>;
  /** 이 회차 perf_open 앱 알림을 이미 받은 직원 */
  notifiedIds: ReadonlySet<number>;
  /** 앱 알림 채널이 켜져 있는지 (꺼져 있으면 받은 기록이 남지 않는다) */
  appChannel: boolean;
}

export function isSubmitPeriodOpen(c: { submitStart: string; submitEnd: string }, today: string): boolean {
  return c.submitStart <= today && today <= c.submitEnd;
}

export function planPerfOpenRecipients(input: PerfOpenPlanInput): number[] {
  const { trigger, today, cycle, before } = input;
  if (!isSubmitPeriodOpen(cycle, today)) return [];

  let candidates: number[];
  if (trigger === "create") {
    candidates = cycle.targetEmployeeIds;
  } else if (trigger === "update") {
    if (before && isSubmitPeriodOpen(before, today)) {
      const prev = new Set(before.targetEmployeeIds);
      candidates = cycle.targetEmployeeIds.filter((id) => !prev.has(id));
    } else {
      candidates = cycle.targetEmployeeIds;
    }
  } else {
    candidates =
      input.appChannel || (cycle.submitStart === today && cycle.changedYmd < today)
        ? cycle.targetEmployeeIds
        : [];
  }

  return Array.from(new Set(candidates)).filter(
    (id) => input.activeIds.has(id) && !input.submittedIds.has(id) && !input.notifiedIds.has(id)
  );
}

export function perfOpenMessage(
  quarterLabel: string,
  c: { submitStart: string; submitEnd: string }
): { title: string; body: string } {
  return {
    title: `${quarterLabel} 성과 제출이 시작되었습니다`,
    body: `제출 기간: ${c.submitStart} ~ ${c.submitEnd}. 내 성과 메뉴에서 작성·제출해 주세요.`,
  };
}

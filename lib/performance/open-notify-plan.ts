// 성과 회차 등록 알림(perf_open) — 누구에게 무엇을 보낼지 정하는 순수 함수. DB·서버 전용 모듈 없이 돈다.
// 실제 조회·발송은 lib/performance/open-notify.ts.
//
// 보내는 때 (각 1회, 매일 점검 없음):
//  - create : 회차를 만들 때 대상자 전원 (제출 기간이 열렸는지와 무관)
//  - update : 회차를 고칠 때 새로 추가된 대상자만 (날짜만 바뀌면 보내지 않는다)
// 공통 제외: 퇴사자(isActive=false)

export type PerfOpenTrigger = "create" | "update";

export interface PerfOpenPlanInput {
  trigger: PerfOpenTrigger;
  /** 저장 후 대상자 */
  targetEmployeeIds: readonly number[];
  /** update 일 때 수정 전 대상자 */
  beforeTargetEmployeeIds?: readonly number[];
  /** 재직 중인 직원 */
  activeIds: ReadonlySet<number>;
}

export function planPerfOpenRecipients(input: PerfOpenPlanInput): number[] {
  const prev = new Set(input.trigger === "update" ? (input.beforeTargetEmployeeIds ?? []) : []);
  return Array.from(new Set(input.targetEmployeeIds)).filter(
    (id) => !prev.has(id) && input.activeIds.has(id)
  );
}

export function perfOpenMessage(
  quarterLabel: string,
  c: { submitStart: string; submitEnd: string },
  today: string
): { title: string; body: string } {
  const opened = c.submitStart <= today;
  return {
    title: `${quarterLabel} 성과 제출 회차가 등록되었습니다`,
    body:
      `제출 기간: ${c.submitStart} ~ ${c.submitEnd}.` +
      (opened
        ? " 지금 내 성과 메뉴에서 작성·제출해 주세요."
        : " 기간이 시작되면 내 성과 메뉴에서 제출할 수 있습니다."),
  };
}

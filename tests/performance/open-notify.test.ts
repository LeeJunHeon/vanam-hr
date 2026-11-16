// npm run test:perf-open — 성과 제출 시작 알림(perf_open) 받을 사람 판정 단위 테스트.
// DB·서버 전용 모듈 없이 돈다 (lib/performance/open-notify-plan).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isSubmitPeriodOpen,
  perfOpenMessage,
  planPerfOpenRecipients,
  type PerfOpenPlanInput,
} from "@/lib/performance/open-notify-plan";

const base = (p: Partial<PerfOpenPlanInput> = {}): PerfOpenPlanInput => ({
  trigger: "create",
  today: "2026-12-20",
  cycle: {
    submitStart: "2026-12-20",
    submitEnd: "2026-12-31",
    targetEmployeeIds: [1, 2, 3],
    changedYmd: "2026-12-20",
  },
  activeIds: new Set([1, 2, 3, 4]),
  submittedIds: new Set(),
  notifiedIds: new Set(),
  appChannel: true,
  ...p,
});

test("즉시 발송: 시작일 ≤ 오늘이면 회차 생성 때 대상자 전원", () => {
  assert.deepEqual(planPerfOpenRecipients(base()), [1, 2, 3]);
  const started = base({ cycle: { ...base().cycle, submitStart: "2026-12-15" } });
  assert.deepEqual(planPerfOpenRecipients(started), [1, 2, 3]);
});

test("미래 시작일: 생성 때는 안 보내고, 시작일 당일 점검에서 보낸다", () => {
  const future = { ...base().cycle, submitStart: "2026-12-22", changedYmd: "2026-12-18" };
  assert.deepEqual(planPerfOpenRecipients(base({ today: "2026-12-18", cycle: future })), []);
  assert.deepEqual(
    planPerfOpenRecipients(base({ trigger: "sweep", today: "2026-12-21", cycle: future })),
    []
  );
  assert.deepEqual(
    planPerfOpenRecipients(base({ trigger: "sweep", today: "2026-12-22", cycle: future })),
    [1, 2, 3]
  );
});

test("마감 지난 회차는 보내지 않는다", () => {
  assert.equal(isSubmitPeriodOpen({ submitStart: "2026-12-20", submitEnd: "2026-12-31" }, "2027-01-01"), false);
  assert.deepEqual(planPerfOpenRecipients(base({ trigger: "sweep", today: "2027-01-01" })), []);
});

test("중복 방지: 이미 받은 사람(앱 알림 기록)은 빼고, 점검은 못 받은 사람만", () => {
  const r = planPerfOpenRecipients(base({ trigger: "sweep", notifiedIds: new Set([1, 2]) }));
  assert.deepEqual(r, [3]);
  assert.deepEqual(
    planPerfOpenRecipients(base({ trigger: "sweep", notifiedIds: new Set([1, 2, 3]) })),
    []
  );
});

test("앱 알림 꺼짐(기록 없음): 점검은 시작일 당일 + 오늘 이전에 만든 회차만", () => {
  const cycle = { ...base().cycle, changedYmd: "2026-12-10" };
  assert.deepEqual(
    planPerfOpenRecipients(base({ trigger: "sweep", appChannel: false, cycle })),
    [1, 2, 3]
  );
  // 오늘 만든 회차는 생성 때 이미 보냈다
  assert.deepEqual(planPerfOpenRecipients(base({ trigger: "sweep", appChannel: false })), []);
  // 시작일 다음 날은 다시 보내지 않는다
  assert.deepEqual(
    planPerfOpenRecipients(base({ trigger: "sweep", appChannel: false, cycle, today: "2026-12-21" })),
    []
  );
});

test("대상자 추가: 이미 열린 회차면 추가된 사람에게만", () => {
  const r = planPerfOpenRecipients(
    base({
      trigger: "update",
      cycle: { ...base().cycle, targetEmployeeIds: [1, 2, 3, 4] },
      before: { submitStart: "2026-12-20", submitEnd: "2026-12-31", targetEmployeeIds: [1, 2, 3] },
    })
  );
  assert.deepEqual(r, [4]);
});

test("기간 변경으로 열림: 시작일을 오늘 이하로 당기면 아직 못 받은 대상자 전원", () => {
  const r = planPerfOpenRecipients(
    base({
      trigger: "update",
      before: { submitStart: "2026-12-25", submitEnd: "2026-12-31", targetEmployeeIds: [1, 2, 3] },
      notifiedIds: new Set([2]),
    })
  );
  assert.deepEqual(r, [1, 3]);
});

test("기간이 아직 안 열린 회차 수정은 보내지 않는다", () => {
  const r = planPerfOpenRecipients(
    base({
      trigger: "update",
      today: "2026-12-18",
      before: { submitStart: "2026-12-20", submitEnd: "2026-12-31", targetEmployeeIds: [1] },
    })
  );
  assert.deepEqual(r, []);
});

test("퇴사자·제출 완료자 제외", () => {
  const r = planPerfOpenRecipients(
    base({ activeIds: new Set([1, 2]), submittedIds: new Set([2]) })
  );
  assert.deepEqual(r, [1]);
});

test("문구", () => {
  assert.deepEqual(
    perfOpenMessage("2026년 4분기", { submitStart: "2026-12-20", submitEnd: "2026-12-31" }),
    {
      title: "2026년 4분기 성과 제출이 시작되었습니다",
      body: "제출 기간: 2026-12-20 ~ 2026-12-31. 내 성과 메뉴에서 작성·제출해 주세요.",
    }
  );
});

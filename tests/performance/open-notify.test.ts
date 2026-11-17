// npm run test:perf-open — 성과 회차 등록 알림(perf_open) 받을 사람·문구 단위 테스트.
// DB·서버 전용 모듈 없이 돈다 (lib/performance/open-notify-plan).
import { test } from "node:test";
import assert from "node:assert/strict";
import { perfOpenMessage, planPerfOpenRecipients } from "@/lib/performance/open-notify-plan";

const active = new Set([1, 2, 3, 5]);

test("회차 생성: 대상자 전원, 퇴사자 제외", () => {
  assert.deepEqual(
    planPerfOpenRecipients({ trigger: "create", targetEmployeeIds: [1, 2, 3, 4], activeIds: active }),
    [1, 2, 3]
  );
});

test("회차 수정: 새로 추가된 대상자만 (퇴사자 제외)", () => {
  assert.deepEqual(
    planPerfOpenRecipients({
      trigger: "update",
      targetEmployeeIds: [1, 2, 3, 4, 5],
      beforeTargetEmployeeIds: [1, 2],
      activeIds: active,
    }),
    [3, 5]
  );
});

test("회차 수정: 날짜만 바뀌고 대상자가 같으면 보내지 않음", () => {
  assert.deepEqual(
    planPerfOpenRecipients({
      trigger: "update",
      targetEmployeeIds: [1, 2, 3],
      beforeTargetEmployeeIds: [1, 2, 3],
      activeIds: active,
    }),
    []
  );
  // 대상자를 뺀 것만으로도 보내지 않음
  assert.deepEqual(
    planPerfOpenRecipients({
      trigger: "update",
      targetEmployeeIds: [1],
      beforeTargetEmployeeIds: [1, 2],
      activeIds: active,
    }),
    []
  );
});

test("문구 — 기간이 열렸는지에 따라 본문 끝이 다르다", () => {
  const c = { submitStart: "2026-12-20", submitEnd: "2026-12-31" };
  assert.deepEqual(perfOpenMessage("2026년 4분기", c, "2026-12-20"), {
    title: "2026년 4분기 성과 제출 회차가 등록되었습니다",
    body: "제출 기간: 2026-12-20 ~ 2026-12-31. 지금 내 성과 메뉴에서 작성·제출해 주세요.",
  });
  assert.equal(
    perfOpenMessage("2026년 4분기", c, "2026-12-01").body,
    "제출 기간: 2026-12-20 ~ 2026-12-31. 기간이 시작되면 내 성과 메뉴에서 제출할 수 있습니다."
  );
});

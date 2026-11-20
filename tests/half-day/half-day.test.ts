// npm run test:half-day — 반차 기본 시각(lib/half-day)·시각 수정 판정·캘린더 PATCH 본문 단위 테스트. DB 없이 돈다.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HALF_DAY_FALLBACK,
  HALF_DAY_TIME_REQUIRED_MSG,
  TIME_PAIR_REQUIRED_MSG,
  requestTimeInputError,
  effectiveSplitMinutes,
  halfDayDefaultsFor,
  halfDayHint,
  halfDayTimes,
  representativeShift,
  validatePatternSplit,
  type HalfDayInfo,
} from "@/lib/half-day";
import { buildEventTimePatchBody } from "@/lib/calendar-event";
import { CODE_DEFAULT_POLICIES } from "@/lib/policy-defaults";

test("09:00~18:00, 240분 → 09:00~13:00 / 13:00~18:00 (지금 관행)", () => {
  const t = halfDayTimes("09:00", "18:00", 240);
  assert.deepEqual(t, {
    HALF_AM: { in: "09:00", out: "13:00" },
    HALF_PM: { in: "13:00", out: "18:00" },
    split: "13:00",
  });
});

test("07:00~17:00, 300분 → 07:00~12:00 / 12:00~17:00", () => {
  const t = halfDayTimes("07:00", "17:00", 300);
  assert.deepEqual(t?.HALF_AM, { in: "07:00", out: "12:00" });
  assert.deepEqual(t?.HALF_PM, { in: "12:00", out: "17:00" });
});

test("경계가 시프트 밖이면 시프트 범위 안으로 자른다", () => {
  const long = halfDayTimes("09:00", "13:00", 600);
  assert.deepEqual(long?.HALF_AM, { in: "09:00", out: "13:00" });
  assert.deepEqual(long?.HALF_PM, { in: "13:00", out: "13:00" });
  const neg = halfDayTimes("09:00", "18:00", -30);
  assert.deepEqual(neg?.HALF_AM, { in: "09:00", out: "09:00" });
  assert.deepEqual(neg?.HALF_PM, { in: "09:00", out: "18:00" });
});

test("자정 넘는 시프트·시각 없음 → 자동 채움 없음", () => {
  assert.equal(halfDayTimes("22:00", "07:00", 240), null);
  assert.equal(halfDayTimes(null, "18:00", 240), null);
  assert.deepEqual(
    halfDayDefaultsFor({ assigned: true, isWorkDay: true, start: "22:00", end: "07:00" }, 240),
    { kind: "none", reason: "overnight" }
  );
});

test("휴무일·공휴일 → 자동 채움 없음, 안내 '이 날은 근무일이 아닙니다'", () => {
  const d = halfDayDefaultsFor({ assigned: true, isWorkDay: false, start: null, end: null }, 240);
  assert.deepEqual(d, { kind: "none", reason: "off_day" });
  const info: HalfDayInfo = {
    date: "2026-11-21", employeeId: 1, assigned: true, isWorkDay: false, isHoliday: false,
    shiftStart: null, shiftEnd: null, splitMinutes: 240, splitSource: "default", defaults: d,
  };
  assert.equal(halfDayHint(info), "이 날은 근무일이 아닙니다");
});

test("시프트 미배정 → 예전 고정값, 근무 시프트 → 안내 문구", () => {
  const fb = halfDayDefaultsFor({ assigned: false, isWorkDay: true, start: null, end: null }, 300);
  assert.equal(fb.kind, "fallback");
  if (fb.kind === "fallback") assert.deepEqual(fb.times, HALF_DAY_FALLBACK);

  const d = halfDayDefaultsFor({ assigned: true, isWorkDay: true, start: "07:00", end: "17:00" }, 300);
  assert.equal(d.kind, "shift");
  const info: HalfDayInfo = {
    date: "2026-11-20", employeeId: 1, assigned: true, isWorkDay: true, isHoliday: false,
    shiftStart: "07:00", shiftEnd: "17:00", splitMinutes: 300, splitSource: "pattern", defaults: d,
  };
  assert.equal(halfDayHint(info), "내 시프트 07:00~17:00 · 반차 경계 12:00 (직접 수정 가능)");
});

test("경계 분 우선순위 — 패턴 → 정책 → 240", () => {
  assert.equal(effectiveSplitMinutes(300, 270), 300);
  assert.equal(effectiveSplitMinutes(null, 270), 270);
  assert.equal(effectiveSplitMinutes(null, null), 240);
  assert.equal(effectiveSplitMinutes(0, Number.NaN), 240);
});

test("시프트 패턴 반차 경계 검증 — 0 초과, 30분 단위, 시프트 길이 미만", () => {
  const sched = [
    { type: "day", start: "07:00", end: "17:00" },
    { type: "off", start: null, end: null },
    { type: "day", start: "09:00", end: "15:00" },
  ];
  assert.equal(validatePatternSplit(null, sched), null);
  assert.equal(validatePatternSplit(300, sched), null);
  assert.match(validatePatternSplit(0, sched) ?? "", /0보다/);
  assert.match(validatePatternSplit(250, sched) ?? "", /30분 단위/);
  assert.match(validatePatternSplit(360, sched) ?? "", /짧아야/); // 가장 짧은 근무 6시간
  assert.deepEqual(representativeShift([...sched, { type: "day", start: "07:00", end: "17:00" }]), {
    start: "07:00",
    end: "17:00",
  });
});

test("정책 기본값 half_day_split_minutes 검증", () => {
  const p = CODE_DEFAULT_POLICIES.find((x) => x.key === "half_day_split_minutes")!;
  assert.equal(p.defaultValue, "240");
  assert.equal(p.validate("270"), null);
  assert.ok(p.validate("250"));
  assert.ok(p.validate("0"));
  assert.ok(p.validate("abc"));
  assert.equal(p.display("240"), "240분 (4시간)");
});

test("캘린더 PATCH 본문 — start/end 만, dateTime + Asia/Seoul", () => {
  const body = buildEventTimePatchBody(
    "cal@group",
    new Date("2026-11-20T12:00:00+09:00"),
    new Date("2026-11-20T20:00:00+09:00")
  );
  assert.deepEqual(body, {
    calendar_id: "cal@group",
    start: { dateTime: "2026-11-20T03:00:00.000Z", timeZone: "Asia/Seoul" },
    end: { dateTime: "2026-11-20T11:00:00.000Z", timeZone: "Asia/Seoul" },
  });
});

test("반차는 시작·종료 시각 필수 — 비면 화면 검증 문구", () => {
  for (const code of ["HALF_AM", "HALF_PM"]) {
    assert.equal(requestTimeInputError(code, "", ""), HALF_DAY_TIME_REQUIRED_MSG);
    assert.equal(requestTimeInputError(code, "13:00", ""), HALF_DAY_TIME_REQUIRED_MSG);
    assert.equal(requestTimeInputError(code, null, "18:00"), HALF_DAY_TIME_REQUIRED_MSG);
    assert.equal(requestTimeInputError(code, "  ", "18:00"), HALF_DAY_TIME_REQUIRED_MSG);
    assert.equal(requestTimeInputError(code, "13:00", "18:00"), null);
  }
});

test("반차 아닌 시간형 카테고리 — 둘 다 비우면 종일 허용, 한쪽만은 차단", () => {
  for (const code of ["SICK", "REMOTE_WORK", "EXTERNAL_WORK", "FAMILY_EVENT"]) {
    assert.equal(requestTimeInputError(code, "", ""), null);
    assert.equal(requestTimeInputError(code, null, null), null);
    assert.equal(requestTimeInputError(code, "09:00", "12:00"), null);
    assert.equal(requestTimeInputError(code, "09:00", ""), TIME_PAIR_REQUIRED_MSG);
    assert.equal(requestTimeInputError(code, "", "12:00"), TIME_PAIR_REQUIRED_MSG);
  }
});

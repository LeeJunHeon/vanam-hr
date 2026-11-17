// npm run test:work-hours — 전체 근무시간 조회 계산(lib/work-hours) 단위 테스트. DB 없이 돈다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PROGRESS_WORKING } from "@/lib/attendanceLabels";
import {
  computeDayWorkMinutes,
  dayCellText,
  dayMinutesText,
  monthWeeks,
  parseYm,
  parseYmd,
  periodMinutesText,
  periodRemarkText,
  summarizeDay,
  sumDays,
  weekRange,
  weekdayKo,
  type WorkHoursDayRow,
} from "@/lib/work-hours";

const kst = (ymd: string, hm: string) => new Date(`${ymd}T${hm}:00+09:00`).toISOString();

const row = (p: Partial<WorkHoursDayRow>): WorkHoursDayRow => ({
  employeeId: 1,
  workDate: "2026-11-16",
  checkIn: null,
  checkOut: null,
  originalCheckIn: null,
  originalCheckOut: null,
  autoStatus: null,
  categoryName: null,
  categoryType: null,
  ...p,
});

test("하루 근무 = 퇴근 − 출근(분 절삭), 휴게 공제 없음", () => {
  assert.deepEqual(computeDayWorkMinutes(kst("2026-11-16", "09:00"), kst("2026-11-16", "18:00")), {
    status: "ok",
    workMinutes: 540,
  });
  // 초 단위는 분 절삭 후 차
  assert.deepEqual(
    computeDayWorkMinutes("2026-11-16T00:00:59.000Z", "2026-11-16T00:10:01.000Z"),
    { status: "ok", workMinutes: 10 }
  );
  // 자정 넘김
  assert.deepEqual(computeDayWorkMinutes(kst("2026-11-16", "22:00"), kst("2026-11-17", "02:30")), {
    status: "ok",
    workMinutes: 270,
  });
});

// 오늘 근무일 = 2026-11-17 로 고정
const TODAY = "2026-11-17";
const day = (ymd: string, p: Partial<WorkHoursDayRow> | null) =>
  summarizeDay(ymd, p ? row({ workDate: ymd, ...p }) : null, TODAY);

test("지난 퇴근 없음·기록 오류는 합계 제외, 비고에 날짜", () => {
  assert.deepEqual(computeDayWorkMinutes(kst("2026-11-16", "09:00"), null), { status: "no_checkout" });
  assert.deepEqual(computeDayWorkMinutes(null, kst("2026-11-16", "18:00")), { status: "invalid" });
  assert.deepEqual(computeDayWorkMinutes(kst("2026-11-16", "18:00"), kst("2026-11-16", "09:00")), {
    status: "invalid",
  });

  const days = [
    day("2026-11-09", { checkIn: kst("2026-11-09", "09:00"), checkOut: kst("2026-11-09", "17:30") }),
    day("2026-11-10", { checkIn: kst("2026-11-10", "09:00") }),
    day("2026-11-11", { checkOut: kst("2026-11-11", "18:00") }),
    day("2026-11-12", null),
  ];
  const total = sumDays(days);
  assert.equal(total.minutes, 510);
  assert.deepEqual(total.noCheckoutDates, ["2026-11-10"]);
  assert.deepEqual(total.invalidDates, ["2026-11-11"]);
  assert.equal(periodMinutesText(total), "8시간 30분");
  assert.equal(periodRemarkText(total), "퇴근 없음 11/10 제외, 기록 오류 11/11 제외");

  const two = sumDays([
    day("2026-11-12", { checkIn: kst("2026-11-12", "09:00") }),
    day("2026-11-14", { checkIn: kst("2026-11-14", "09:00") }),
  ]);
  assert.equal(periodRemarkText(two), "퇴근 없음 2일(11/12, 11/14) 제외");
  assert.equal(periodRemarkText(sumDays([days[0]])), "");
});

test("오늘 근무 중 — 합계·제외 표시 없음, 칸은 근무중", () => {
  const working = day(TODAY, { checkIn: kst(TODAY, "09:00") });
  assert.equal(working.state, "working");
  assert.equal(dayCellText(working), PROGRESS_WORKING.label);
  assert.equal(dayMinutesText(working), PROGRESS_WORKING.label);
  assert.deepEqual(working.notes, []);

  const week = sumDays([
    day("2026-11-16", { checkIn: kst("2026-11-16", "09:00"), checkOut: kst("2026-11-16", "18:00") }),
    working,
  ]);
  assert.equal(periodMinutesText(week), "9시간");
  assert.equal(periodRemarkText(week), "");

  // 오늘 퇴근까지 했으면 그대로 더한다
  const done = day(TODAY, { checkIn: kst(TODAY, "09:00"), checkOut: kst(TODAY, "12:00") });
  assert.equal(done.countedMinutes, 180);
});

test("미래 — 칸은 -, 합계 대상 아님, 주 전체가 미래면 주 칸도 -", () => {
  const f = day("2026-11-18", null);
  assert.equal(f.state, "future");
  assert.equal(dayCellText(f), "-");
  assert.equal(dayMinutesText(f), "-");
  assert.equal(dayCellText(day("2026-11-20", { categoryName: "연차", categoryType: "leave" })), "-");

  const futureWeek = sumDays(["2026-11-23", "2026-11-24"].map((d) => day(d, null)));
  assert.equal(periodMinutesText(futureWeek), "-");

  const mixed = sumDays([day("2026-11-16", null), day("2026-11-18", null)]);
  assert.equal(periodMinutesText(mixed), "0분");
});

test("칸 글자 — formatWorkMinutes 형식 + 사유", () => {
  const ok = day("2026-11-16", { checkIn: kst("2026-11-16", "09:00"), checkOut: kst("2026-11-16", "17:30") });
  assert.equal(dayCellText(ok), "8시간 30분");
  assert.equal(dayMinutesText(ok), "8시간 30분");

  const trip = day("2026-11-16", { categoryName: "출장 및 외근", categoryType: "work" });
  assert.equal(dayCellText(trip), "0분 출장 및 외근");
  assert.deepEqual(trip.notes, ["출장 및 외근"]);

  const noOut = day("2026-11-16", { checkIn: kst("2026-11-16", "09:00") });
  assert.equal(dayCellText(noOut), "퇴근 없음");
  assert.equal(dayMinutesText(noOut), "-");

  // 근태정정 카테고리는 사유 글자로 넣지 않는다 (출퇴근 칸 정정 표시로 보임)
  const fixed = day("2026-11-16", {
    checkIn: kst("2026-11-16", "08:00"),
    checkOut: kst("2026-11-16", "17:00"),
    originalCheckIn: kst("2026-11-16", "09:12"),
    categoryName: "근태정정",
    categoryType: "correction",
  });
  assert.equal(dayCellText(fixed), "9시간");

  assert.equal(dayCellText(day("2026-11-16", { autoStatus: "absent" })), "0분 결근");
  assert.equal(dayCellText(day("2026-11-16", null)), "-");
});

test("월별 주 나누기 — 월~일, 그 달 날짜만", () => {
  const nov26 = monthWeeks("2026-11");
  assert.equal(nov26.length, 6);
  assert.deepEqual(nov26[0], { index: 1, start: "2026-11-01", end: "2026-11-01" });
  assert.deepEqual(nov26[1], { index: 2, start: "2026-11-02", end: "2026-11-08" });
  assert.deepEqual(nov26[5], { index: 6, start: "2026-11-30", end: "2026-11-30" });

  const nov25 = monthWeeks("2025-11");
  assert.deepEqual(nov25[0], { index: 1, start: "2025-11-01", end: "2025-11-02" });
  assert.deepEqual(nov25[nov25.length - 1].end, "2025-11-30");
});

test("주별 범위 — 그 날짜가 속한 월~일", () => {
  assert.deepEqual(weekRange("2026-11-16"), { start: "2026-11-16", end: "2026-11-22" });
  assert.deepEqual(weekRange("2026-11-22"), { start: "2026-11-16", end: "2026-11-22" });
  assert.deepEqual(weekRange("2026-11-01"), { start: "2026-10-26", end: "2026-11-01" });
  assert.equal(weekdayKo("2026-11-16"), "월");
  assert.equal(weekdayKo("2026-11-22"), "일");
});

test("주소 값 검증", () => {
  assert.equal(parseYm("2026-11"), "2026-11");
  assert.equal(parseYm("2026-13"), null);
  assert.equal(parseYmd("2026-02-30"), null);
  assert.equal(parseYmd("2026-11-16"), "2026-11-16");
});

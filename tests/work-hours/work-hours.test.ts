// npm run test:work-hours — 전체 근무시간 조회 계산(lib/work-hours) 단위 테스트. DB 없이 돈다.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeDayWorkMinutes,
  dayCellText,
  dayMinutesText,
  monthWeeks,
  parseYm,
  parseYmd,
  periodTotalText,
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

test("퇴근 없음·기록 오류는 합계 제외", () => {
  assert.deepEqual(computeDayWorkMinutes(kst("2026-11-16", "09:00"), null), { status: "no_checkout" });
  assert.deepEqual(computeDayWorkMinutes(null, kst("2026-11-16", "18:00")), { status: "invalid" });
  assert.deepEqual(computeDayWorkMinutes(kst("2026-11-16", "18:00"), kst("2026-11-16", "09:00")), {
    status: "invalid",
  });

  const days = [
    summarizeDay(row({ checkIn: kst("2026-11-16", "09:00"), checkOut: kst("2026-11-16", "17:30") })),
    summarizeDay(row({ checkIn: kst("2026-11-17", "09:00") })),
    summarizeDay(row({ checkOut: kst("2026-11-18", "18:00") })),
    summarizeDay(null),
  ];
  const total = sumDays(days);
  assert.deepEqual(total, { minutes: 510, noCheckoutDays: 1, invalidDays: 1 });
  assert.equal(periodTotalText(total), "8시간 30분 (퇴근 없음 1일 제외, 기록 오류 1일 제외)");
  assert.equal(periodTotalText({ minutes: 176 * 60 + 30, noCheckoutDays: 0, invalidDays: 0 }), "176시간 30분");
});

test("칸 글자 — formatWorkMinutes 형식 + 사유", () => {
  const ok = summarizeDay(row({ checkIn: kst("2026-11-16", "09:00"), checkOut: kst("2026-11-16", "17:30") }));
  assert.equal(dayCellText(ok), "8시간 30분");
  assert.equal(dayMinutesText(ok), "8시간 30분");

  const trip = summarizeDay(row({ categoryName: "출장 및 외근", categoryType: "work" }));
  assert.equal(dayCellText(trip), "0분 출장 및 외근");
  assert.deepEqual(trip.notes, ["출장 및 외근"]);

  const noOut = summarizeDay(row({ checkIn: kst("2026-11-16", "09:00") }));
  assert.equal(dayCellText(noOut), "퇴근 없음");
  assert.equal(dayMinutesText(noOut), "-");

  // 근태정정 카테고리는 사유 글자로 넣지 않는다 (출퇴근 칸 정정 표시로 보임)
  const fixed = summarizeDay(
    row({
      checkIn: kst("2026-11-16", "08:00"),
      checkOut: kst("2026-11-16", "17:00"),
      originalCheckIn: kst("2026-11-16", "09:12"),
      categoryName: "근태정정",
      categoryType: "correction",
    })
  );
  assert.equal(dayCellText(fixed), "9시간");

  assert.equal(dayCellText(summarizeDay(row({ autoStatus: "absent" }))), "0분 결근");
  assert.equal(dayCellText(summarizeDay(null)), "-");
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

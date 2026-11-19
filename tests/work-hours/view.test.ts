// npm run test:work-hours — 전체 근무시간 조회 화면 공용 계산(lib/work-hours 열·상세 줄·주소값·이전/다음). DB 없이 돈다.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildColumns,
  buildDetailLines,
  columnCell,
  daysInRange,
  monthRange,
  monthWeeks,
  neighborIds,
  parseDayParam,
  parseWeekParam,
  periodMinutesText,
  periodRemarkText,
  periodTotalOf,
  summarizeDay,
  weekLabel,
  type WorkHoursDayRow,
} from "@/lib/work-hours";

const kst = (ymd: string, hm: string) => new Date(`${ymd}T${hm}:00+09:00`).toISOString();

// 2026-10 한 달 — 평일 9~18시, 10/14 퇴근 없음, 10/21 출근 없이 퇴근(기록 오류), 주말 일부 출근
function octoberRows(): Map<string, WorkHoursDayRow> {
  const m = new Map<string, WorkHoursDayRow>();
  const { start, end } = monthRange("2026-10");
  for (const d of daysInRange(start, end)) {
    const dow = new Date(d + "T00:00:00Z").getUTCDay();
    if (dow === 0 || (dow === 6 && d !== "2026-10-10")) continue;
    m.set(d, {
      employeeId: 2,
      workDate: d,
      checkIn: d === "2026-10-21" ? null : kst(d, "09:00"),
      checkOut: d === "2026-10-14" ? null : kst(d, d === "2026-10-10" ? "12:30" : "18:00"),
      originalCheckIn: null,
      originalCheckOut: null,
      autoStatus: null,
      categoryName: null,
      categoryType: null,
    });
  }
  return m;
}

test("월 전체 상세의 주 소계 = 표의 그 주 칸 값 (같은 함수)", () => {
  const rows = octoberRows();
  for (const today of ["2026-11-19", "2026-10-15"]) {
    const summarize = (ymd: string) => summarizeDay(ymd, rows.get(ymd), today);
    const columns = buildColumns("month", "2026-10", "2026-10-01");
    const { start, end } = monthRange("2026-10");
    const lines = buildDetailLines(daysInRange(start, end), summarize, monthWeeks("2026-10"));
    const subtotals = lines.filter((l) => l.kind === "subtotal");
    assert.equal(subtotals.length, columns.length);
    columns.forEach((col, i) => {
      const s = subtotals[i];
      assert.equal(s.kind, "subtotal");
      if (s.kind !== "subtotal") return;
      assert.equal(s.week.index, col.weekIndex);
      assert.equal(periodMinutesText(s.total), columnCell("month", col, summarize).text);
      assert.equal(periodRemarkText(s.total), periodRemarkText(periodTotalOf(col.days, summarize)));
    });
    // 소계 줄은 각 주 마지막 날 바로 다음
    lines.forEach((l, i) => {
      if (l.kind === "subtotal") {
        const prev = lines[i - 1];
        assert.equal(prev.kind === "day" && prev.ymd, l.week.end);
      }
    });
    // 날짜 줄은 그 달 전체
    assert.equal(lines.filter((l) => l.kind === "day").length, 31);
  }
});

test("주 소계 라벨·열 머리글 — 3주 (10/12~10/18)", () => {
  const w = monthWeeks("2026-10")[2];
  assert.equal(weekLabel(w), "3주 (10/12~10/18)");
  const col = buildColumns("month", "2026-10", "2026-10-01")[2];
  assert.equal(`${col.title} (${col.sub})`, "3주 (10/12~10/18)");
  // 하루짜리 주
  assert.equal(weekLabel(monthWeeks("2026-11")[5]), "6주 (11/30)");
});

test("주소 week — 그 달 주 번호만, 나머지는 무시", () => {
  assert.equal(parseWeekParam("3", "2026-10"), 3);
  assert.equal(parseWeekParam("5", "2026-10"), 5); // 10월은 5주
  assert.equal(parseWeekParam("6", "2026-10"), null);
  assert.equal(parseWeekParam("6", "2026-11"), 6); // 11월은 6주(11/30)
  for (const bad of ["0", "-1", "2.5", "03x", "abc", "", null, undefined]) {
    assert.equal(parseWeekParam(bad, "2026-10"), null, String(bad));
  }
});

test("주소 day — 보고 있는 주 안의 실제 날짜만, 나머지는 무시", () => {
  assert.equal(parseDayParam("2026-11-18", "2026-11-16"), "2026-11-18");
  assert.equal(parseDayParam("2026-11-22", "2026-11-19"), "2026-11-22"); // 일요일
  assert.equal(parseDayParam("2026-11-23", "2026-11-19"), null); // 다음 주
  assert.equal(parseDayParam("2026-11-15", "2026-11-19"), null); // 지난 주 일요일
  for (const bad of ["2026-02-30", "2026-11-1", "20261118", "", null, undefined]) {
    assert.equal(parseDayParam(bad, "2026-11-16"), null, String(bad));
  }
});

test("이전/다음 직원 — 표 순서(부서 필터 반영)대로, 끝에서는 없음", () => {
  // 서버가 부서 필터를 적용해 돌려준 표 순서
  const all = [5, 2, 9, 7];
  const filtered = [2, 7];
  assert.deepEqual(neighborIds(all, 5), { prev: null, next: 2 });
  assert.deepEqual(neighborIds(all, 9), { prev: 2, next: 7 });
  assert.deepEqual(neighborIds(all, 7), { prev: 9, next: null });
  assert.deepEqual(neighborIds(filtered, 2), { prev: null, next: 7 }); // 필터 밖 9 는 건너뜀
  assert.deepEqual(neighborIds(filtered, 7), { prev: 2, next: null });
  assert.deepEqual(neighborIds(filtered, 9), { prev: null, next: null }); // 표에 없는 직원
  assert.deepEqual(neighborIds([4], 4), { prev: null, next: null });
});

test("주별 열 — 월~일 하루씩, weekIndex 없음", () => {
  const cols = buildColumns("week", "2026-11", "2026-11-19");
  assert.deepEqual(cols.map((c) => c.key), daysInRange("2026-11-16", "2026-11-22"));
  assert.ok(cols.every((c) => c.weekIndex === null && c.days.length === 1));
});

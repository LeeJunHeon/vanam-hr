// npm run test:work-hours — lib/work-hours (근무시간 집계 화면 계산·주 분할·조회 범위) 단위 테스트.
// DB·서버 전용 모듈 없이 돈다.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeDayWorkMinutes,
  decideWorkHoursScope,
  formatHM,
  formatPeriodTotal,
  monthWeeks,
  parseWorkHoursPolicy,
  parseYm,
  parseYmd,
  summarizeDay,
  sumDays,
  weekRange,
  workHoursRuleSentence,
  DEFAULT_WORK_HOURS_POLICY,
  type DailyRecordInput,
} from "@/lib/work-hours";

const at = (hhmm: string, day = "2026-11-16") => new Date(`${day}T${hhmm}:00+09:00`);
const stay = (h: number, m = 0) => {
  const r = computeDayWorkMinutes(at("09:00"), new Date(at("09:00").getTime() + (h * 60 + m) * 60000));
  assert.equal(r.status, "ok");
  return r as Extract<typeof r, { status: "ok" }>;
};

test("휴게 공제 예시 5개 (270분마다 30분)", () => {
  assert.deepEqual(stay(3), { status: "ok", stayMinutes: 180, breakMinutes: 0, workMinutes: 180 });
  assert.equal(stay(5).breakMinutes, 30);
  assert.equal(formatHM(stay(5).workMinutes), "4:30");
  assert.equal(stay(9).breakMinutes, 60);
  assert.equal(formatHM(stay(9).workMinutes), "8:00");
  assert.equal(stay(13).breakMinutes, 60);
  assert.equal(formatHM(stay(13).workMinutes), "12:00");
  assert.equal(stay(13, 30).breakMinutes, 90);
  assert.equal(formatHM(stay(13, 30).workMinutes), "12:00");
});

test("경계: 4:29 → 공제 0, 4:30 → 30분", () => {
  assert.equal(stay(4, 29).breakMinutes, 0);
  assert.equal(stay(4, 30).breakMinutes, 30);
});

test("초는 버리고 분으로 계산", () => {
  const r = computeDayWorkMinutes(
    new Date("2026-11-16T09:00:59+09:00"),
    new Date("2026-11-16T18:00:01+09:00")
  );
  assert.equal(r.status === "ok" && r.stayMinutes, 540);
});

test("퇴근 없음 / 출근 없음 / 음수", () => {
  assert.deepEqual(computeDayWorkMinutes(at("09:00"), null), { status: "no_checkout" });
  assert.deepEqual(computeDayWorkMinutes(null, at("18:00")), { status: "invalid" });
  assert.deepEqual(computeDayWorkMinutes(at("18:00"), at("09:00")), { status: "invalid" });
});

test("정책값 변경 (240분마다 60분)", () => {
  const p = { breakPerStayMinutes: 240, breakMinutes: 60 };
  const r = computeDayWorkMinutes(at("09:00"), at("18:00"), p); // 540분
  assert.deepEqual(r, { status: "ok", stayMinutes: 540, breakMinutes: 120, workMinutes: 420 });
  assert.match(workHoursRuleSentence(p), /머문 시간 4시간마다 1시간/);
  assert.match(workHoursRuleSentence(DEFAULT_WORK_HOURS_POLICY), /머문 시간 4시간 30분마다 30분/);
});

test("정책 해석: 행 없음·이상값은 기본값", () => {
  assert.deepEqual(parseWorkHoursPolicy(new Map()), DEFAULT_WORK_HOURS_POLICY);
  assert.deepEqual(
    parseWorkHoursPolicy(new Map([["work_hours_break_per_stay_minutes", "0"], ["work_hours_break_minutes", "abc"]])),
    DEFAULT_WORK_HOURS_POLICY
  );
  assert.deepEqual(
    parseWorkHoursPolicy(new Map([["work_hours_break_per_stay_minutes", "240"], ["work_hours_break_minutes", "60"]])),
    { breakPerStayMinutes: 240, breakMinutes: 60 }
  );
});

test("2026-11 월별 주 칸 — 월~일, 그 달 날짜만 (11/1 은 일요일)", () => {
  const w = monthWeeks("2026-11").map((x) => `${x.index}:${x.start}~${x.end}`);
  assert.deepEqual(w, [
    "1:2026-11-01~2026-11-01",
    "2:2026-11-02~2026-11-08",
    "3:2026-11-09~2026-11-15",
    "4:2026-11-16~2026-11-22",
    "5:2026-11-23~2026-11-29",
    "6:2026-11-30~2026-11-30",
  ]);
});

test("월 경계: 2026-02(일요일 시작, 토요일 끝)·2025-11(토요일 시작)", () => {
  const feb = monthWeeks("2026-02");
  assert.deepEqual(feb[0], { index: 1, start: "2026-02-01", end: "2026-02-01" });
  assert.deepEqual(feb[feb.length - 1], { index: 5, start: "2026-02-23", end: "2026-02-28" });
  const nov25 = monthWeeks("2025-11");
  assert.deepEqual(nov25[0], { index: 1, start: "2025-11-01", end: "2025-11-02" });
});

test("2026-11-16 주별 범위 = 월 11/16 ~ 일 11/22, 일요일은 그 주 마지막", () => {
  assert.deepEqual(weekRange("2026-11-16"), { start: "2026-11-16", end: "2026-11-22" });
  assert.deepEqual(weekRange("2026-11-22"), { start: "2026-11-16", end: "2026-11-22" });
  assert.deepEqual(weekRange("2026-11-01"), { start: "2026-10-26", end: "2026-11-01" });
});

test("쿼리 형식 검증", () => {
  assert.equal(parseYm("2026-11"), "2026-11");
  assert.equal(parseYm("2026-13"), null);
  assert.equal(parseYm("2026-1"), null);
  assert.equal(parseYmd("2026-11-16"), "2026-11-16");
  assert.equal(parseYmd("2026-02-30"), null);
  assert.equal(parseYmd("abc"), null);
});

const row = (p: Partial<DailyRecordInput>): DailyRecordInput => ({
  workDate: "2026-11-16",
  checkIn: null,
  checkOut: null,
  originalCheckIn: null,
  originalCheckOut: null,
  isOverridden: false,
  overrideSource: null,
  autoStatus: "normal",
  categoryName: null,
  categoryType: null,
  ...p,
});

test("하루 요약: WiFi / 승인 정정 / 출장 무기록 / 퇴근 없음", () => {
  const P = DEFAULT_WORK_HOURS_POLICY;
  const wifi = summarizeDay(row({ checkIn: at("09:00"), checkOut: at("18:00") }), P);
  assert.equal(wifi.source, "WiFi");
  assert.equal(wifi.countedMinutes, 480);

  const corr = summarizeDay(
    row({
      checkIn: at("08:30"),
      checkOut: at("18:00"),
      originalCheckIn: at("10:00"),
      isOverridden: true,
      overrideSource: "manual",
    }),
    P
  );
  assert.equal(corr.source, "정정(출근)");
  assert.equal(corr.countedMinutes, 570 - 60);

  const trip = summarizeDay(
    row({ isOverridden: true, overrideSource: "calendar", categoryName: "출장", categoryType: "work" }),
    P
  );
  assert.equal(trip.countedMinutes, 0);
  assert.deepEqual(trip.notes, ["출장"]);

  const tripWifi = summarizeDay(
    row({ checkIn: at("09:00"), checkOut: at("13:00"), isOverridden: true, overrideSource: "calendar", categoryName: "외근", categoryType: "work" }),
    P
  );
  assert.equal(tripWifi.source, "WiFi");
  assert.equal(tripWifi.countedMinutes, 240);

  const open = summarizeDay(row({ checkIn: at("09:00"), autoStatus: "working" }), P);
  assert.deepEqual(open.notes, ["퇴근 없음"]);
  const total = sumDays([wifi, open]);
  assert.equal(formatPeriodTotal(total), "8:00 (퇴근 없음 1일 제외)");
});

// 조회 범위 — 세션 → 플래그는 lib/auth-helpers(isAdminSession·canViewAllEmployees) 가 정한다.
//   CEO: isAdmin, canViewAll / 부서 없는 관리자: isAdmin, canViewAll
//   부서 관리자: isAdmin, !canViewAll, ownDepartmentId / 일반 직원: !isAdmin
test("권한: CEO·부서 없는 관리자 → 전체, 부서 필터 가능", () => {
  const all = { isAdmin: true, canViewAll: true, ownDepartmentId: null };
  assert.deepEqual(decideWorkHoursScope(all, null), { ok: true, departmentFilter: null });
  assert.deepEqual(decideWorkHoursScope(all, 3), { ok: true, departmentFilter: 3 });
  assert.deepEqual(decideWorkHoursScope(all, null, 7), { ok: true, departmentFilter: null });
});

test("권한: 부서 관리자 → 본인 부서 강제, 다른 부서·직원은 403", () => {
  const dept = { isAdmin: true, canViewAll: false, ownDepartmentId: 2 };
  assert.deepEqual(decideWorkHoursScope(dept, null), { ok: true, departmentFilter: 2 });
  assert.deepEqual(decideWorkHoursScope(dept, 2, 2), { ok: true, departmentFilter: 2 });
  assert.equal(decideWorkHoursScope(dept, 3).ok, false);
  assert.equal(decideWorkHoursScope(dept, null, 3).ok, false);
  assert.equal(decideWorkHoursScope(dept, null, null).ok, false);
});

test("권한: 일반 직원 → 403", () => {
  const emp = { isAdmin: false, canViewAll: false, ownDepartmentId: 2 };
  const r = decideWorkHoursScope(emp, null);
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.status, 403);
});

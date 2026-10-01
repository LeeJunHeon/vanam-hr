// parity TS 실행기 — cases.json 을 웹 규칙 함수(lib)로 계산해 JSON 으로 출력한다.
// 비교는 tests/parity/run.mjs (npm run parity) 가 한다. DB·서버 전용 모듈 없이 돈다.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { evalKeys } from "@/lib/attendanceLabels";
import {
  buildJudgeCtx,
  effectiveWorkWindow,
  isAllDayRequest,
  judgeDay,
} from "@/lib/attendance-judge";
import { resolveShiftPoint } from "@/lib/shift-schedule";
import { isResearchMeetingDay } from "@/lib/researchMeeting";
import { kstWorkDateMidnightUtc } from "@/lib/kst-date";
import {
  LIVE_REQUEST_STATUSES,
  LEAVE_WORK_CATEGORY_TYPES,
} from "@/lib/attendance-live-requests";
import { LEAVE_CATEGORY_TYPES, WORK_CATEGORY_TYPES } from "@/lib/category-kind";

/* eslint-disable @typescript-eslint/no-explicit-any */
const here = dirname(fileURLToPath(import.meta.url));
const cases: any = JSON.parse(readFileSync(join(here, "cases.json"), "utf-8"));

const dt = (s: string | null) => (s == null ? null : new Date(s));
const d = (s: string) => new Date(s + "T00:00:00.000Z");
// KST ISO (Python iso() 와 같은 형식: YYYY-MM-DDTHH:MM:SS+09:00)
const iso = (v: Date | null) =>
  v == null ? null : new Date(v.getTime() + 9 * 3600000).toISOString().slice(0, 19) + "+09:00";

const JUDGE_DEFAULTS = {
  work_date: "2026-09-29",
  cutoff: 4,
  shift: { start: "09:00", end: "18:00", type: "day" },
  holiday: false,
  now: "2026-09-29T23:00:00+09:00",
};
const POLICY_DEFAULTS = {
  grace_in_minutes: 10,
  grace_out_minutes: 0,
  lunch_deduct_enabled: false,
  lunch_start: "12:00",
  lunch_end: "13:00",
  timed_trip_exempt: false,
  timed_event_margin_hours: 0,
};

const out: Record<string, unknown> = {};

out.eval_keys = cases.eval_keys.map((c: any) => evalKeys(c.auto, c.late, c.early, c.has_out));
out.all_day = cases.all_day.map((c: any) => isAllDayRequest(dt(c.ci), dt(c.co)));

out.window = cases.window.map((c: any) => {
  const w = effectiveWorkWindow(
    dt(c.shift[0])!,
    dt(c.shift[1])!,
    c.leaves.map(([a, b]: [string, string]) => ({ start: dt(a)!, end: dt(b)! }))
  );
  return w.fullCover
    ? { full_cover: true }
    : {
        ref_in: iso(w.refIn),
        ref_out: iso(w.refOut),
        full_cover: false,
        window_minutes: w.windowMinutes,
        middle_minutes: w.middleMinutes,
      };
});

out.judge_day = cases.judge_day.map((c: any) => {
  const cc = { ...JUDGE_DEFAULTS, ...c };
  const pol = { ...POLICY_DEFAULTS, ...(c.policy ?? {}) };
  const reqs = (c.requests ?? []).map((r: any) => ({
    categoryType: r.type,
    correctedCheckIn: dt(r.ci),
    correctedCheckOut: dt(r.co),
  }));
  const ctx = buildJudgeCtx(reqs, cc.shift, d(cc.work_date), cc.cutoff, !!cc.holiday, dt(cc.now)!, {
    graceInMinutes: pol.grace_in_minutes,
    graceOutMinutes: pol.grace_out_minutes,
    lunchDeductEnabled: pol.lunch_deduct_enabled,
    lunchStart: pol.lunch_start,
    lunchEnd: pol.lunch_end,
    timedTripExempt: pol.timed_trip_exempt,
    timedEventMarginHours: Number(pol.timed_event_margin_hours),
  });
  const j = judgeDay(dt(c.check_in), dt(c.check_out), ctx);
  return [j.status, j.isLate, j.isEarlyLeave];
});

out.shift_point = cases.shift_point.map((c: any) => {
  const schedule = Array.from({ length: c.cycle_days }, (_, i) => ({
    dayIndex: i, type: "day", start: "09:00", end: "18:00",
  }));
  const p = resolveShiftPoint(d(c.start_date), c.cycle_days, schedule, d(c.work_date));
  return p ? p.dayIndex ?? null : null;
});

out.research_meeting = cases.research_meeting.map((c: any) =>
  isResearchMeetingDay(c.date, {
    weekday: c.weekday,
    intervalWeeks: c.interval,
    anchorDate: c.anchor,
    start: "09:00",
    end: "18:00",
  })
);

out.work_date = cases.work_date.map((c: any) =>
  kstWorkDateMidnightUtc(c.cutoff, new Date(c.now).getTime()).toISOString().slice(0, 10)
);

out.constants = {
  web: {
    live_statuses: LIVE_REQUEST_STATUSES,
    leave_types: LEAVE_CATEGORY_TYPES,
    work_types: WORK_CATEGORY_TYPES,
    leave_work_types: LEAVE_WORK_CATEGORY_TYPES,
  },
};

process.stdout.write(JSON.stringify(out));

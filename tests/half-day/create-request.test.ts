// npm run test:half-day — 반차 신청 시각 자동 지정 (lib/create-attendance-request, 웹 POST·챗 POST /api/internal/create-request 공용).
// DB(@/lib/prisma)·세션·챗 인증·결재선·연차 잔여·승인 후처리만 가짜로 바꾸고, 신청 검사·시프트 조회(lib/employee-shift ·
// attendance-correction loadShiftTimes)·반차 기본 시각(lib/half-day-info)은 그대로 돈다.
process.env.TZ = "Asia/Seoul"; // 챗이 보낸 "YYYY-MM-DDTHH:MM" 은 서버 시간대(운영 TZ=Asia/Seoul)로 해석된다
import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { NextRequest } from "next/server";
import {
  HALF_DAY_NO_DEFAULT_MSG,
  HALF_DAY_ONE_SIDED_MSG,
  HALF_DAY_SINGLE_DATE_MSG,
} from "@/lib/half-day";

const fakeModule = (specifier: string, exports: Record<string, unknown>) =>
  mock.module(specifier, { exports } as Parameters<typeof mock.module>[1]);

type Point = { dayIndex: number; type: string; start: string | null; end: string | null };
const week = (start: string, end: string): Point[] =>
  Array.from({ length: 7 }, (_, i) =>
    i < 5 ? { dayIndex: i, type: "day", start, end } : { dayIndex: i, type: "off", start: null, end: null }
  );

// 직원 8 의 시프트 배정 (없으면 미배정). 배정 시작 2026-11-02(월) — dayIndex 0 = 월요일
let assignment: { schedule: Point[]; half_day_split_minutes: number | null } | null = null;
let policySplit: string | null = null;
let holidays: string[] = [];
let created: Record<string, unknown>[] = [];

const CATEGORIES: Record<number, { id: number; code: string; name: string; type: string; annualLeaveDeduct: number; requireApproval: boolean; isActive: boolean }> = {
  1: { id: 1, code: "HALF_AM", name: "오전반차", type: "leave", annualLeaveDeduct: 0.5, requireApproval: true, isActive: true },
  2: { id: 2, code: "HALF_PM", name: "오후반차", type: "leave", annualLeaveDeduct: 0.5, requireApproval: true, isActive: true },
  3: { id: 3, code: "SICK", name: "병가", type: "leave", annualLeaveDeduct: 0, requireApproval: true, isActive: true },
};

const prismaFake = {
  employee: {
    findUnique: async () => ({
      id: 8, name: "황직원", isActive: true, departmentId: 3, position: { code: "EMPLOYEE" }, attendsResearchMeeting: false,
    }),
  },
  attendanceCategory: {
    findUnique: async ({ where }: { where: { id: number } }) => CATEGORIES[where.id] ?? null,
    findFirst: async ({ where }: { where: { name: string } }) =>
      Object.values(CATEGORIES).find((c) => c.name === where.name) ?? null,
  },
  // lib/employee-shift loadShiftAssignments
  $queryRaw: async () =>
    assignment
      ? [{ employee_id: 8, start_date: new Date("2026-11-02T00:00:00.000Z"), end_date: null, cycle_days: 7, ...assignment }]
      : [],
  policySetting: {
    findUnique: async () => (policySplit ? { value: policySplit } : null),
    findMany: async () => [],
  },
  attendanceRequest: {},
  $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      attendanceRequest: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          created.push(data);
          return { id: 500 + created.length, status: data.status, ...data };
        },
      },
    }),
};

fakeModule("@/lib/prisma", { prisma: prismaFake });
fakeModule("@/auth", { auth: async () => ({ user: { role: "employee", departmentId: 3, employeeId: 8 } }) });
fakeModule("@/lib/annual-leave", {
  getHolidaySet: async () => new Set(holidays),
  checkLeaveRequest: async () => ({ ok: true }),
  loadWorkDayChecker: async () => () => true,
});
fakeModule("@/lib/approval-resolver", {
  resolveApprovers: async () => ({ approverIds: [99], approvalMode: "all", deputyApproverId: null, excludedSelf: false }),
  getApprovalCategoryId: async (c: { id: number }) => c.id,
});
fakeModule("@/lib/notify", { createNotifications: async () => {} });
fakeModule("@/lib/finalize-approval", {
  applyApprovedRequestToDaily: async () => 0,
  syncApprovedRequestToCalendar: async () => {},
  notifyTeamOfApprovedRequest: async () => {},
  revertCancelledRequestFromDaily: async () => 0,
});
fakeModule("@/lib/internal-write-auth", { requireHrWriteAuth: () => ({ ok: true, actingEmail: "hwang@test" }) });
fakeModule("@/lib/internal-identity", { resolveHrIdentity: async () => ({ employeeId: 8 }) });

const { POST: chatPOST } = await import("@/app/api/internal/create-request/route");
const { POST: webPOST } = await import("@/app/api/attendance-requests/route");
const { validateAttendanceRequestInput } = await import("@/lib/create-attendance-request");

beforeEach(() => {
  assignment = { schedule: week("09:00", "18:00"), half_day_split_minutes: null };
  policySplit = null;
  holidays = [];
  created = [];
});

async function chat(body: Record<string, unknown>) {
  const req = new Request("http://localhost/api/internal/create-request", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const res = await chatPOST(req);
  return { status: res.status, body: await res.json() };
}

const kstHM = (d: unknown) => new Date(d as Date).toLocaleTimeString("en-GB", { timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit" });
const MON = "2026-11-23";

test("반차 시각 없음 → 그날 시프트 기준 (09~18, 240분 → 오후 13:00~18:00), 응답 필드·안내 문구", async () => {
  const r = await chat({ category: "오후반차", startDate: MON, endDate: MON });
  assert.equal(r.status, 201);
  assert.equal(r.body.correctedCheckIn, "13:00");
  assert.equal(r.body.correctedCheckOut, "18:00");
  assert.equal(r.body.timesFilledFromShift, true);
  assert.equal(r.body.message, `오후반차 ${MON} 13:00~18:00 으로 신청되었습니다. (그날 시프트 기준 시각으로 자동 지정)`);
  assert.equal(kstHM(created[0].correctedCheckIn), "13:00");
  assert.equal(kstHM(created[0].correctedCheckOut), "18:00");
  assert.equal((created[0].correctedCheckIn as Date).toISOString(), "2026-11-23T04:00:00.000Z");
});

test("패턴 반차 경계 반영 (07~17, 패턴 300분 → 오전 07:00~12:00), 정책 값보다 패턴 우선", async () => {
  assignment = { schedule: week("07:00", "17:00"), half_day_split_minutes: 300 };
  policySplit = "180";
  const r = await chat({ category: "오전반차", startDate: MON, endDate: MON });
  assert.equal(r.status, 201);
  assert.deepEqual([r.body.correctedCheckIn, r.body.correctedCheckOut], ["07:00", "12:00"]);
  // 패턴 값이 없으면 정책 값(180분 → 오후 10:00~17:00)
  assignment = { schedule: week("07:00", "17:00"), half_day_split_minutes: null };
  const r2 = await chat({ category: "오후반차", startDate: MON, endDate: MON });
  assert.deepEqual([r2.body.correctedCheckIn, r2.body.correctedCheckOut], ["10:00", "17:00"]);
});

test("시프트 미배정 → 예전 고정값 (오전 09:00~13:00)", async () => {
  assignment = null;
  const r = await chat({ category: "오전반차", startDate: MON, endDate: MON });
  assert.equal(r.status, 201);
  assert.deepEqual([r.body.correctedCheckIn, r.body.correctedCheckOut, r.body.timesFilledFromShift], ["09:00", "13:00", true]);
});

test("휴무일·공휴일·자정 넘는 시프트 → 400, 저장 없음", async () => {
  const off = await chat({ category: "오후반차", startDate: "2026-11-21", endDate: "2026-11-21" }); // 토요일
  assert.equal(off.status, 400);
  assert.equal(off.body.error, HALF_DAY_NO_DEFAULT_MSG);

  holidays = [MON];
  assert.equal((await chat({ category: "오후반차", startDate: MON, endDate: MON })).body.error, HALF_DAY_NO_DEFAULT_MSG);
  holidays = [];

  assignment = { schedule: week("22:00", "07:00"), half_day_split_minutes: null };
  const night = await chat({ category: "오전반차", startDate: MON, endDate: MON });
  assert.equal(night.status, 400);
  assert.equal(night.body.error, HALF_DAY_NO_DEFAULT_MSG);
  assert.equal(created.length, 0);
});

test("시프트 조회 실패 → 400", async () => {
  const orig = prismaFake.$queryRaw;
  prismaFake.$queryRaw = async () => {
    throw new Error("db down");
  };
  try {
    const r = await chat({ category: "오후반차", startDate: MON, endDate: MON });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, HALF_DAY_NO_DEFAULT_MSG);
  } finally {
    prismaFake.$queryRaw = orig;
  }
});

test("반차 시각 한쪽만 → 400, 여러 날 → 400", async () => {
  const one = await chat({ category: "오후반차", startDate: MON, endDate: MON, startTime: "13:00" });
  assert.equal(one.status, 400);
  assert.equal(one.body.error, HALF_DAY_ONE_SIDED_MSG);
  const multi = await chat({ category: "오후반차", startDate: MON, endDate: "2026-11-24" });
  assert.equal(multi.status, 400);
  assert.equal(multi.body.error, HALF_DAY_SINGLE_DATE_MSG);
  assert.equal(created.length, 0);
});

test("시각을 지정하면 그대로 (시프트와 달라도 허용)", async () => {
  const r = await chat({ category: "오후반차", startDate: MON, endDate: MON, startTime: "14:30", endTime: "20:00" });
  assert.equal(r.status, 201);
  assert.deepEqual([r.body.correctedCheckIn, r.body.correctedCheckOut, r.body.timesFilledFromShift], ["14:30", "20:00", false]);
  assert.equal(r.body.message, `오후반차 ${MON} 14:30~20:00 으로 신청되었습니다.`);
});

test("반차 아닌 시간형 카테고리 — 시각 없이 종일 허용 (기존 그대로), 여러 날도 허용", async () => {
  const r = await chat({ category: "병가", startDate: MON, endDate: "2026-11-24" });
  assert.equal(r.status, 201);
  assert.deepEqual([r.body.correctedCheckIn, r.body.correctedCheckOut, r.body.timesFilledFromShift], [null, null, false]);
  assert.equal(r.body.message, `병가 ${MON}~2026-11-24 으로 신청되었습니다.`);
  assert.equal(created[0].correctedCheckIn, null);
});

test("웹 POST 응답에도 저장 시각·timesFilledFromShift", async () => {
  const req = new Request("http://localhost/api/attendance-requests", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ employeeId: 8, categoryId: 2, startDate: MON, endDate: MON }),
  }) as unknown as NextRequest;
  const res = await webPOST(req);
  const body = await res.json();
  assert.equal(res.status, 201);
  assert.deepEqual(
    [body.correctedCheckIn, body.correctedCheckOut, body.timesFilledFromShift],
    ["13:00", "18:00", true]
  );
});

test("결재 대기 중 수정(PUT 이 쓰는 같은 검사) — 반차 시각을 비우면 채움, 못 채우면 400", async () => {
  const ok = await validateAttendanceRequestInput(
    { employeeId: 8, categoryId: 1, startDate: MON, endDate: MON, correctedCheckIn: null, correctedCheckOut: null },
    { excludeRequestId: 77 }
  );
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(ok.timesFilledFromShift, true);
    assert.equal(kstHM(ok.cciDate), "09:00");
    assert.equal(kstHM(ok.ccoDate), "13:00");
  }
  const bad = await validateAttendanceRequestInput(
    { employeeId: 8, categoryId: 1, startDate: "2026-11-22", endDate: "2026-11-22", correctedCheckIn: null, correctedCheckOut: null },
    { excludeRequestId: 77 }
  );
  assert.deepEqual(bad, { ok: false, error: HALF_DAY_NO_DEFAULT_MSG, status: 400 });
});

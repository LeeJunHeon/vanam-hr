// npm run test:half-day — PUT /api/attendance-requests?id=N { action: "retime" } (관리자 반차 시각 수정) 테스트.
// 세션(@/auth)·DB(@/lib/prisma)·알림(@/lib/notify)·calendar-syncer(fetch)만 가짜로 바꾸고 route·lib 판정은 그대로 돈다.
import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { NextRequest } from "next/server";

type FakeSession = {
  user: { role: string; departmentId: number | null; employeeId: number | null; name?: string };
};
let session: FakeSession | null = null;

interface FakeRequest {
  id: number;
  employeeId: number;
  status: string;
  externalSource: string | null;
  externalEventId: string | null;
  calendarSourceId: number | null;
  startDate: Date;
  endDate: Date;
  correctedCheckIn: Date | null;
  correctedCheckOut: Date | null;
  category: { type: string; name: string };
  employee: { name: string; departmentId: number | null };
}

const kst = (ymd: string, hm: string) => new Date(`${ymd}T${hm}:00+09:00`);
const day = (ymd: string) => new Date(`${ymd}T00:00:00.000Z`);

let requests: FakeRequest[] = [];
let updates: { where: Record<string, unknown>; data: Record<string, unknown> }[] = [];
let recalcUpserts: { employeeId: number; workDate: Date }[] = [];
let notifications: { employeeIds: number[]; type: string; body?: string | null }[] = [];
let fetchCalls: { url: string; method: string; body: unknown }[] = [];
let fetchStatus = 200;

function halfPm(over: Partial<FakeRequest> = {}): FakeRequest {
  return {
    id: 100,
    employeeId: 8,
    status: "approved",
    externalSource: "hr",
    externalEventId: "evt-1",
    calendarSourceId: 5,
    startDate: day("2026-11-10"),
    endDate: day("2026-11-10"),
    correctedCheckIn: kst("2026-11-10", "13:00"),
    correctedCheckOut: kst("2026-11-10", "20:00"),
    category: { type: "leave", name: "오후반차" },
    employee: { name: "황직원", departmentId: 3 },
    ...over,
  };
}

const sameTime = (a: unknown, b: Date | null) =>
  a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : a === b;

const fakeModule = (specifier: string, exports: Record<string, unknown>) =>
  mock.module(specifier, { exports } as Parameters<typeof mock.module>[1]);

const tx = {
  attendanceRequest: {
    updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      updates.push({ where, data });
      const r = requests.find(
        (x) =>
          x.id === where.id &&
          x.status === where.status &&
          sameTime(where.correctedCheckIn, x.correctedCheckIn) &&
          sameTime(where.correctedCheckOut, x.correctedCheckOut)
      );
      if (!r) return { count: 0 };
      r.correctedCheckIn = data.correctedCheckIn as Date;
      r.correctedCheckOut = data.correctedCheckOut as Date;
      return { count: 1 };
    },
  },
  attendanceDaily: {
    upsert: async ({ where }: { where: { employeeId_workDate: { employeeId: number; workDate: Date } } }) => {
      recalcUpserts.push(where.employeeId_workDate);
      return {};
    },
  },
};

fakeModule("@/auth", { auth: async () => session });
fakeModule("@/lib/notify", {
  createNotifications: async (args: { employeeIds: number[]; type: string; body?: string | null }) => {
    notifications.push(args);
  },
});
fakeModule("@/lib/prisma", {
  prisma: {
    attendanceRequest: {
      findUnique: async ({ where }: { where: { id: number } }) => {
        const r = requests.find((x) => x.id === where.id);
        return r ? { ...r } : null;
      },
      findMany: async ({ where }: { where: { id: { not: number }; employeeId: number } }) =>
        requests
          .filter((x) => x.id !== where.id.not && x.employeeId === where.employeeId)
          .map((x) => ({ id: x.id, correctedCheckIn: x.correctedCheckIn, correctedCheckOut: x.correctedCheckOut, category: x.category })),
    },
    $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    calendarSource: { findUnique: async () => ({ calendarId: "team@group.calendar.google.com" }) },
    employee: { findUnique: async () => ({ name: "관리자김" }) },
    policySetting: { findMany: async () => [], findUnique: async () => null },
  },
});

process.env.CALENDAR_SYNCER_URL = "http://syncer.test";
process.env.INTERNAL_API_TOKEN = "tok";
globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
  fetchCalls.push({ url: String(url), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null });
  return new Response(JSON.stringify({ ok: fetchStatus === 200 }), { status: fetchStatus });
}) as typeof fetch;

const { PUT } = await import("@/app/api/attendance-requests/route");

beforeEach(() => {
  requests = [halfPm()];
  updates = [];
  recalcUpserts = [];
  notifications = [];
  fetchCalls = [];
  fetchStatus = 200;
});

async function retime(s: FakeSession | null, body: Record<string, unknown>, id = 100) {
  session = s;
  const req = new Request(`http://localhost/api/attendance-requests?id=${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "retime", ...body }),
  }) as unknown as NextRequest;
  const res = await PUT(req);
  return { status: res.status, body: await res.json() };
}

const ceo: FakeSession = { user: { role: "ceo", departmentId: null, employeeId: 1 } };
const hrAdmin: FakeSession = { user: { role: "admin", departmentId: null, employeeId: 2 } };
const deptAdmin: FakeSession = { user: { role: "admin", departmentId: 3, employeeId: 3 } };
const otherDeptAdmin: FakeSession = { user: { role: "admin", departmentId: 4, employeeId: 4 } };
const staff: FakeSession = { user: { role: "employee", departmentId: 3, employeeId: 8 } };
const NEW = { correctedCheckIn: "12:00", correctedCheckOut: "20:00" };

test("권한 — CEO·부서 없는 관리자·같은 부서 관리자 OK, 다른 부서 관리자·일반 직원 403", async () => {
  assert.equal((await retime(ceo, NEW)).status, 200);
  requests = [halfPm()];
  assert.equal((await retime(hrAdmin, NEW)).status, 200);
  requests = [halfPm()];
  assert.equal((await retime(deptAdmin, NEW)).status, 200);
  requests = [halfPm()];
  assert.equal((await retime(otherDeptAdmin, NEW)).status, 403);
  assert.equal((await retime(staff, NEW)).status, 403);
  assert.equal(updates.length, 3);
});

test("대상 조건 — 캘린더 출처·출장 출처·결재 대기·종일·여러 날은 409, 저장 없음", async () => {
  const cases: [Partial<FakeRequest>, RegExp][] = [
    [{ externalSource: "google_calendar" }, /캘린더에서 고쳐야/],
    [{ externalSource: "trip" }, /출장 및 외근 관리/],
    [{ status: "pending" }, /승인된 신청만/],
    [{ correctedCheckIn: null, correctedCheckOut: null }, /종일/],
    [{ endDate: day("2026-11-11") }, /하루짜리/],
    [{ category: { type: "work", name: "외근" } }, /휴가 신청만/],
  ];
  for (const [over, msg] of cases) {
    requests = [halfPm(over)];
    const r = await retime(ceo, NEW);
    assert.equal(r.status, 409, JSON.stringify(over));
    assert.match(r.body.error, msg);
  }
  assert.equal(updates.length, 0);
  assert.equal(fetchCalls.length, 0);
});

test("검증 — 시작 ≥ 종료 400, 근무일 밖 400", async () => {
  assert.equal((await retime(ceo, { correctedCheckIn: "20:00", correctedCheckOut: "12:00" })).status, 400);
  assert.equal((await retime(ceo, { correctedCheckIn: "02:00", correctedCheckOut: "08:00" })).status, 400); // 04:00 전
  assert.equal((await retime(ceo, { correctedCheckIn: "1200", correctedCheckOut: "20:00" })).status, 400);
  assert.equal(updates.length, 0);
});

test("같은 날 다른 시간형 휴가와 겹치면 409", async () => {
  requests = [
    halfPm(),
    halfPm({ id: 101, correctedCheckIn: kst("2026-11-10", "09:00"), correctedCheckOut: kst("2026-11-10", "12:30"), category: { type: "leave", name: "오전반차" } }),
  ];
  const r = await retime(ceo, NEW);
  assert.equal(r.status, 409);
  assert.match(r.body.error, /겹칩니다/);
  // 겹치지 않으면 OK
  assert.equal((await retime(ceo, { correctedCheckIn: "12:30", correctedCheckOut: "20:00" })).status, 200);
});

test("지난 날짜 — 저장(낙관적 잠금)·재계산 표시·캘린더 PATCH·신청자 알림", async () => {
  const r = await retime(ceo, NEW);
  assert.equal(r.status, 200);
  assert.equal(r.body.changed, true);
  assert.equal(r.body.calendar, "updated");
  assert.deepEqual(r.body.recalcMarked, ["2026-11-10"]);
  // 잠금 조건: id·상태·기존 시각
  assert.equal(updates[0].where.status, "approved");
  assert.ok(sameTime(updates[0].where.correctedCheckIn, kst("2026-11-10", "13:00")));
  assert.deepEqual(recalcUpserts, [{ employeeId: 8, workDate: day("2026-11-10") }]);
  // 캘린더 PATCH 본문
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].method, "PATCH");
  assert.equal(fetchCalls[0].url, "http://syncer.test/internal/calendar-event/evt-1");
  assert.deepEqual(fetchCalls[0].body, {
    calendar_id: "team@group.calendar.google.com",
    start: { dateTime: "2026-11-10T03:00:00.000Z", timeZone: "Asia/Seoul" },
    end: { dateTime: "2026-11-10T11:00:00.000Z", timeZone: "Asia/Seoul" },
  });
  // 알림
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].type, "request_retime");
  assert.deepEqual(notifications[0].employeeIds, [8]);
  assert.equal(
    notifications[0].body,
    "관리자 관리자김님이 11/10 오후반차 시각을 13:00~20:00 → 12:00~20:00 으로 변경했습니다."
  );
});

test("미래 날짜 — 저장하지만 재계산 표시 없음", async () => {
  requests = [
    halfPm({
      startDate: day("2027-01-05"),
      endDate: day("2027-01-05"),
      correctedCheckIn: kst("2027-01-05", "13:00"),
      correctedCheckOut: kst("2027-01-05", "18:00"),
    }),
  ];
  const r = await retime(ceo, { correctedCheckIn: "12:00", correctedCheckOut: "18:00" });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.recalcMarked, []);
  assert.equal(recalcUpserts.length, 0);
});

test("같은 시각 저장 — DB 그대로, 캘린더만 다시 반영, 알림 없음", async () => {
  const r = await retime(ceo, { correctedCheckIn: "13:00", correctedCheckOut: "20:00" });
  assert.equal(r.status, 200);
  assert.equal(r.body.changed, false);
  assert.equal(r.body.calendar, "updated");
  assert.equal(updates.length, 0);
  assert.equal(recalcUpserts.length, 0);
  assert.equal(fetchCalls.length, 1);
  assert.equal(notifications.length, 0);
});

test("캘린더 실패·404 는 DB 변경을 되돌리지 않고 응답으로 알림, 출처 없음은 none", async () => {
  fetchStatus = 500;
  const failed = await retime(ceo, NEW);
  assert.equal(failed.status, 200);
  assert.equal(failed.body.calendar, "failed");
  assert.equal(requests[0].correctedCheckIn?.getTime(), kst("2026-11-10", "12:00").getTime());

  requests = [halfPm()];
  fetchStatus = 404;
  assert.equal((await retime(ceo, NEW)).body.calendar, "not_found");

  requests = [halfPm({ externalSource: null, externalEventId: null, calendarSourceId: null })];
  fetchCalls = [];
  const none = await retime(ceo, NEW);
  assert.equal(none.body.calendar, "none");
  assert.equal(fetchCalls.length, 0);
});

test("그사이 바뀌었으면(잠금 0건) 409", async () => {
  // 조회 뒤 상태가 바뀐 상황 — findUnique 는 approved 를 주지만 updateMany 시점엔 cancelled
  const r0 = requests[0];
  const origUpdate = tx.attendanceRequest.updateMany;
  tx.attendanceRequest.updateMany = async (args) => {
    r0.status = "cancelled";
    return origUpdate(args);
  };
  try {
    const r = await retime(ceo, NEW);
    assert.equal(r.status, 409);
    assert.match(r.body.error, /새로고침/);
    assert.equal(fetchCalls.length, 0);
    assert.equal(notifications.length, 0);
  } finally {
    tx.attendanceRequest.updateMany = origUpdate;
  }
});

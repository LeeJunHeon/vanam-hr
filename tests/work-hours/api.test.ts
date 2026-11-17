// npm run test:work-hours — GET /api/attendance/work-hours 권한 테스트.
// 세션(@/auth)·DB(@/lib/prisma)·행 조립(@/lib/attendance-rows)만 가짜로 바꾸고 route 의 판정은 그대로 돈다.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import type { NextRequest } from "next/server";

type FakeSession = { user: { role: string; departmentId: number | null; employeeId: number | null } };
let session: FakeSession | null = null;
const employeeDept: Record<number, number | null> = { 8: 3, 9: 4 };
let lastEmployeeWhere: Record<string, unknown> | null = null;

// @types/node 에 아직 exports 옵션이 없어 타입만 맞춘다 (Node 26 은 namedExports 를 deprecated 로 경고)
const fakeModule = (specifier: string, exports: Record<string, unknown>) =>
  mock.module(specifier, { exports } as Parameters<typeof mock.module>[1]);

fakeModule("@/auth", { auth: async () => session });
fakeModule("@/lib/attendance-rows", { assembleAttendanceRows: async () => [] });
fakeModule("@/lib/prisma", {
  prisma: {
    employee: {
      findUnique: async ({ where }: { where: { id: number } }) =>
        where.id in employeeDept
          ? { id: where.id, name: `직원${where.id}`, employeeNo: null, isActive: true, departmentId: employeeDept[where.id], department: null }
          : null,
      findMany: async ({ where }: { where: Record<string, unknown> }) => {
        lastEmployeeWhere = where;
        return [];
      },
    },
    department: { findMany: async () => [{ id: 3, name: "개발" }] },
    policySetting: { findUnique: async () => ({ value: "4" }) },
  },
});

const { GET } = await import("@/app/api/attendance/work-hours/route");

async function call(qs: string, s: FakeSession | null) {
  session = s;
  lastEmployeeWhere = null;
  const req = new Request(`http://localhost/api/attendance/work-hours?${qs}`) as unknown as NextRequest;
  const res = await GET(req);
  return { status: res.status, body: await res.json() };
}

const RANGE = "startDate=2026-11-01&endDate=2026-11-30";
const ceo: FakeSession = { user: { role: "ceo", departmentId: 3, employeeId: 1 } };
const hrAdmin: FakeSession = { user: { role: "admin", departmentId: null, employeeId: 2 } };
const deptAdmin: FakeSession = { user: { role: "admin", departmentId: 3, employeeId: 3 } };
const staff: FakeSession = { user: { role: "employee", departmentId: 3, employeeId: 4 } };

test("CEO — 전체, 부서 선택 가능, 다른 부서 직원 상세 가능", async () => {
  const all = await call(RANGE, ceo);
  assert.equal(all.status, 200);
  assert.equal(all.body.scope, "all");
  assert.ok(Array.isArray(all.body.departments));
  assert.equal(lastEmployeeWhere?.departmentId, undefined);
  assert.match(all.body.today, /^\d{4}-\d{2}-\d{2}$/);

  const dept = await call(`${RANGE}&departmentId=4&employeeId=8`, ceo);
  assert.equal(dept.status, 200);
  assert.equal(dept.body.departmentId, 4);
  assert.equal(dept.body.detailEmployee.id, 8);
});

test("부서 없는 관리자 — 전체 조회", async () => {
  const r = await call(`${RANGE}&employeeId=9`, hrAdmin);
  assert.equal(r.status, 200);
  assert.equal(r.body.scope, "all");
  assert.ok(Array.isArray(r.body.departments));
});

test("부서 관리자 — 본인 부서 강제, 다른 부서·다른 부서 직원은 403", async () => {
  const own = await call(RANGE, deptAdmin);
  assert.equal(own.status, 200);
  assert.equal(own.body.departmentId, 3);
  assert.equal(own.body.departments, null);
  assert.equal(lastEmployeeWhere?.departmentId, 3);

  assert.equal((await call(`${RANGE}&departmentId=3&employeeId=8`, deptAdmin)).status, 200);
  assert.equal((await call(`${RANGE}&departmentId=4`, deptAdmin)).status, 403);
  assert.equal((await call(`${RANGE}&employeeId=9`, deptAdmin)).status, 403);
});

test("일반 직원 — 403", async () => {
  assert.equal((await call(RANGE, staff)).status, 403);
});

test("기간 오류 400, 없는 직원 404", async () => {
  assert.equal((await call("startDate=2026-11-30&endDate=2026-11-01", ceo)).status, 400);
  assert.equal((await call("startDate=2026-01-01&endDate=2026-12-31", ceo)).status, 400);
  assert.equal((await call(`${RANGE}&employeeId=999`, ceo)).status, 404);
});

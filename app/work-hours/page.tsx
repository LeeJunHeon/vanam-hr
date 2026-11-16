// 근무시간 집계 (관리자 전용) — 주소(쿼리 포함)만으로 열리는 독립 화면.
//   /work-hours?view=month&month=2026-11            월별 (행=직원, 열=1주…N주+월 합계)
//   /work-hours?view=week&date=2026-11-16           주별 (행=직원, 열=월~일+주 합계)
//   …&employee=8                                    아래에 그 직원의 기간 내 일별 표
//   …&department=3                                  부서 필터 (전체 조회 권한자만)
// 모든 숫자는 표 안 글자로 보인다(툴팁·그래프 없음). 이동은 전부 <a href> 링크 / GET 폼.
// 권한은 서버에서 검사한다: 비로그인 → 로그인, 관리자/CEO 아님 → 403 화면, 부서 관리자는 본인 부서만.
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { canViewAllEmployees, getPageSession, isAdminSession } from "@/lib/auth-helpers";
import { loadWorkHoursPolicy } from "@/lib/attendance-policy";
import { loadWorkHoursData, type WorkHoursEmployee } from "@/lib/work-hours-report";
import { kstTodayYmd } from "@/lib/kst-date";
import { withBasePath } from "@/lib/base-path";
import {
  WEEKDAY_LABELS,
  addDays,
  addMonths,
  dayOfWeek,
  daysInRange,
  decideWorkHoursScope,
  formatDayCell,
  formatHM,
  formatPeriodTotal,
  formatTimeOnWorkDate,
  monthRange,
  monthWeeks,
  parseYm,
  parseYmd,
  shortMd,
  sumDays,
  summarizeDay,
  weekRange,
  workHoursRuleSentence,
  type DailyRecordInput,
  type DaySummary,
} from "@/lib/work-hours";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "근무시간 집계 | VanaM 인사 관리",
};

type SearchParams = Promise<{ [key: string]: string | string[] | undefined }>;

function first(v: string | string[] | undefined): string | null {
  if (Array.isArray(v)) return v[0] ?? null;
  return v ?? null;
}

interface Query {
  view: "month" | "week";
  month: string; // YYYY-MM (월별)
  date: string; // YYYY-MM-DD (주별)
  employee: number | null;
  department: number | null;
}

function buildHref(q: Query, patch: Partial<Query> = {}): string {
  const n = { ...q, ...patch };
  const p = new URLSearchParams();
  p.set("view", n.view);
  if (n.view === "month") p.set("month", n.month);
  else p.set("date", n.date);
  if (n.department !== null) p.set("department", String(n.department));
  if (n.employee !== null) p.set("employee", String(n.employee));
  return `/work-hours?${p.toString()}`;
}

function ErrorScreen({ code, message }: { code: number; message: string }) {
  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl border border-gray-100 w-full max-w-sm p-8 space-y-3 text-center">
        <p className="text-3xl font-bold text-gray-900">{code}</p>
        <p className="text-sm text-gray-600">{message}</p>
        <Link href="/" className="inline-block text-sm font-semibold text-blue-600 hover:underline">
          인사 관리로 돌아가기
        </Link>
      </div>
    </div>
  );
}

const th = "text-xs font-semibold text-gray-500 px-3 py-2.5 whitespace-nowrap border-b border-gray-100";
const td = "px-3 py-2 text-sm text-gray-900 whitespace-nowrap border-b border-gray-50";

function EmployeeName({ e, q }: { e: WorkHoursEmployee; q: Query }) {
  return (
    <Link href={buildHref(q, { employee: e.id })} className="text-blue-600 hover:underline font-medium">
      {e.name}
      {!e.isActive && " (퇴사)"}
    </Link>
  );
}

export default async function WorkHoursPage({ searchParams }: { searchParams: SearchParams }) {
  const session = await getPageSession();
  if (!session) {
    const isLocal = !process.env.NEXTAUTH_URL || process.env.NEXTAUTH_URL.includes("localhost");
    redirect(isLocal ? "/login" : "https://vanam.synology.me/login");
  }

  const viewer = {
    isAdmin: isAdminSession(session),
    canViewAll: canViewAllEmployees(session),
    ownDepartmentId: session.user.departmentId ?? null,
  };
  if (!viewer.isAdmin) {
    return <ErrorScreen code={403} message="관리자 권한이 필요합니다." />;
  }

  // ── 쿼리 검증: view·month·date 가 잘못되면 기본값, employee·department 형식이 틀리면 400 ──
  const sp = await searchParams;
  const today = kstTodayYmd();
  const rawEmployee = first(sp.employee);
  const rawDepartment = first(sp.department);
  if (rawEmployee !== null && rawEmployee !== "" && !/^\d{1,9}$/.test(rawEmployee)) {
    return <ErrorScreen code={400} message="employee 는 직원 번호(정수)여야 합니다." />;
  }
  if (
    rawDepartment !== null &&
    rawDepartment !== "" &&
    rawDepartment !== "all" &&
    !/^\d{1,9}$/.test(rawDepartment)
  ) {
    return <ErrorScreen code={400} message="department 는 부서 번호(정수)여야 합니다." />;
  }
  const q: Query = {
    view: first(sp.view) === "week" ? "week" : "month",
    month: parseYm(first(sp.month)) ?? today.slice(0, 7),
    date: parseYmd(first(sp.date)) ?? today,
    employee: rawEmployee ? Number(rawEmployee) : null,
    department: rawDepartment && rawDepartment !== "all" ? Number(rawDepartment) : null,
  };

  // ── 권한·범위 (lib/auth-helpers 규칙, 부서 관리자는 본인 부서 강제) ──
  let detailEmployee: { id: number; name: string; isActive: boolean; departmentId: number | null } | null =
    null;
  if (q.employee !== null) {
    detailEmployee = await prisma.employee.findUnique({
      where: { id: q.employee },
      select: { id: true, name: true, isActive: true, departmentId: true },
    });
    if (!detailEmployee) {
      // 부서 관리자에게는 다른 부서 직원의 존재 여부도 알리지 않는다
      return viewer.canViewAll ? (
        <ErrorScreen code={404} message="직원을 찾을 수 없습니다." />
      ) : (
        <ErrorScreen code={403} message="해당 직원 조회 권한이 없습니다." />
      );
    }
  }
  const scope = decideWorkHoursScope(
    viewer,
    q.department,
    detailEmployee ? detailEmployee.departmentId : undefined
  );
  if (!scope.ok) return <ErrorScreen code={scope.status} message={scope.message} />;

  // ── 기간 ──
  const period = q.view === "month" ? monthRange(q.month) : weekRange(q.date);
  const days = daysInRange(period.start, period.end);

  const [policy, departments, data] = await Promise.all([
    loadWorkHoursPolicy(prisma),
    prisma.department.findMany({
      where: { isActive: true },
      select: { id: true, name: true },
      orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
    }),
    loadWorkHoursData({
      start: period.start,
      end: period.end,
      departmentFilter: scope.departmentFilter,
      extraEmployeeId: detailEmployee?.id ?? null,
    }),
  ]);

  const summaryOf = (employeeId: number): Map<string, DaySummary> => {
    const recs = data.records.get(employeeId);
    const m = new Map<string, DaySummary>();
    for (const d of days) m.set(d, summarizeDay(recs?.get(d) ?? null, policy));
    return m;
  };
  const summaries = new Map(data.employees.map((e) => [e.id, summaryOf(e.id)]));
  const scopeDeptName =
    scope.departmentFilter === null
      ? "전체"
      : departments.find((d) => d.id === scope.departmentFilter)?.name ?? `부서 #${scope.departmentFilter}`;

  // ── 이동 링크 ──
  const prevHref =
    q.view === "month"
      ? buildHref(q, { month: addMonths(q.month, -1) })
      : buildHref(q, { date: addDays(period.start, -7) });
  const nextHref =
    q.view === "month"
      ? buildHref(q, { month: addMonths(q.month, 1) })
      : buildHref(q, { date: addDays(period.start, 7) });
  const currentHref =
    q.view === "month" ? buildHref(q, { month: today.slice(0, 7) }) : buildHref(q, { date: today });
  const weekViewHref = buildHref(q, {
    view: "week",
    date: q.view === "week" ? q.date : today.startsWith(q.month) ? today : `${q.month}-01`,
  });
  const monthViewHref = buildHref(q, {
    view: "month",
    month: q.view === "month" ? q.month : q.date.slice(0, 7),
  });
  const periodLabel =
    q.view === "month"
      ? `${q.month.slice(0, 4)}년 ${Number(q.month.slice(5, 7))}월 (${period.start} ~ ${period.end})`
      : `${period.start} ~ ${period.end} (월~일)`;

  const navLink = "px-3 py-2 text-sm font-medium rounded-xl border border-gray-200 bg-white text-gray-700 hover:bg-gray-50";
  const tabLink = (active: boolean) =>
    `px-3 py-2 text-sm rounded-xl ${active ? "bg-blue-50 text-blue-600 font-semibold" : "text-gray-600 hover:bg-gray-100"}`;

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="p-4 sm:p-6 space-y-5 max-w-[1400px] mx-auto">
        {/* 헤더 */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <Link href="/?page=attendance-overview" className="text-xs text-blue-600 hover:underline">
              ← 인사 관리
            </Link>
            <h1 className="text-xl sm:text-2xl font-bold text-gray-900 mt-1">근무시간 집계</h1>
            <p className="text-sm text-gray-500 mt-0.5">
              조회 범위: {scopeDeptName} · 기간: {periodLabel}
            </p>
          </div>
          <div className="flex items-center gap-1 bg-white rounded-xl border border-gray-100 p-1 self-start">
            <Link href={weekViewHref} className={tabLink(q.view === "week")}>주별</Link>
            <Link href={monthViewHref} className={tabLink(q.view === "month")}>월별</Link>
          </div>
        </div>

        {/* 기준 문장 */}
        <div className="bg-blue-50 border border-blue-100 rounded-2xl px-4 py-3 text-sm text-blue-900">
          <strong>기준:</strong> {workHoursRuleSentence(policy)}
        </div>

        {/* 이동·선택 */}
        <div className="bg-white rounded-2xl border border-gray-100 p-3 sm:p-4 flex flex-wrap items-center gap-2">
          <Link href={prevHref} className={navLink}>
            ← {q.view === "month" ? "이전 달" : "이전 주"}
          </Link>
          <Link href={currentHref} className={navLink}>
            {q.view === "month" ? "이번 달" : "이번 주"}
          </Link>
          <Link href={nextHref} className={navLink}>
            {q.view === "month" ? "다음 달" : "다음 주"} →
          </Link>
          <form action={withBasePath("/work-hours")} method="get" className="flex flex-wrap items-center gap-2 sm:ml-auto">
            <input type="hidden" name="view" value={q.view} />
            {q.view === "month" ? (
              <input
                type="month"
                name="month"
                defaultValue={q.month}
                className="px-3 py-2 border border-gray-200 rounded-xl text-sm"
              />
            ) : (
              <input
                type="date"
                name="date"
                defaultValue={q.date}
                className="px-3 py-2 border border-gray-200 rounded-xl text-sm"
              />
            )}
            {viewer.canViewAll ? (
              <select
                name="department"
                defaultValue={q.department === null ? "all" : String(q.department)}
                className="px-3 py-2 border border-gray-200 rounded-xl text-sm bg-white"
              >
                <option value="all">전체 부서</option>
                {departments.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            ) : null}
            {q.employee !== null && <input type="hidden" name="employee" value={q.employee} />}
            <button type="submit" className="px-4 py-2 text-sm font-semibold text-white bg-blue-500 rounded-xl hover:bg-blue-600">
              조회
            </button>
          </form>
        </div>

        {/* 집계 표 */}
        <div className="bg-white rounded-2xl border border-gray-100 overflow-x-auto">
          {q.view === "month" ? (
            <MonthTable q={q} employees={data.employees} summaries={summaries} />
          ) : (
            <WeekTable q={q} days={days} employees={data.employees} summaries={summaries} />
          )}
        </div>

        {/* 직원 일별 상세 */}
        {detailEmployee && (
          <DetailTable
            q={q}
            employee={detailEmployee}
            days={days}
            summaries={summaries.get(detailEmployee.id) ?? summaryOf(detailEmployee.id)}
            records={data.records.get(detailEmployee.id)}
          />
        )}
      </div>
    </div>
  );
}

function MonthTable({
  q,
  employees,
  summaries,
}: {
  q: Query;
  employees: WorkHoursEmployee[];
  summaries: Map<number, Map<string, DaySummary>>;
}) {
  const weeks = monthWeeks(q.month);
  return (
    <table className="w-full min-w-[720px]">
      <thead className="bg-gray-50">
        <tr>
          <th className={`${th} text-left`}>직원</th>
          <th className={`${th} text-left`}>부서</th>
          {weeks.map((w) => (
            <th key={w.index} className={`${th} text-right`}>
              {w.index}주 ({shortMd(w.start)}~{shortMd(w.end)})
            </th>
          ))}
          <th className={`${th} text-right`}>월 합계</th>
        </tr>
      </thead>
      <tbody>
        {employees.length === 0 && (
          <tr>
            <td colSpan={weeks.length + 3} className={`${td} text-center text-gray-400 py-10`}>
              대상 직원이 없습니다
            </td>
          </tr>
        )}
        {employees.map((e) => {
          const s = summaries.get(e.id)!;
          return (
            <tr key={e.id}>
              <td className={td}>
                <EmployeeName e={e} q={q} />
              </td>
              <td className={`${td} text-gray-500`}>{e.departmentName ?? "-"}</td>
              {weeks.map((w) => (
                <td key={w.index} className={`${td} text-right font-mono`}>
                  {formatPeriodTotal(sumDays(daysInRange(w.start, w.end).map((d) => s.get(d)!)))}
                </td>
              ))}
              <td className={`${td} text-right font-mono font-semibold`}>
                {formatPeriodTotal(sumDays([...s.values()]))}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function WeekTable({
  q,
  days,
  employees,
  summaries,
}: {
  q: Query;
  days: string[];
  employees: WorkHoursEmployee[];
  summaries: Map<number, Map<string, DaySummary>>;
}) {
  return (
    <table className="w-full min-w-[900px]">
      <thead className="bg-gray-50">
        <tr>
          <th className={`${th} text-left`}>직원</th>
          <th className={`${th} text-left`}>부서</th>
          {days.map((d) => (
            <th key={d} className={`${th} text-right`}>
              {WEEKDAY_LABELS[dayOfWeek(d)]} ({shortMd(d)})
            </th>
          ))}
          <th className={`${th} text-right`}>주 합계</th>
        </tr>
      </thead>
      <tbody>
        {employees.length === 0 && (
          <tr>
            <td colSpan={days.length + 3} className={`${td} text-center text-gray-400 py-10`}>
              대상 직원이 없습니다
            </td>
          </tr>
        )}
        {employees.map((e) => {
          const s = summaries.get(e.id)!;
          return (
            <tr key={e.id}>
              <td className={td}>
                <EmployeeName e={e} q={q} />
              </td>
              <td className={`${td} text-gray-500`}>{e.departmentName ?? "-"}</td>
              {days.map((d) => (
                <td key={d} className={`${td} text-right font-mono`}>
                  {formatDayCell(s.get(d)!)}
                </td>
              ))}
              <td className={`${td} text-right font-mono font-semibold`}>
                {formatPeriodTotal(sumDays([...s.values()]))}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function DetailTable({
  q,
  employee,
  days,
  summaries,
  records,
}: {
  q: Query;
  employee: { id: number; name: string; isActive: boolean };
  days: string[];
  summaries: Map<string, DaySummary>;
  records: Map<string, DailyRecordInput> | undefined;
}) {
  const total = sumDays(days.map((d) => summaries.get(d)!));
  return (
    <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 border-b border-gray-100">
        <h2 className="text-base font-bold text-gray-900">
          {employee.name}
          {!employee.isActive && " (퇴사)"} 일별 상세 (직원 번호 {employee.id})
        </h2>
        <Link href={buildHref(q, { employee: null })} className="text-sm text-blue-600 hover:underline">
          상세 닫기
        </Link>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[860px]">
          <thead className="bg-gray-50">
            <tr>
              <th className={`${th} text-left`}>날짜</th>
              <th className={`${th} text-left`}>요일</th>
              <th className={`${th} text-left`}>출근</th>
              <th className={`${th} text-left`}>퇴근</th>
              <th className={`${th} text-left`}>시각 출처</th>
              <th className={`${th} text-right`}>휴게 공제</th>
              <th className={`${th} text-right`}>근무시간</th>
              <th className={`${th} text-left`}>비고</th>
            </tr>
          </thead>
          <tbody>
            {days.map((d) => {
              const s = summaries.get(d)!;
              const r = records?.get(d);
              const ok = s.result?.status === "ok" ? s.result : null;
              return (
                <tr key={d}>
                  <td className={`${td} font-mono`}>{d}</td>
                  <td className={td}>{WEEKDAY_LABELS[dayOfWeek(d)]}</td>
                  <td className={`${td} font-mono`}>{formatTimeOnWorkDate(r?.checkIn ?? null, d)}</td>
                  <td className={`${td} font-mono`}>{formatTimeOnWorkDate(r?.checkOut ?? null, d)}</td>
                  <td className={td}>{s.source}</td>
                  <td className={`${td} text-right font-mono`}>{ok ? formatHM(ok.breakMinutes) : "-"}</td>
                  <td className={`${td} text-right font-mono`}>
                    {ok ? formatHM(ok.workMinutes) : s.result ? "제외" : r ? "0:00" : "-"}
                  </td>
                  <td className={`${td} text-gray-600`}>{s.notes.join(", ") || "-"}</td>
                </tr>
              );
            })}
            <tr className="bg-gray-50">
              <td className={`${td} font-semibold`} colSpan={6}>
                합계
              </td>
              <td className={`${td} text-right font-mono font-semibold`}>{formatHM(total.minutes)}</td>
              <td className={`${td} text-gray-600`}>
                {[
                  total.noCheckoutDays ? `퇴근 없음 ${total.noCheckoutDays}일 제외` : "",
                  total.invalidDays ? `기록 오류 ${total.invalidDays}일 제외` : "",
                ]
                  .filter(Boolean)
                  .join(", ") || "-"}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

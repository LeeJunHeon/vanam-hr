import { NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { prisma } from "@/lib/prisma";
import { createNotifications } from "@/lib/notify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/internal/sweep-trip-reports — 출장보고서 미제출 리마인더 스윕.
// 출장/외근 종료 후 영업일(주말·hr.holidays 제외) 3일이 지나고 4번째 영업일부터,
// 제출 전까지 매 영업일 1회 본인에게 알림. draft(작성중)도 미제출로 취급.
// 머신-투-머신(내부 시스템 전용). 인증: Authorization: Bearer <INTERNAL_API_TOKEN>.
// 하루 1회 실행 보장은 호출자(aggregator 날짜 게이트) 책임.

function safeStringEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

// 서버는 UTC 컨테이너 — 오늘 날짜는 KST로 확정한다.
function todayKst(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

// YYYY-MM-DD → epoch 일수 (UTC 고정 — 타임존 무관 순수 날짜 연산)
function ymdToDays(ymd: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return null;
  return Math.floor(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000);
}
function daysToYmd(days: number): string {
  return new Date(days * 86400000).toISOString().slice(0, 10);
}
// epoch 일수 → ISO 요일 (월=1 … 일=7). 1970-01-01=목요일.
function isoWeekdayOf(days: number): number {
  return ((days + 3) % 7) + 1;
}
function ymdOf(d: Date): string {
  return d.toISOString().split("T")[0];
}

/** 알림이 필요한 최소 영업일 경과 수 — 종료 후 3영업일이 지난 4번째 영업일부터 */
const NOTIFY_AFTER_BUSINESS_DAYS = 4;

export async function POST(request: Request) {
  const expected = process.env.INTERNAL_API_TOKEN;
  if (!expected || expected.length === 0) {
    return NextResponse.json({ error: "내부 토큰 미설정" }, { status: 500 });
  }
  const authHeader = request.headers.get("authorization") ?? "";
  const m = authHeader.match(/^Bearer\s+(.+)$/i);
  const token = m?.[1]?.trim() ?? "";
  if (!token || !safeStringEqual(token, expected)) {
    return NextResponse.json({ error: "인증 실패" }, { status: 401 });
  }

  try {
    const today = todayKst();
    const todayDays = ymdToDays(today);
    if (todayDays == null) {
      return NextResponse.json({ error: "오늘 날짜 계산 실패" }, { status: 500 });
    }

    // (a) 오늘이 영업일이 아니면 아무것도 하지 않는다
    const todayWeekday = isoWeekdayOf(todayDays);
    if (todayWeekday >= 6) {
      return NextResponse.json({ skipped: "non_business_day" });
    }
    const todayHoliday = await prisma.holiday.findUnique({
      where: { holidayDate: new Date(today) },
      select: { holidayDate: true },
    });
    if (todayHoliday) {
      return NextResponse.json({ skipped: "non_business_day" });
    }

    // (b) 소급 알림 방지 기준일
    const policy = await prisma.policySetting.findUnique({
      where: { key: "trip_report_required_from" },
      select: { value: true },
    });
    const requiredFrom = policy?.value?.trim() ?? "";
    const requiredFromDays = ymdToDays(requiredFrom);
    if (requiredFromDays == null) {
      return NextResponse.json({ skipped: "no_policy" });
    }

    // (c) 대상 조회 — my-trips / overview와 동일한 두 소스·동일 상태 조건.
    //     여기에 "종료됨 + 기준일 이후 + 미제출"을 추가한다.
    const requiredFromDate = new Date(requiredFrom);
    const todayDate = new Date(today);
    // 보고서 없음(is: null) 또는 있으나 제출 전(draft) — 관계 필터에 필드를 걸면
    // 관계가 NULL인 행은 매칭되지 않으므로 두 갈래를 OR로 묶는다.
    const notSubmitted = [
      { report: { is: null } },
      { report: { status: { not: "submitted" } } },
    ];

    const [participants, requests] = await Promise.all([
      prisma.tripParticipant.findMany({
        where: {
          inviteStatus: "accepted",
          approvalStatus: { in: ["approved", "not_required"] },
          tripEvent: {
            endDate: { lt: todayDate, gte: requiredFromDate },
          },
          OR: notSubmitted,
        },
        select: {
          id: true,
          employeeId: true,
          tripEvent: { select: { name: true, endDate: true } },
          report: { select: { status: true } },
        },
      }),
      prisma.attendanceRequest.findMany({
        where: {
          category: { code: { in: ["BUSINESS_TRIP", "EXTERNAL_WORK"] } },
          OR: [{ externalSource: null }, { externalSource: { not: "trip" } }],
          status: { in: ["approved", "auto_approved"] },
          endDate: { lt: todayDate, gte: requiredFromDate },
          AND: [
            {
              OR: [
                { tripReport: { is: null } },
                { tripReport: { status: { not: "submitted" } } },
              ],
            },
          ],
        },
        select: {
          id: true,
          employeeId: true,
          endDate: true,
          reason: true,
          category: { select: { name: true } },
          tripReport: { select: { status: true } },
        },
      }),
    ]);

    // 두 소스를 (직원, 제목, 종료일) 형태로 통일
    const candidates: { employeeId: number; title: string; endYmd: string }[] = [
      ...participants
        .filter((p) => p.tripEvent)
        .map((p) => ({
          employeeId: p.employeeId,
          title: p.tripEvent!.name,
          endYmd: ymdOf(p.tripEvent!.endDate),
        })),
      ...requests.map((r) => {
        const reason = (r.reason ?? "").trim();
        const base = r.category?.name ?? "출장/외근";
        return {
          employeeId: r.employeeId,
          title: reason ? `${base} · ${reason.slice(0, 40)}` : base,
          endYmd: ymdOf(r.endDate),
        };
      }),
    ];

    if (candidates.length === 0) {
      return NextResponse.json({ checked: 0, notified: 0 });
    }

    // (d) 영업일 경과 계산 — 최소 endDate부터 오늘까지의 공휴일을 한 번에 로드
    const minEndYmd = candidates.reduce(
      (min, c) => (c.endYmd < min ? c.endYmd : min),
      candidates[0].endYmd
    );
    const holidayRows = await prisma.holiday.findMany({
      where: { holidayDate: { gte: new Date(minEndYmd), lte: todayDate } },
      select: { holidayDate: true },
    });
    const holidaySet = new Set(holidayRows.map((h) => ymdOf(h.holidayDate)));

    // (endDate, 오늘] 구간의 영업일 수
    const businessDaysSince = (endYmd: string): number => {
      const endDays = ymdToDays(endYmd);
      if (endDays == null) return 0;
      let count = 0;
      for (let d = endDays + 1; d <= todayDays; d++) {
        if (isoWeekdayOf(d) >= 6) continue;
        if (holidaySet.has(daysToYmd(d))) continue;
        count++;
      }
      return count;
    };

    const due = candidates.filter(
      (c) => businessDaysSince(c.endYmd) >= NOTIFY_AFTER_BUSINESS_DAYS
    );

    // (e) 직원별로 묶어 하루 1건만 발송
    const byEmployee = new Map<number, string[]>();
    for (const c of due) {
      const list = byEmployee.get(c.employeeId) ?? [];
      list.push(c.title);
      byEmployee.set(c.employeeId, list);
    }

    let notified = 0;
    for (const [employeeId, titles] of byEmployee) {
      const body =
        titles.length === 1
          ? `『${titles[0]}』 출장보고서가 아직 제출되지 않았습니다.`
          : `미제출 출장보고서가 ${titles.length}건 있습니다: 『${titles[0]}』 외 ${
              titles.length - 1
            }건`;
      await createNotifications({
        employeeIds: [employeeId],
        type: "trip_report",
        title: "출장보고서 미제출 알림",
        body,
        linkPage: "my-trips",
      });
      notified++;
    }

    return NextResponse.json({ checked: due.length, notified });
  } catch (error) {
    console.error("POST /api/internal/sweep-trip-reports error:", error);
    return NextResponse.json(
      { error: "출장보고서 리마인더 스윕 실패" },
      { status: 500 }
    );
  }
}

import { prisma } from "@/lib/prisma";

// 근태 화면 공용 "행 조립" 모듈 (리팩터링 1단계).
// overview API의 조립 로직을 그대로 이동한 것 — 동작 동일. (이후 단계에서 calendar/realtime도 이 모듈로 전환 예정)
export interface AssembleEmployee {
  id: number;
  employeeNo: string | null;
  name: string;
  departmentName: string | null;
  positionName: string | null;
}

export type AttendanceRow = {
  employeeId: number;
  employeeNo: string;
  name: string;
  departmentName: string | null;
  positionName: string | null;
  workDate: string;
  checkIn: string | null;
  checkOut: string | null;
  wifiCheckIn: string | null;
  wifiCheckOut: string | null;
  workMinutes: number | null;
  autoStatus: string | null;
  // 지각/조퇴 독립 플래그 (aggregator가 채움). NULL = 미판정(플래그 도입 전 과거 행).
  isLate: boolean | null;
  isEarlyLeave: boolean | null;
  isOverridden: boolean;
  categoryId: number | null;
  categoryCode: string | null;
  categoryName: string | null;
  categoryColor: string | null;
  reason: string | null;
  correctedCheckIn: string | null;
  correctedCheckOut: string | null;
  reqCategoryCode: string | null;
  reqCategoryName: string | null;
  // 같은 날 시간형 일정이 여러 건일 때의 집계 (1건 이하면 timedCount<=1이라 소비처가
  // 기존 경로를 그대로 탄다). 시간형이 0건이면 count=0 + 나머지 null.
  timedCount: number; // 그 날 시간형 요청 건수 (0/1/N)
  timedSpanIn: string | null; // 전체 최소 시작 ISO
  timedSpanOut: string | null; // 전체 최대 종료 ISO
  timedAll: { in: string; out: string; reason: string }[] | null; // 엑셀용 전 건 (시작 오름차순)
  // 2단계 additive — 일별 모달용 (overview 응답에도 실리지만 30일 모달은 읽지 않아 무해)
  dailyId: number;
  originalCheckIn: string | null;
  originalCheckOut: string | null;
  note: string | null;
  statusReason: string | null;
};

// 시간형 집계 → 반환 필드 4개. 정렬은 호출 전에 끝나 있다(시작 오름차순).
// span_out은 "마지막 요소의 out"이 아니라 전체 out의 최댓값이다 —
// 정렬 기준이 시작 시각이라 늦게 시작한 건이 더 일찍 끝날 수 있다.
function timedFields(list: { in: string; out: string; reason: string }[] | undefined): {
  timedCount: number;
  timedSpanIn: string | null;
  timedSpanOut: string | null;
  timedAll: { in: string; out: string; reason: string }[] | null;
} {
  if (!list || list.length === 0) {
    return {
      timedCount: 0,
      timedSpanIn: null,
      timedSpanOut: null,
      timedAll: null,
    };
  }
  let maxOut = list[0].out;
  for (const e of list) {
    if (Date.parse(e.out) > Date.parse(maxOut)) maxOut = e.out;
  }
  return {
    timedCount: list.length,
    timedSpanIn: list[0].in,
    timedSpanOut: maxOut,
    timedAll: list,
  };
}

export async function assembleAttendanceRows(params: {
  employees: AssembleEmployee[];
  startDate: string; // "YYYY-MM-DD"
  endDate: string; // "YYYY-MM-DD"
}): Promise<AttendanceRow[]> {
  const { employees, startDate, endDate } = params;
  const employeeIds = employees.map((e) => e.id);

  const attendance =
    employeeIds.length > 0
      ? await prisma.attendanceDaily.findMany({
          where: {
            employeeId: { in: employeeIds },
            workDate: {
              gte: new Date(startDate),
              lte: new Date(endDate),
            },
          },
          select: {
            id: true,
            employeeId: true,
            workDate: true,
            checkIn: true,
            checkOut: true,
            originalCheckIn: true,
            originalCheckOut: true,
            workMinutes: true,
            autoStatus: true,
            isLate: true,
            isEarlyLeave: true,
            isOverridden: true,
            categoryId: true,
            note: true,
            statusReason: true,
            category: {
              select: {
                code: true,
                name: true,
                displayColor: true,
              },
            },
          },
          orderBy: [{ workDate: "desc" }, { employeeId: "asc" }],
        })
      : [];

  // 캘린더 자동 등록 사유 조회 (calendar_auto + auto_approved + google_calendar)
  // start_date~end_date 범위가 조회 기간과 겹치는 모든 요청 가져옴
  const requests =
    employeeIds.length > 0
      ? await prisma.attendanceRequest.findMany({
          where: {
            employeeId: { in: employeeIds },
            status: { in: ["approved", "auto_approved", "auto_delegated"] },
            startDate: { lte: new Date(endDate) },
            endDate: { gte: new Date(startDate) },
          },
          select: {
            employeeId: true,
            startDate: true,
            endDate: true,
            reason: true,
            correctedCheckIn: true,
            correctedCheckOut: true,
            requestedAt: true,
            category: { select: { code: true, name: true } },
          },
          orderBy: { requestedAt: "asc" },
        })
      : [];

  // employeeId_YYYY-MM-DD → reason 매핑 (start~end 범위 모든 날짜에 동일 reason)
  // 그리고 같은 키 형식으로 corrected_check_in/out 시간대도 매핑(시간대 일정만 값 존재).
  // employeeId_YYYY-MM-DD → 대표 요청. 같은 날 여러 건이면 시간형(시작 늦은 순) 우선,
  // 시간형이 없으면 종일. requests는 requestedAt asc 정렬되어 있음.
  // 대표를 '마지막 건'으로 잡는 이유: 화면 비고는 [전체 범위 + 건수 + 대표 제목] 형태라
  // 하루가 끝날 때의 일정이 대표 제목으로 더 자연스럽다.
  const reasonMap = new Map<string, string>();
  const correctedMap = new Map<
    string,
    { in: string | null; out: string | null }
  >();
  // 대표 선택용: 키별로 현재 채택된 요청의 "우선순위 점수"와 시작시각 보관
  const pickMeta = new Map<string, { timed: boolean; startMs: number }>();
  const reqCategoryMap = new Map<
    string,
    { code: string | null; name: string | null }
  >();
  // 키별 시간형 전 건 (대표와 별개로 전부 모은다 — 화면 건수/범위, 엑셀 나열용)
  const timedAgg = new Map<
    string,
    { in: string; out: string; reason: string }[]
  >();

  for (const req of requests) {
    const isTimed = !!(req.correctedCheckIn && req.correctedCheckOut);
    const startMs = req.correctedCheckIn
      ? req.correctedCheckIn.getTime()
      : Number.POSITIVE_INFINITY;
    const start = new Date(req.startDate);
    const end = new Date(req.endDate);
    const d = new Date(start);
    while (d <= end) {
      const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(
        2,
        "0"
      )}-${String(d.getDate()).padStart(2, "0")}`;
      const key = `${req.employeeId}_${ymd}`;

      // 시간형은 대표 선택과 별개로 전부 모은다.
      if (isTimed) {
        const list = timedAgg.get(key);
        const entry = {
          in: req.correctedCheckIn!.toISOString(),
          out: req.correctedCheckOut!.toISOString(),
          reason: req.reason ?? "",
        };
        if (list) list.push(entry);
        else timedAgg.set(key, [entry]);
      }

      const prev = pickMeta.get(key);
      // 채택 규칙: 시간형이 종일보다 우선, 시간형끼리는 시작 늦은 것 우선.
      let take = false;
      if (!prev) {
        take = true;
      } else if (isTimed && !prev.timed) {
        take = true; // 종일 → 시간형으로 교체
      } else if (isTimed && prev.timed && startMs > prev.startMs) {
        take = true; // 더 늦게 시작하는 시간형 (대표 제목 = 마지막 일정)
      }

      if (take) {
        pickMeta.set(key, { timed: isTimed, startMs });
        reasonMap.set(key, req.reason ?? "");
        correctedMap.set(key, {
          in: req.correctedCheckIn
            ? req.correctedCheckIn.toISOString()
            : null,
          out: req.correctedCheckOut
            ? req.correctedCheckOut.toISOString()
            : null,
        });
        reqCategoryMap.set(key, {
          code: req.category?.code ?? null,
          name: req.category?.name ?? null,
        });
      }
      d.setDate(d.getDate() + 1);
    }
  }

  // 시간형 집계는 시작 오름차순으로 정렬해 둔다 (엑셀 나열 순서 = 시간순).
  for (const list of timedAgg.values()) {
    list.sort((a, b) => Date.parse(a.in) - Date.parse(b.in));
  }

  // ── 오늘(KST) WiFi 첫 연결 / 마지막 끊김 ──
  const _nowKst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const _ky = _nowKst.getUTCFullYear();
  const _km = _nowKst.getUTCMonth();
  const _kd = _nowKst.getUTCDate();
  const _pad = (n: number) => String(n).padStart(2, "0");
  const todayYmdKst = `${_ky}-${_pad(_km + 1)}-${_pad(_kd)}`;
  const todayStartUtc = new Date(Date.UTC(_ky, _km, _kd) - 9 * 60 * 60 * 1000);
  const todayEndUtc = new Date(todayStartUtc.getTime() + 24 * 60 * 60 * 1000);

  const firstOnlineMap = new Map<number, Date>();
  const lastOnlineMap = new Map<number, Date>();
  const lastOfflineMap = new Map<number, Date>();
  if (employeeIds.length > 0) {
    const [firstOnline, lastOffline] = await Promise.all([
      prisma.presenceRaw.groupBy({
        by: ["employeeId"],
        where: {
          employeeId: { in: employeeIds },
          status: "online",
          checkedAt: { gte: todayStartUtc, lt: todayEndUtc },
        },
        _min: { checkedAt: true },
        _max: { checkedAt: true },
      }),
      prisma.presenceRaw.groupBy({
        by: ["employeeId"],
        where: {
          employeeId: { in: employeeIds },
          status: "offline",
          checkedAt: { gte: todayStartUtc, lt: todayEndUtc },
        },
        _max: { checkedAt: true },
      }),
    ]);
    for (const row of firstOnline) {
      if (row.employeeId != null && row._min.checkedAt) {
        firstOnlineMap.set(row.employeeId, row._min.checkedAt);
      }
      if (row.employeeId != null && row._max.checkedAt) {
        lastOnlineMap.set(row.employeeId, row._max.checkedAt);
      }
    }
    for (const row of lastOffline) {
      if (row.employeeId != null && row._max.checkedAt) {
        lastOfflineMap.set(row.employeeId, row._max.checkedAt);
      }
    }
  }

  // 마지막 끊김이 마지막 연결보다 나중일 때만 "퇴근"으로 인정 (재연결 시 제외)
  const wifiOutMap = new Map<number, Date>();
  for (const [empId, lastOff] of lastOfflineMap) {
    const lastOn = lastOnlineMap.get(empId);
    if (!lastOn || lastOff > lastOn) {
      wifiOutMap.set(empId, lastOff);
    }
  }

  // employees + attendance 조인
  const empMap = new Map(employees.map((e) => [e.id, e]));
  const rows = attendance.map((a) => {
    const emp = empMap.get(a.employeeId);
    const ymd = a.workDate.toISOString().split("T")[0];
    const reasonKey = `${a.employeeId}_${ymd}`;
    return {
      employeeId: a.employeeId,
      employeeNo: emp?.employeeNo ?? "",
      name: emp?.name ?? "",
      departmentName: emp?.departmentName ?? null,
      positionName: emp?.positionName ?? null,
      workDate: ymd,
      checkIn: a.checkIn ? a.checkIn.toISOString() : null,
      checkOut: a.checkOut ? a.checkOut.toISOString() : null,
      wifiCheckIn: ymd === todayYmdKst ? (firstOnlineMap.get(a.employeeId)?.toISOString() ?? null) : null,
      wifiCheckOut: ymd === todayYmdKst ? (wifiOutMap.get(a.employeeId)?.toISOString() ?? null) : null,
      workMinutes: a.workMinutes ?? null,
      autoStatus: a.autoStatus ?? null,
      isLate: a.isLate ?? null,
      isEarlyLeave: a.isEarlyLeave ?? null,
      isOverridden: a.isOverridden,
      categoryId: a.categoryId ?? null,
      categoryCode: a.category?.code ?? null,
      categoryName: a.category?.name ?? null,
      categoryColor: a.category?.displayColor ?? null,
      reason: reasonMap.get(reasonKey) ?? null,
      correctedCheckIn: correctedMap.get(reasonKey)?.in ?? null,
      correctedCheckOut: correctedMap.get(reasonKey)?.out ?? null,
      reqCategoryCode: reqCategoryMap.get(reasonKey)?.code ?? null,
      reqCategoryName: reqCategoryMap.get(reasonKey)?.name ?? null,
      ...timedFields(timedAgg.get(reasonKey)),
      dailyId: a.id,
      originalCheckIn: a.originalCheckIn ? a.originalCheckIn.toISOString() : null,
      originalCheckOut: a.originalCheckOut ? a.originalCheckOut.toISOString() : null,
      note: a.note ?? null,
      statusReason: a.statusReason ?? null,
    };
  });

  return rows;
}

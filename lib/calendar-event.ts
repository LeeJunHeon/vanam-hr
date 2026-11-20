// 근태 신청 승인 시 구글 캘린더 이벤트 생성 (calendar-syncer POST 호출).
// approvals/route.ts(결재 승인)와 create-attendance-request.ts(자동승인)가
// 둘 다 이 함수를 쓴다. 성공 시 event_id 반환. 실패 시 throw(호출자가 try/catch).
export interface CreateEventParams {
  calendarId: string;
  summary: string;
  description: string;
  startDate: Date;
  endDate: Date;
  correctedCheckIn: Date | null;
  correctedCheckOut: Date | null;
}

export async function createCalendarEvent(
  p: CreateEventParams
): Promise<string | null> {
  const base = process.env.CALENDAR_SYNCER_URL;
  if (!base) throw new Error("CALENDAR_SYNCER_URL env not set");

  // 종일 vs 시간 지정 판단
  // Phase 6-2G: 한쪽만 있어도 종일로 안전 처리 (런타임 에러 방지 — null!.toISOString() 방지)
  const isAllDay = !p.correctedCheckIn || !p.correctedCheckOut;

  let startObj: Record<string, string>;
  let endObj: Record<string, string>;
  if (isAllDay) {
    // 종일: start.date, end.date (Google API exclusive end → +1일)
    const sYmd = p.startDate.toISOString().split("T")[0];
    const eDate = new Date(p.endDate);
    eDate.setUTCDate(eDate.getUTCDate() + 1);
    const eYmd = eDate.toISOString().split("T")[0];
    startObj = { date: sYmd };
    endObj = { date: eYmd };
  } else {
    // 시간 지정: dateTime + timeZone (KST)
    startObj = {
      dateTime: p.correctedCheckIn!.toISOString(),
      timeZone: "Asia/Seoul",
    };
    endObj = {
      dateTime: p.correctedCheckOut!.toISOString(),
      timeZone: "Asia/Seoul",
    };
  }

  const url = `${base}/internal/calendar-event`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Internal-Token": process.env.INTERNAL_API_TOKEN ?? "",
    },
    body: JSON.stringify({
      calendar_id: p.calendarId,
      vanam_source: "hr",
      summary: p.summary,
      description: p.description,
      start: startObj,
      end: endObj,
    }),
  });
  if (!res.ok) {
    throw new Error(`calendar-syncer POST failed: ${res.status}`);
  }
  const data = await res.json();
  return data.eventId ?? data.event_id ?? data.id ?? null;
}

// 일정 시각만 수정 (calendar-syncer PATCH /internal/calendar-event/<eventId>) — 관리자 반차 시각 수정(retime)이 쓴다.
// 제목·설명·참석자는 건드리지 않고 start/end(dateTime, Asia/Seoul)만 보낸다.
// 반환: "updated" | "not_found"(syncer 404 — 일정이 지워졌거나 다른 캘린더). 그 밖의 실패는 throw.
export function buildEventTimePatchBody(
  calendarId: string,
  start: Date,
  end: Date
): {
  calendar_id: string;
  start: { dateTime: string; timeZone: string };
  end: { dateTime: string; timeZone: string };
} {
  return {
    calendar_id: calendarId,
    start: { dateTime: start.toISOString(), timeZone: "Asia/Seoul" },
    end: { dateTime: end.toISOString(), timeZone: "Asia/Seoul" },
  };
}

export async function updateCalendarEventTime(
  calendarId: string,
  eventId: string,
  start: Date,
  end: Date
): Promise<"updated" | "not_found"> {
  const base = process.env.CALENDAR_SYNCER_URL;
  if (!base) throw new Error("CALENDAR_SYNCER_URL env not set");
  const res = await fetch(`${base}/internal/calendar-event/${encodeURIComponent(eventId)}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      "X-Internal-Token": process.env.INTERNAL_API_TOKEN ?? "",
    },
    body: JSON.stringify(buildEventTimePatchBody(calendarId, start, end)),
  });
  if (res.status === 404) return "not_found";
  if (!res.ok) throw new Error(`calendar-syncer PATCH failed: ${res.status}`);
  return "updated";
}

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

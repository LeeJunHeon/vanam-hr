// 그룹 출장(Field Trip) API 공용 헬퍼.
// Phase 7 2단계 — 참석자 관리 라우트들이 공유.

// YYYY-MM-DD → UTC midnight Date. 잘못된 형식이면 null.
export function parseYmd(s: unknown): Date | null {
  if (typeof s !== "string") return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(s + "T00:00:00.000Z");
  return isNaN(d.getTime()) ? null : d;
}

// "HH:MM" → @db.Time(6) 저장용 Date (UTC 1970-01-01 기준).
// 잘못된 형식이면 null. 빈 문자열/undefined/null도 null.
export function parseHhmm(s: unknown): Date | null {
  if (s == null || s === "") return null;
  if (typeof s !== "string") return null;
  if (!/^\d{2}:\d{2}$/.test(s)) return null;
  const [hh, mm] = s.split(":").map(Number);
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  return new Date(Date.UTC(1970, 0, 1, hh, mm, 0));
}

// 참석자 요청 본문의 dates 배열 항목 1개 검증/정규화 결과.
export interface ParsedDate {
  attendDate: Date;
  startTime: Date | null;
  endTime: Date | null;
}

// dates 배열 → ParsedDate[] 또는 에러 문자열.
// - 모든 attendDate는 [eventStart, eventEnd] 이내여야 함.
// - startTime/endTime 둘 다 있으면 start < end.
// - 항목 1개라도 검증 실패 시 즉시 에러 반환.
export function parseDatesArray(
  raw: unknown,
  eventStart: Date,
  eventEnd: Date
): { ok: true; dates: ParsedDate[] } | { ok: false; error: string } {
  if (!Array.isArray(raw)) {
    return { ok: false, error: "dates는 배열이어야 합니다." };
  }
  const out: ParsedDate[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== "object") {
      return { ok: false, error: "dates 항목 형식 오류" };
    }
    const r = item as Record<string, unknown>;
    const d = parseYmd(r.attendDate);
    if (!d) {
      return {
        ok: false,
        error: "attendDate 형식이 잘못되었습니다 (YYYY-MM-DD).",
      };
    }
    if (d.getTime() < eventStart.getTime() || d.getTime() > eventEnd.getTime()) {
      return {
        ok: false,
        error: "attendDate가 이벤트 기간(start~end)을 벗어났습니다.",
      };
    }
    const ymd = d.toISOString().split("T")[0];
    if (seen.has(ymd)) {
      return { ok: false, error: `중복 attendDate: ${ymd}` };
    }
    seen.add(ymd);

    // 시간은 선택. 빈/누락이면 종일(NULL).
    const startTime =
      r.startTime !== undefined && r.startTime !== null && r.startTime !== ""
        ? parseHhmm(r.startTime)
        : null;
    if (r.startTime !== undefined && r.startTime !== null && r.startTime !== "" && startTime === null) {
      return { ok: false, error: "startTime 형식이 잘못되었습니다 (HH:MM)." };
    }
    const endTime =
      r.endTime !== undefined && r.endTime !== null && r.endTime !== ""
        ? parseHhmm(r.endTime)
        : null;
    if (r.endTime !== undefined && r.endTime !== null && r.endTime !== "" && endTime === null) {
      return { ok: false, error: "endTime 형식이 잘못되었습니다 (HH:MM)." };
    }
    if (startTime && endTime && startTime.getTime() >= endTime.getTime()) {
      return {
        ok: false,
        error: "startTime은 endTime보다 빨라야 합니다.",
      };
    }

    out.push({ attendDate: d, startTime, endTime });
  }
  return { ok: true, dates: out };
}

// 참석자 추가 시 approval_status 자동 결정 규칙(스펙 §2):
// - admin/ceo가 개입한 참석(타인 초대 or 본인 self-join) → "not_required"
// - employee가 참석 → "pending"
export function computeApprovalStatus(
  requesterRole: string | undefined | null
): "not_required" | "pending" {
  if (requesterRole === "admin" || requesterRole === "ceo") return "not_required";
  return "pending";
}

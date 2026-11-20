"use client";

import { useEffect, useState } from "react";
import { Clock, Loader2, X } from "lucide-react";
import TimePicker from "@/components/TimePicker";
import { formatTime } from "@/lib/attendanceLabels";
import { halfDayHint, type HalfDayInfo } from "@/lib/half-day";

// 관리자 — 승인된 반차 등 시간형 휴가 신청의 시각 수정 모달 (직원 상세 모달 위, z-[60]).
// 저장: PUT /api/attendance-requests?id=N { action: "retime", correctedCheckIn: "HH:MM", correctedCheckOut: "HH:MM" }
//   → 서버가 근태 재계산 표시·구글 캘린더 시각 수정·신청자 알림까지 한다(lib/attendance-request-retime).
// 시각이 같아도 저장하면 캘린더만 다시 맞춘다("캘린더 다시 반영").
// 안내: 그 직원 그날 시프트·반차 경계 — GET /api/my-shift/half-day?employeeId=&date=

export interface RetimeTarget {
  id: number;
  categoryName: string;
  /** YYYY-MM-DD */
  date: string;
  /** ISO */
  correctedCheckIn: string;
  correctedCheckOut: string;
}

type CalendarResult = "updated" | "failed" | "not_found" | "none";

/** 저장 결과 토스트 문구 */
export function retimeToastText(changed: boolean, calendar: CalendarResult): string {
  const head = changed ? "저장됨" : "시각 변경 없음";
  switch (calendar) {
    case "updated":
      return `${head} · 캘린더 반영됨`;
    case "failed":
      return `${head} · 캘린더 반영 실패 — 관리자 확인 필요`;
    case "not_found":
      return `${head} · 캘린더 일정을 찾지 못함 — 관리자 확인 필요`;
    case "none":
      return `${head} · 캘린더 일정 없음`;
  }
}

export default function RequestRetimeModal({
  target,
  employeeId,
  employeeName,
  onClose,
  onSaved,
}: {
  target: RetimeTarget;
  employeeId: number;
  employeeName: string;
  onClose: () => void;
  /** 저장 성공 — 토스트 문구 */
  onSaved: (message: string) => void;
}) {
  const [checkIn, setCheckIn] = useState(formatTime(target.correctedCheckIn));
  const [checkOut, setCheckOut] = useState(formatTime(target.correctedCheckOut));
  const [info, setInfo] = useState<HalfDayInfo | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/my-shift/half-day?date=${target.date}&employeeId=${employeeId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j: HalfDayInfo | null) => {
        if (!cancelled) setInfo(j);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [target.date, employeeId]);

  const handleSave = async () => {
    setError("");
    if (!checkIn || !checkOut) {
      setError("시작·종료 시각을 모두 입력하세요.");
      return;
    }
    if (checkOut <= checkIn) {
      setError("종료 시각은 시작 시각보다 늦어야 합니다.");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`/api/attendance-requests?id=${target.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "retime", correctedCheckIn: checkIn, correctedCheckOut: checkOut }),
      });
      const j = await res.json().catch(() => null);
      if (!res.ok) {
        setError(j?.error || `저장 실패 (${res.status})`);
        return;
      }
      onSaved(retimeToastText(!!j?.changed, (j?.calendar ?? "none") as CalendarResult));
    } catch {
      setError("네트워크 오류");
    } finally {
      setSaving(false);
    }
  };

  const before = `${formatTime(target.correctedCheckIn)}~${formatTime(target.correctedCheckOut)}`;
  const same = checkIn === formatTime(target.correctedCheckIn) && checkOut === formatTime(target.correctedCheckOut);

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-[60] p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md" onClick={(e) => e.stopPropagation()}>
        {/* 헤더 */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-100">
          <h3 className="font-bold text-gray-900 text-base flex items-center gap-2">
            <Clock size={16} className="text-blue-600" />
            반차 시각 수정
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded-lg text-gray-400 hover:bg-gray-100 hover:text-gray-600"
            aria-label="닫기"
          >
            <X size={18} />
          </button>
        </div>

        <div className="p-5 space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <p className="text-xs font-semibold text-gray-500 mb-1.5">직원 · 카테고리</p>
              <p className="px-3 py-2 text-sm bg-gray-50 rounded-lg text-gray-800 truncate">
                {employeeName} · {target.categoryName}
              </p>
            </div>
            <div>
              <p className="text-xs font-semibold text-gray-500 mb-1.5">날짜</p>
              <p className="px-3 py-2 text-sm bg-gray-50 rounded-lg text-gray-800 font-mono">{target.date}</p>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <p className="text-xs font-semibold text-gray-500 mb-1.5">시작</p>
              <TimePicker value={checkIn} onChange={setCheckIn} minuteStep={5} placeholder="HH:MM" />
            </div>
            <div>
              <p className="text-xs font-semibold text-gray-500 mb-1.5">종료</p>
              <TimePicker value={checkOut} onChange={setCheckOut} minuteStep={5} placeholder="HH:MM" />
            </div>
          </div>

          <div className="text-[11px] text-gray-400 space-y-0.5">
            <p>현재 {before}</p>
            {info && <p>{halfDayHint(info, "직원")}</p>}
            <p>
              저장하면 근태(지난 날짜는 재계산)·구글 캘린더 일정·직원 알림에 반영됩니다.
              {same && " 시각이 같으면 캘린더만 다시 맞춥니다."}
            </p>
          </div>

          {error && <div className="text-xs text-rose-600 bg-rose-50 rounded-lg px-3 py-2">{error}</div>}
        </div>

        {/* 푸터 */}
        <div className="px-5 py-3 border-t border-gray-100 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg"
          >
            취소
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-semibold text-white bg-blue-500 rounded-lg hover:bg-blue-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {saving && <Loader2 size={15} className="animate-spin" />}
            {saving ? "저장 중" : same ? "캘린더 다시 반영" : "저장"}
          </button>
        </div>
      </div>
    </div>
  );
}

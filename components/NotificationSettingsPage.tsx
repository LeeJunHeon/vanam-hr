"use client";

import { useState, useEffect, useCallback } from "react";
import { Loader2, Bell } from "lucide-react";

// 알림 종류 정의 (정책 키 prefix ↔ 라벨). DB의 33개 키와 1:1 (앱/이메일/푸시).
const NOTIFY_TYPES: { type: string; label: string; desc: string; channels: ("app" | "email" | "push")[] }[] = [
  { type: "approval_request", label: "새 결재 요청", desc: "휴가/근태 신청 시 결재자에게", channels: ["app", "email", "push"] },
  { type: "trip_request", label: "새 외근 결재 요청", desc: "외근 참여(결재 필요) 시 부서 결재자에게", channels: ["app", "email", "push"] },
  { type: "trip_invite", label: "외근 초대", desc: "외근에 초대받은 사람에게", channels: ["app", "email", "push"] },
  { type: "approval_result", label: "결재 결과", desc: "승인/반려 시 신청자에게", channels: ["app", "email", "push"] },
  { type: "trip_result", label: "외근 결재 결과", desc: "외근 승인/반려 시 참석자에게", channels: ["app", "email", "push"] },
  { type: "trip_decline", label: "외근 초대 거절", desc: "초대 거절 시 주최자에게", channels: ["app", "email", "push"] },
  { type: "trip_remove", label: "외근 참석자 제외", desc: "참석자에서 제외 시 대상에게", channels: ["app", "email", "push"] },
  { type: "cancel", label: "결재 취소", desc: "승인된 신청 취소 시 결재자에게", channels: ["app", "email", "push"] },
  { type: "disconnect", label: "근무중 WiFi 끊김", desc: "근무 시간 중 WiFi가 끊긴 본인에게", channels: ["app", "email", "push"] },
  { type: "no_show", label: "당일 출근 미감지", desc: "출근 예정 시각까지 WiFi 미감지 시 본인에게", channels: ["app", "email", "push"] },
  { type: "attendance_alert", label: "근태 확인 요청", desc: "결근/지각/조퇴 기록 시 본인에게", channels: ["app", "email", "push"] },
];

type FlagMap = Record<string, boolean>; // key(notify_xxx_app) → bool

export default function NotificationSettingsPage() {
  const [flags, setFlags] = useState<FlagMap>({});
  const [loading, setLoading] = useState(true);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [toast, setToast] = useState("");

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(""), 2000);
  };

  const fetchFlags = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/policies?search=notify_");
      if (res.ok) {
        const data: { key: string; value: string }[] = await res.json();
        const map: FlagMap = {};
        for (const p of data) {
          if (p.key.startsWith("notify_")) {
            map[p.key] = p.value === "true";
          }
        }
        setFlags(map);
      }
    } catch (e) {
      console.error("notify flags fetch error:", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchFlags();
  }, [fetchFlags]);

  const toggle = async (key: string, next: boolean) => {
    setSavingKey(key);
    // 낙관적 업데이트
    setFlags((prev) => ({ ...prev, [key]: next }));
    try {
      const res = await fetch(`/api/policies?key=${encodeURIComponent(key)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: next ? "true" : "false" }),
      });
      if (!res.ok) {
        // 실패 시 롤백
        setFlags((prev) => ({ ...prev, [key]: !next }));
        showToast("저장 실패");
      } else {
        showToast(next ? "켜짐" : "꺼짐");
      }
    } catch {
      setFlags((prev) => ({ ...prev, [key]: !next }));
      showToast("네트워크 오류");
    } finally {
      setSavingKey(null);
    }
  };

  // 토글 스위치 (작은 pill 형태)
  const Switch = ({ keyName }: { keyName: string }) => {
    const on = !!flags[keyName];
    const busy = savingKey === keyName;
    return (
      <button
        onClick={() => toggle(keyName, !on)}
        disabled={busy}
        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
          on ? "bg-blue-600" : "bg-gray-300"
        } ${busy ? "opacity-50 cursor-wait" : ""}`}
        aria-pressed={on}
      >
        <span
          className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
            on ? "translate-x-6" : "translate-x-1"
          }`}
        />
      </button>
    );
  };

  return (
    <div className="p-4 sm:p-6 space-y-5">
      {/* 토스트 */}
      {toast && (
        <div className="fixed bottom-6 right-6 z-50 bg-gray-900 text-white text-sm font-medium px-5 py-3 rounded-xl shadow-lg">
          {toast}
        </div>
      )}

      {/* 헤더 */}
      <div>
        <h1 className="text-xl sm:text-2xl font-bold text-gray-900 flex items-center gap-2">
          <Bell size={20} />
          알림 설정
        </h1>
        <p className="text-sm text-gray-500 mt-0.5">
          알림 종류별로 앱/이메일/푸시 수신 여부를 설정합니다 (전체 공통 적용)
        </p>
      </div>

      {/* 안내 */}
      <div className="bg-blue-50 border border-blue-200 rounded-2xl px-4 py-3 text-sm text-blue-800">
        <strong>안내:</strong> 이 설정은 회사 전체에 공통 적용됩니다. 이메일은 SMTP가 설정된 경우에만 발송되며, 푸시는 VanaM 포털 PWA에서 알림을 허용한 기기에만 전송됩니다.
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20 text-gray-400">
          <Loader2 className="animate-spin mr-2" size={20} />
          불러오는 중...
        </div>
      ) : (
        <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
          {/* 표 헤더 */}
          <div className="grid grid-cols-[1fr_auto_auto_auto] gap-4 px-5 py-3 bg-gray-50 border-b border-gray-100 text-xs font-semibold text-gray-500 uppercase">
            <div>알림 종류</div>
            <div className="w-16 text-center">앱</div>
            <div className="w-16 text-center">이메일</div>
            <div className="w-16 text-center">푸시</div>
          </div>
          {/* 표 본문 */}
          {NOTIFY_TYPES.map((nt) => (
            <div
              key={nt.type}
              className="grid grid-cols-[1fr_auto_auto_auto] gap-4 px-5 py-4 border-b border-gray-50 last:border-0 items-center"
            >
              <div>
                <div className="text-sm font-medium text-gray-900">{nt.label}</div>
                <div className="text-xs text-gray-400 mt-0.5">{nt.desc}</div>
              </div>
              <div className="w-16 flex justify-center">
                {nt.channels.includes("app") ? <Switch keyName={`notify_${nt.type}_app`} /> : <span className="text-gray-300">—</span>}
              </div>
              <div className="w-16 flex justify-center">
                {nt.channels.includes("email") ? <Switch keyName={`notify_${nt.type}_email`} /> : <span className="text-gray-300">—</span>}
              </div>
              <div className="w-16 flex justify-center">
                {nt.channels.includes("push") ? <Switch keyName={`notify_${nt.type}_push`} /> : <span className="text-gray-300">—</span>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

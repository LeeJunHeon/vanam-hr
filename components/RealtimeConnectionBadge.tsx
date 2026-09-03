"use client";

import { Wifi, WifiOff } from "lucide-react";
import type { RealtimeStatus } from "@/lib/realtime-presence";
import { formatTime } from "@/lib/attendanceLabels";

// 실시간 연결 상태 배지 — 실시간 현황 카드와 동일한 아이콘/색 규칙.
//   working      : Wifi(emerald)  + "N분 전 연결"  (+ 위치)
//   disconnected : WifiOff(amber) + "HH:MM 끊김"
// 모든 화면이 이 컴포넌트를 써서 표시가 갈리지 않게 한다.

function formatRelativeTime(iso: string | null): string {
  if (!iso) return "-";
  const diffMin = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (diffMin < 1) return "방금 전";
  if (diffMin < 60) return `${diffMin}분 전`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour}시간 전`;
  return `${Math.floor(diffHour / 24)}일 전`;
}

export default function RealtimeConnectionBadge(props: {
  status: RealtimeStatus;
  latestCheckedAt: string | null;
  latestLocation?: string | null;
  showLocation?: boolean;
  className?: string;
}) {
  const { status, latestCheckedAt, latestLocation, showLocation = false, className = "" } = props;
  if (status === "working") {
    return (
      <span className={`inline-flex items-center gap-1 text-xs text-gray-600 whitespace-nowrap ${className}`}>
        <Wifi size={12} className="text-emerald-500 shrink-0" />
        {showLocation && latestLocation ? `${latestLocation} · ` : ""}
        {formatRelativeTime(latestCheckedAt)} 연결
      </span>
    );
  }
  return (
    <span className={`inline-flex items-center gap-1 text-xs text-amber-700 whitespace-nowrap ${className}`}>
      <WifiOff size={12} className="text-amber-500 shrink-0" />
      {latestCheckedAt ? `${formatTime(latestCheckedAt)} 끊김` : "연결 끊김"}
    </span>
  );
}

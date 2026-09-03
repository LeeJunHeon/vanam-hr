"use client";

import { Wifi, WifiOff } from "lucide-react";
import type { RealtimeStatus } from "@/lib/realtime-presence";
import { formatTime } from "@/lib/attendanceLabels";

// 실시간 연결 상태 배지 — 실시간 현황 카드와 동일한 아이콘/색 규칙.
// 색 기준은 AttendanceOverviewPage 와 일치시킨다:
//   연결됨   : Wifi(emerald-500)
//   연결 끊김 : WifiOff(gray-400)   ※ amber-500 은 "잠시 자리비움"(away) 전용이라 쓰지 않는다
//
// 기본 모드(상세): "N분 전 연결" / "HH:MM 끊김"  — 시각까지 표시
// compact 모드    : "연결 끊김" 만 표시하고, 연결 중이면 아무것도 렌더하지 않는다.
//                   진행 칸처럼 "지금 이상이 있는지"만 알리면 되는 자리에 쓴다.
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
  /** true 면 끊김만 "연결 끊김"으로 표시하고, 연결 중이면 아무것도 렌더하지 않는다. */
  compact?: boolean;
  className?: string;
}) {
  const {
    status,
    latestCheckedAt,
    latestLocation,
    showLocation = false,
    compact = false,
    className = "",
  } = props;

  if (status === "working") {
    // compact 모드에서는 정상 상태를 알릴 필요가 없다.
    if (compact) return null;
    return (
      <span className={`inline-flex items-center gap-1 text-xs text-gray-600 whitespace-nowrap ${className}`}>
        <Wifi size={12} className="text-emerald-500 shrink-0" />
        {showLocation && latestLocation ? `${latestLocation} · ` : ""}
        {formatRelativeTime(latestCheckedAt)} 연결
      </span>
    );
  }

  // 끊김 — AttendanceOverviewPage 의 "연결 끊김" 표시와 동일하게 gray-400.
  return (
    <span className={`inline-flex items-center gap-1 text-xs text-gray-400 font-medium whitespace-nowrap ${className}`}>
      <WifiOff size={12} className="text-gray-400 shrink-0" />
      {compact || !latestCheckedAt ? "연결 끊김" : `${formatTime(latestCheckedAt)} 끊김`}
    </span>
  );
}

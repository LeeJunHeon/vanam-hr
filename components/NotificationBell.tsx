"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { Bell } from "lucide-react";

export interface NotificationItem {
  id: number;
  type: string;
  title: string;
  body: string | null;
  linkPage: string | null;
  linkRefId: number | null;
  isRead: boolean;
  createdAt: string;
}

interface NotificationBellProps {
  // 알림 API 엔드포인트 전체 경로. 근태=" /api/notifications", 포털="/hr/api/portal-notifications"
  apiUrl: string;
  // cross-origin(포털)이면 true → fetch credentials include
  crossOrigin?: boolean;
  // 같은 앱 내 이동(근태). linkPage를 이 콜백으로 처리.
  onNavigate?: (linkPage: string) => void;
  // onNavigate 없을 때(포털) 이동 베이스. `${absoluteBase}/?page=${linkPage}` 로 이동.
  absoluteBase?: string;
}

function timeAgo(iso: string): string {
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60) return "방금";
  if (diff < 3600) return `${Math.floor(diff / 60)}분 전`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}시간 전`;
  return `${Math.floor(diff / 86400)}일 전`;
}

export default function NotificationBell({
  apiUrl,
  crossOrigin = false,
  onNavigate,
  absoluteBase,
}: NotificationBellProps) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [unread, setUnread] = useState(0);
  const ref = useRef<HTMLDivElement>(null);

  const fetchInit: RequestInit = crossOrigin
    ? { credentials: "include", cache: "no-store" }
    : { cache: "no-store" };

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${apiUrl}?limit=20`, fetchInit);
      if (!res.ok) return;
      const data = await res.json();
      setItems(Array.isArray(data.items) ? data.items : []);
      setUnread(typeof data.unreadCount === "number" ? data.unreadCount : 0);
    } catch {
      /* 조용히 무시 */
    }
  }, [apiUrl]);

  // 최초 + 60초 폴링
  useEffect(() => {
    load();
    const t = setInterval(load, 60000);
    return () => clearInterval(t);
  }, [load]);

  // 바깥 클릭 닫기
  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const markRead = useCallback(
    async (ids: number[]) => {
      try {
        await fetch(apiUrl, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ids }),
          ...fetchInit,
        });
      } catch {
        /* 무시 */
      }
    },
    [apiUrl]
  );

  const handleClickItem = async (n: NotificationItem) => {
    if (!n.isRead) {
      await markRead([n.id]);
      setUnread((u) => Math.max(0, u - 1));
      setItems((prev) => prev.map((x) => (x.id === n.id ? { ...x, isRead: true } : x)));
    }
    setOpen(false);
    const page = n.linkPage || "approval";
    if (onNavigate) {
      onNavigate(page);
    } else if (absoluteBase) {
      window.location.href = `${absoluteBase}/?page=${encodeURIComponent(page)}`;
    }
  };

  const markAllRead = async () => {
    const unreadIds = items.filter((x) => !x.isRead).map((x) => x.id);
    if (unreadIds.length === 0) return;
    try {
      await fetch(apiUrl, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ all: true }),
        ...fetchInit,
      });
    } catch {
      /* 무시 */
    }
    setItems((prev) => prev.map((x) => ({ ...x, isRead: true })));
    setUnread(0);
  };

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="relative p-2 rounded-lg hover:bg-gray-100 transition-colors text-gray-500"
        aria-label="알림"
      >
        <Bell size={18} />
        {unread > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-[16px] px-1 rounded-full bg-red-500 text-white text-[10px] font-bold flex items-center justify-center">
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-80 max-w-[90vw] bg-white rounded-xl shadow-lg border border-gray-100 z-50 overflow-hidden">
          <div className="flex items-center justify-between px-4 py-2.5 border-b border-gray-100">
            <span className="text-sm font-semibold text-gray-900">알림</span>
            {unread > 0 && (
              <button onClick={markAllRead} className="text-xs text-blue-600 hover:underline">
                모두 읽음
              </button>
            )}
          </div>
          <div className="max-h-96 overflow-y-auto">
            {items.length === 0 ? (
              <div className="px-4 py-8 text-center text-sm text-gray-400">알림이 없습니다</div>
            ) : (
              items.map((n) => (
                <button
                  key={n.id}
                  onClick={() => handleClickItem(n)}
                  className={`w-full text-left px-4 py-3 border-b border-gray-50 hover:bg-gray-50 transition-colors ${
                    n.isRead ? "opacity-60" : ""
                  }`}
                >
                  <div className="flex items-start gap-2">
                    {!n.isRead && <span className="mt-1.5 w-2 h-2 rounded-full bg-blue-500 shrink-0" />}
                    <div className={`flex-1 min-w-0 ${n.isRead ? "pl-4" : ""}`}>
                      <p className="text-sm font-medium text-gray-900 truncate">{n.title}</p>
                      {n.body && <p className="text-xs text-gray-500 mt-0.5 line-clamp-2">{n.body}</p>}
                      <p className="text-[11px] text-gray-400 mt-1">{timeAgo(n.createdAt)}</p>
                    </div>
                  </div>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

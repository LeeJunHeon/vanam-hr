"use client";

import { useEffect, useState } from "react";
import { MessageCircle } from "lucide-react";

// 포털 챗봇 임베드 런처.
// - 우측 하단 플로팅 버튼 → 포털의 /widget 페이지를 iframe으로 표시
// - 인증: 같은 도메인이므로 포털 세션 쿠키가 자동 적용됨
// - 대화 유지: 챗봇이 localStorage(도메인 공유)에 저장/복원하므로 앱 간 이동에도 이어짐
// - iframe은 최초 열 때 1회만 마운트하고, 닫을 때는 hidden 처리(재로딩 방지)
export default function PortalChatLauncher() {
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);

  // 챗봇(임베드 모드) 닫기 버튼이 보내는 postMessage 수신
  useEffect(() => {
    function onMessage(e: MessageEvent) {
      if (e.origin !== window.location.origin) return;
      if (e.data === "vanam-chat-close") setOpen(false);
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  return (
    <>
      {/* 플로팅 버튼 (포털 ChatWidget과 동일 스타일) */}
      {!open && (
        <button
          onClick={() => {
            setLoaded(true);
            setOpen(true);
          }}
          aria-label="챗봇 열기"
          className="fixed right-4 bottom-4 z-[60] w-14 h-14 rounded-full bg-blue-500 hover:bg-blue-600 text-white shadow-lg flex items-center justify-center transition-colors"
          style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}
        >
          <MessageCircle size={24} />
        </button>
      )}

      {/* 패널: 포털 ChatWidget 패널과 동일한 위치/크기. 닫아도 iframe은 유지 */}
      {loaded && (
        <div
          className={
            open
              ? "fixed z-[60] bg-white border border-gray-200 rounded-2xl shadow-xl overflow-hidden right-4 left-4 sm:left-auto sm:right-4 sm:w-full sm:max-w-sm"
              : "hidden"
          }
          style={
            open
              ? {
                  bottom: "calc(env(safe-area-inset-bottom, 0px) + 16px)",
                  height: "min(70vh, 600px)",
                  maxHeight: "calc(100vh - 80px)",
                }
              : undefined
          }
        >
          <iframe
            src="/widget"
            title="사내 AI 챗봇"
            allow="camera; microphone"
            className="block w-full h-full border-0"
          />
        </div>
      )}
    </>
  );
}

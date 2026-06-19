"use client";

import { useEffect, useState } from "react";
import { useSession } from "next-auth/react";

type PushState =
  | "idle"
  | "unsupported"
  | "need-permission"
  | "enabling"
  | "enabled"
  | "denied"
  | "error";

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

async function sendToServer(sub: PushSubscription): Promise<void> {
  await fetch("/api/push/subscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ subscription: sub.toJSON() }),
  });
}

export default function PushManager() {
  const { status } = useSession();
  const [state, setState] = useState<PushState>("idle");

  useEffect(() => {
    if (status !== "authenticated") return;
    if (
      typeof window === "undefined" ||
      !("serviceWorker" in navigator) ||
      !("PushManager" in window) ||
      !("Notification" in window)
    ) {
      setState("unsupported");
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const reg = await navigator.serviceWorker.register("/sw.js");
        const existing = await reg.pushManager.getSubscription();
        if (cancelled) return;
        if (Notification.permission === "granted" && existing) {
          await sendToServer(existing); // 멱등 동기화
          setState("enabled");
        } else if (Notification.permission === "denied") {
          setState("denied");
        } else {
          setState("need-permission");
        }
      } catch (e) {
        console.error("[push] init 실패", e);
        if (!cancelled) setState("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [status]);

  async function enable() {
    try {
      setState("enabling");
      const perm = await Notification.requestPermission();
      if (perm !== "granted") {
        setState(perm === "denied" ? "denied" : "need-permission");
        return;
      }
      const reg = await navigator.serviceWorker.ready;
      const res = await fetch("/api/push/vapid-public-key");
      if (!res.ok) throw new Error("vapid key fetch 실패");
      const { key } = (await res.json()) as { key: string };
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(key) as BufferSource,
      });
      await sendToServer(sub);
      setState("enabled");
    } catch (e) {
      console.error("[push] enable 실패", e);
      setState("error");
    }
  }

  if (status !== "authenticated") return null;
  if (state !== "need-permission" && state !== "enabling" && state !== "error") {
    return null;
  }

  return (
    <button
      type="button"
      onClick={enable}
      disabled={state === "enabling"}
      style={{
        position: "fixed",
        right: 16,
        bottom: 16,
        zIndex: 9999,
        padding: "10px 16px",
        borderRadius: 9999,
        background: "#1e3a8a",
        color: "#fff",
        border: "none",
        boxShadow: "0 2px 10px rgba(0,0,0,0.25)",
        fontSize: 14,
        cursor: "pointer",
      }}
    >
      {state === "enabling" ? "설정 중…" : state === "error" ? "알림 다시 시도" : "🔔 알림 켜기"}
    </button>
  );
}

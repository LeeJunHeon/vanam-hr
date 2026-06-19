"use client";

import { SessionProvider } from "next-auth/react";
import PushManager from "@/components/PushManager";

export default function Providers({ children }: { children: React.ReactNode }) {
  return (
    <SessionProvider>
      {children}
      <PushManager />
    </SessionProvider>
  );
}

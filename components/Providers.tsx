"use client";

import { SessionProvider } from "next-auth/react";
import PushManager from "@/components/PushManager";
import BasePathFetch from "@/components/BasePathFetch";

export default function Providers({ children }: { children: React.ReactNode }) {
  return (
    <SessionProvider>
      <BasePathFetch />
      {children}
      <PushManager />
    </SessionProvider>
  );
}

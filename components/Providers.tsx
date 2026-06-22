"use client";

import { SessionProvider } from "next-auth/react";
import PushManager from "@/components/PushManager";
import BasePathFetch from "@/components/BasePathFetch";

export default function Providers({ children }: { children: React.ReactNode }) {
  const bp = process.env.NEXT_PUBLIC_BASE_PATH || "";
  return (
    <SessionProvider basePath={`${bp}/api/auth`}>
      <BasePathFetch />
      {children}
      <PushManager />
    </SessionProvider>
  );
}

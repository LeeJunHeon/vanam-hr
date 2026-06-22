import type { Metadata, Viewport } from "next";
import "./globals.css";
import Providers from "@/components/Providers";

export const metadata: Metadata = {
  title: "VanaM 근태 관리",
  description: "VanaM 근태 관리 시스템",
  icons: {
    icon: "https://vanam.synology.me/favicon.ico",
    shortcut: "https://vanam.synology.me/favicon.ico",
  },
};

export const viewport: Viewport = {
  themeColor: "#61696C",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ko">
      <head>
        <link
          rel="stylesheet"
          as="style"
          crossOrigin="anonymous"
          href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/static/pretendard.min.css"
        />
      </head>
      <body style={{ fontFamily: "'Pretendard', -apple-system, BlinkMacSystemFont, sans-serif" }}>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}

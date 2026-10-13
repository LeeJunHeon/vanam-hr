import type { NextConfig } from "next";

const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "";

const nextConfig: NextConfig = {
  output: "standalone",
  ...(basePath ? { basePath } : {}),
  serverExternalPackages: ["exceljs"],
  experimental: {
    // proxy.ts 가 있으면 Next.js 는 요청 본문을 이 크기(기본 10MB)까지만 담고, 넘는 부분은 오류 없이
    // 잘라서 라우트에 넘긴다. 성과표 증빙 업로드(파일 한 개 최대 20MB — lib/performance/files.ts 의
    // PERF_FILE_MAX_MB_LIMIT)가 잘리지 않도록 그보다 크게 둔다.
    proxyClientMaxBodySize: "25mb",
  },
};

export default nextConfig;

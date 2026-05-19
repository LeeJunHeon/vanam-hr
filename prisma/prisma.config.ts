import path from "node:path";
import { defineConfig } from "prisma/config";
import dotenv from "dotenv";

// prisma/ 폴더 기준이 아닌 프로젝트 루트의 .env 명시적 로드
dotenv.config({ path: path.join(__dirname, "..", ".env") });

export default defineConfig({
  schema: path.join(__dirname, "schema.prisma"),
  // @ts-expect-error -- migrate.url is supported at runtime in Prisma 7.x
  migrate: {
    url: process.env.DATABASE_URL!,
  },
  datasource: {
    url: process.env.DATABASE_URL!,
  },
});

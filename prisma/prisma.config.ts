import path from "node:path";
import { defineConfig } from "prisma/config";
import dotenv from "dotenv";

dotenv.config();

export default defineConfig({
  schema: path.join(__dirname, "schema.prisma"),
  // @ts-expect-error -- migrate.url is supported at runtime in Prisma 7.x
  migrate: {
    url: process.env.DATABASE_URL!,
  },
});

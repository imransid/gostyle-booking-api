// Prisma 7: this file owns the connection url and the schema/migration paths.
// `dotenv/config` MUST be the first import — Prisma 7 no longer loads .env
// itself, so env("DATABASE_URL") below would be undefined without it.
import "dotenv/config";

import { defineConfig, env } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: env("DATABASE_URL"),
  },
});

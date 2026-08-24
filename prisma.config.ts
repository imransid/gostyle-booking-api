// Prisma 7 moved three things out of schema.prisma into here:
//   1. the datasource url
//   2. the migrations path
//   3. .env loading, which is now your job (hence dotenv/config)
//
// "dotenv/config" MUST be the first import. It populates process.env before
// DATABASE_URL below is read. Put it second and you get an undefined url
// with no useful hint.
import 'dotenv/config';
import { defineConfig } from 'prisma/config';

// Read directly rather than through prisma's env() helper.
//
// env() THROWS when the variable is missing, and it is evaluated when this
// module loads, so `prisma generate` fails in a Docker build even though
// generate never touches a database: it only reads the schema and writes
// TypeScript. Falling back to an empty string keeps generate working and
// still fails loudly on migrate, which is the command that genuinely
// needs a connection.
const url = process.env.DATABASE_URL ?? '';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url,
  },
});

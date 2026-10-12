/**
 * Load `.env` before anything else is imported.
 *
 * ConfigModule loads it too, but only when AppModule's decorator runs -- and
 * by then every module AppModule imports has already been evaluated. Values
 * read at import time (BRANCH_TIMEZONE, PLATFORM_GRPC_ADDR, the @Cron
 * timezone) never saw `.env` at all, so a local `.env` silently did nothing
 * for them. Imported first from main.ts, this closes that gap.
 *
 * NEVER OVERRIDES. A variable already in the environment (compose, Swarm,
 * the shell) wins over the file, so production is configured exactly as
 * before -- and `.env` is not in the image anyway (.dockerignore).
 *
 * Node's own loader (22+), not dotenv: dotenv is a dev dependency and the
 * production image installs with --prod.
 */
try {
  process.loadEnvFile('.env');
} catch (e) {
  // No .env is the normal case in a container: the environment is the config.
  if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
}

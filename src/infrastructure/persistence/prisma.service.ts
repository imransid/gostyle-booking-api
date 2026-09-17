import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../generated/prisma/client';

/**
 * The one PrismaClient for the process.
 *
 * Prisma 7 removed the internal Rust connection engine. `new PrismaClient()`
 * with no arguments now throws: you MUST pass a driver adapter, and there is
 * no fallback. That is why this file exists rather than a one-line provider.
 *
 * Note also that the connection string lives HERE, not in prisma.config.ts.
 * The config file configures the CLI (migrate, generate). The adapter
 * configures the running application. They read the same env var and are
 * otherwise unrelated.
 */
/**
 * The pool configuration, as a value rather than an inline literal, so the
 * spec beside this file can assert the parts that are load-bearing.
 */
export function poolConfig(connectionString: string) {
  return {
    connectionString,

    /**
     * EVERY SESSION SPEAKS UTC, whatever the server was configured with.
     * Removing this line silently breaks booking on any non-UTC database.
     *
     * Found by running the flow against a Postgres whose `timezone` was
     * Asia/Dhaka: a hold was written, reported a 15:00 countdown, and the
     * confirm one second later answered 410 Gone. Every time.
     *
     * The adapter sends a timestamptz as a naive wall-clock string and reads
     * it back the same way, so the shift cancels out and Prisma agrees with
     * itself -- `expiresAt: { gt: new Date() }` is correct. What does NOT
     * cancel is a comparison against the DATABASE's own clock, and the
     * confirm path is exactly that:
     *
     *   booking.repository.ts   SELECT id FROM hold WHERE expires_at > now()
     *
     * Stored six hours behind on a +06 server, every live hold looks long
     * expired to that statement. Same for group-confirm, reschedule and the
     * waitlist offer window, which ask Postgres the same question.
     *
     * Pinning the SESSION fixes all of them at once and needs no cooperation
     * from whoever provisioned the database. `docker-compose.yml` sets
     * TZ: UTC on its Postgres, which is why this never showed up locally --
     * a laptop's own Postgres, or a managed instance with a regional
     * default, is where it bites.
     */
    options: '-c timezone=UTC',

    // pg defaults to no connect timeout at all. Prisma 6 used five
    // seconds, so restore that: a hung connect should fail fast and be
    // retried, not stall a request forever.
    connectionTimeoutMillis: 5_000,
    // A booking API is short-query and bursty. Ten is plenty per replica
    // and keeps Postgres well under max_connections with several replicas.
    max: 10,
    idleTimeoutMillis: 30_000,
  };
}

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private static readonly log = new Logger(PrismaService.name);

  constructor() {
    const connectionString = process.env.DATABASE_URL;
    if (connectionString === undefined || connectionString === '') {
      // Fail at boot with a sentence someone can act on, rather than at the
      // first query with "connection refused".
      throw new Error(
        'DATABASE_URL is not set. Add it to .env and make sure ' +
          'ConfigModule.forRoot({ isGlobal: true }) is imported in AppModule.',
      );
    }

    super({ adapter: new PrismaPg(poolConfig(connectionString)) });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    PrismaService.log.log('Database connected');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /** Round trip to the database, for the health endpoint. */
  async ping(): Promise<number> {
    const started = performance.now();
    await this.$queryRaw`SELECT 1`;
    return Math.round((performance.now() - started) * 100) / 100;
  }
}

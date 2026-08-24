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

    super({
      adapter: new PrismaPg({
        connectionString,
        // pg defaults to no connect timeout at all. Prisma 6 used five
        // seconds, so restore that: a hung connect should fail fast and be
        // retried, not stall a request forever.
        connectionTimeoutMillis: 5_000,
        // A booking API is short-query and bursty. Ten is plenty per replica
        // and keeps Postgres well under max_connections with several replicas.
        max: 10,
        idleTimeoutMillis: 30_000,
      }),
    });
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

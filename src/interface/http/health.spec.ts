import { describe, it, expect } from 'vitest';
import { HealthController } from './health.controller';
import type { PrismaService } from '../../infrastructure/persistence/prisma.service';
import type { OutboxRelay } from '../../infrastructure/messaging/outbox-relay.service';
import type { AuthService, ConsumerAuthProbe } from '../../auth/auth.service';

/**
 * /health is read before anyone hits the thing it describes -- that is the
 * whole job. It said `ok` while every customer token was failing, because it
 * only knew about Postgres and the outbox, and the consumer API is neither.
 *
 * These assertions are about the summary line as much as the rails: an
 * operator glances at `status`, and a green one over a dead dependency is
 * worse than no health endpoint at all.
 */

const ADDRESS = '10.0.1.250:50051';

const OUTBOX = {
  pending: 0,
  stuck: 0,
  oldestUnpublishedSeconds: null,
  publishedTotal: 6,
  failedTotal: 0,
};

const prismaUp = {
  ping: () => Promise.resolve(1.24),
} as unknown as PrismaService;
const prismaDown = {
  ping: () => Promise.reject(new Error('connection refused')),
} as unknown as PrismaService;

const relayWith = (over: Partial<typeof OUTBOX> = {}): OutboxRelay =>
  ({
    stats: () => Promise.resolve({ ...OUTBOX, ...over }),
  }) as unknown as OutboxRelay;

const authWith = (probe: ConsumerAuthProbe): AuthService =>
  ({ probe: () => Promise.resolve(probe) }) as unknown as AuthService;

const reachable: ConsumerAuthProbe = {
  reachable: true,
  address: ADDRESS,
  latencyMs: 3,
};

const unreachable: ConsumerAuthProbe = {
  reachable: false,
  address: ADDRESS,
  latencyMs: 750,
  error: `No connection established (ECONNREFUSED ${ADDRESS})`,
};

describe('everything is up', () => {
  it('is ok, and says the auth rail is ok', async () => {
    const got = await new HealthController(
      prismaUp,
      relayWith(),
      authWith(reachable),
    ).check();

    expect(got.status).toBe('ok');
    expect(got.customerAuth.status).toBe('ok');
    expect(got.database).toBe('ok');
  });
});

describe('the consumer API is unreachable', () => {
  const controller = () =>
    new HealthController(prismaUp, relayWith(), authWith(unreachable));

  it('is degraded, not ok', async () => {
    expect((await controller().check()).status).toBe('degraded');
  });

  it('names the rail that is down', async () => {
    expect((await controller().check()).customerAuth.status).toBe(
      'unreachable',
    );
  });

  it('reports the address, so nobody has to guess which box', async () => {
    const got = await controller().check();
    expect(got.customerAuth.address).toBe(ADDRESS);
    expect(got.customerAuth.error).toContain('ECONNREFUSED');
  });

  it('still reports the database, which is fine', async () => {
    const got = await controller().check();
    expect(got.database).toBe('ok');
    expect(got.outbox).toMatchObject({ pending: 0 });
  });
});

describe('rails fail independently', () => {
  it('a dead database does not blank the auth rail', async () => {
    const got = await new HealthController(
      prismaDown,
      relayWith(),
      authWith(reachable),
    ).check();

    expect(got.status).toBe('degraded');
    expect(got.database).toBe('unreachable');
    // The half that used to disappear: one catch covered both, so a Postgres
    // failure meant the auth rail was never reported at all.
    expect(got.customerAuth.status).toBe('ok');
  });

  it('both down is still one answer, with both named', async () => {
    const got = await new HealthController(
      prismaDown,
      relayWith(),
      authWith(unreachable),
    ).check();

    expect(got.status).toBe('degraded');
    expect(got.database).toBe('unreachable');
    expect(got.customerAuth.status).toBe('unreachable');
  });
});

describe('the outbox rail still votes', () => {
  it('a stuck event degrades even with every dependency reachable', async () => {
    const got = await new HealthController(
      prismaUp,
      relayWith({ stuck: 1 }),
      authWith(reachable),
    ).check();

    expect(got.status).toBe('degraded');
  });
});

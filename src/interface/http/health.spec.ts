import { describe, it, expect } from 'vitest';
import { HealthController } from './health.controller';
import type { PrismaService } from '../../infrastructure/persistence/prisma.service';
import type { OutboxRelay } from '../../infrastructure/messaging/outbox-relay.service';
import type { AuthService, ConsumerAuthProbe } from '../../auth/auth.service';
import type {
  JournalSyncRepository,
  JournalSyncStats,
} from '../../infrastructure/persistence/journal-sync.repository';

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

const JOURNAL: JournalSyncStats = {
  waitingForTenant: 0,
  pending: 0,
  parked: 0,
  oldestPendingSeconds: null,
};

const journalWith = (
  over: Partial<JournalSyncStats> = {},
): JournalSyncRepository =>
  ({
    stats: () => Promise.resolve({ ...JOURNAL, ...over }),
  }) as unknown as JournalSyncRepository;

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
      journalWith(),
    ).check();

    expect(got.status).toBe('ok');
    expect(got.customerAuth.status).toBe('ok');
    expect(got.database).toBe('ok');
  });
});

describe('the consumer API is unreachable', () => {
  const controller = () =>
    new HealthController(
      prismaUp,
      relayWith(),
      authWith(unreachable),
      journalWith(),
    );

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
      journalWith(),
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
      journalWith(),
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
      journalWith(),
    ).check();

    expect(got.status).toBe('degraded');
  });
});

describe('the journal rail votes too', () => {
  it('reports the posting queue beside the outbox', async () => {
    const got = await new HealthController(
      prismaUp,
      relayWith(),
      authWith(reachable),
      journalWith({ pending: 3, oldestPendingSeconds: 12 }),
    ).check();

    expect(got.status).toBe('ok');
    expect(got.journal).toMatchObject({ pending: 3, oldestPendingSeconds: 12 });
  });

  it('a parked posting degrades: money that will not reach the books', async () => {
    const got = await new HealthController(
      prismaUp,
      relayWith(),
      authWith(reachable),
      journalWith({ parked: 1 }),
    ).check();

    expect(got.status).toBe('degraded');
  });
});

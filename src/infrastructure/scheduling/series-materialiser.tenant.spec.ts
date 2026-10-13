import { afterEach, describe, expect, it } from 'vitest';
import { SeriesMaterialiser } from './series-materialiser.service';
import { SeriesRepository } from '../persistence/series.repository';
import { TenantContext } from '../tenancy/tenant-context';
import type { PrismaService } from '../persistence/prisma.service';
import type {
  MaterialiseResult,
  MaterialiseSeriesHandler,
} from '@application/commands/materialise-series.handler';

/**
 * THE NIGHTLY JOB BOOKS IN THE SERIES' OWN TENANT (SERIES_JOB_TENANT).
 *
 * The job has no request, so it had no tenant, and every booking it wrote
 * was stamped tenant_id NULL. With the flag on, each series runs inside the
 * tenant it was written under.
 *
 * REAL: the job, the TenantContext (ONE instance, shared by the job and the
 * repository, as Nest injects it), the repository's tenantOf read, and the
 * repository's materialise write. The booking row asserted on is the `data`
 * the real repository hands booking.create.
 *
 * FAKED: the database, and the handler. The handler has no tenant code: it
 * awaits the engine and then this same repository write, and the context
 * reaches that write through AsyncLocalStorage, which is what is under test.
 * Here it goes straight to the write, and records the tenant it was called
 * in, which is the tenant the roster and the catalogue would read.
 */

const TENANT = 'f2a9882b-c822-4107-b650-29af2e303c24';
const WITH_TENANT = 'aaaaaaaa-0000-4aaa-8aaa-aaaaaaaaaaaa';
const NO_TENANT = 'bbbbbbbb-0000-4bbb-8bbb-bbbbbbbbbbbb';

afterEach(() => {
  delete process.env.SERIES_JOB_TENANT;
});

/** The tenant_id column of booking_series, by series id. */
type SeriesTenants = Record<string, string | null>;

function nightlyJob(due: readonly string[], tenants: SeriesTenants) {
  const created: { seriesId: string; tenantId: unknown }[] = [];
  const seenByHandler: { seriesId: string; tenant: string | null }[] = [];
  const tenantReads: string[] = [];
  let current = '';

  const tx = {
    $executeRaw: () => Promise.resolve(1),
    $queryRaw: () => Promise.resolve([{ code: 'GS-1' }]),
    booking: {
      create: (a: { data: { tenantId: unknown } }) => {
        created.push({ seriesId: current, tenantId: a.data.tenantId });
        return Promise.resolve({ id: `booking-${current}`, code: 'GS-1' });
      },
    },
    bookingItem: { create: () => Promise.resolve({ id: 'item' }) },
    staffReservation: { create: () => Promise.resolve({}) },
    resourceReservation: { create: () => Promise.resolve({}) },
    seriesOccurrence: { update: () => Promise.resolve({}) },
    eventOutbox: { create: () => Promise.resolve({}) },
  };

  const prisma = {
    bookingSeries: {
      findMany: () => Promise.resolve(due.map((id) => ({ id }))),
      findUnique: (a: { where: { id: string } }) => {
        tenantReads.push(a.where.id);
        return Promise.resolve(
          a.where.id in tenants ? { tenantId: tenants[a.where.id] } : null,
        );
      },
    },
    $transaction: <T>(fn: (t: typeof tx) => Promise<T>) => fn(tx),
  } as unknown as PrismaService;

  const context = new TenantContext();
  const repo = new SeriesRepository(prisma, context);

  const handler = {
    run: async (seriesId: string): Promise<MaterialiseResult> => {
      current = seriesId;
      seenByHandler.push({ seriesId, tenant: context.current() });
      const out = await repo.materialise({
        occurrenceId: `occ-${seriesId}`,
        branchId: 'b7e92439-8285-469a-bba4-dcaa3dd5842c',
        customerId: '11111111-1111-4111-8111-111111111111',
        tradingDay: '2026-10-20',
        startMin: 600,
        durationMin: 45,
        staffId: '22222222-2222-4222-8222-222222222222',
        serviceId: '33333333-3333-4333-8333-333333333333',
        serviceName: 'Haircut',
        resourceType: 'chair',
        requiredSkill: 'hair',
        priceFils: 10_000,
        depositFils: 0,
        status: 'confirmed',
        paymentStatus: 'none_required',
        claimPreMin: 0,
        claimPostMin: 0,
        source: 'platform',
      });
      const booked = out.kind === 'materialised' ? 1 : 0;
      return {
        seriesId,
        considered: 1,
        materialised: booked,
        repaired: 0,
        needsAttention: 1 - booked,
        deferred: 0,
        raced: 0,
        notes: [],
      };
    },
  } as unknown as MaterialiseSeriesHandler;

  const job = new SeriesMaterialiser(repo, handler, context);
  return { job, created, seenByHandler, tenantReads };
}

describe('the nightly series job and the tenant (SERIES_JOB_TENANT on)', () => {
  it("a materialised booking carries its series' tenant", async () => {
    process.env.SERIES_JOB_TENANT = 'true';
    const { job, created } = nightlyJob([WITH_TENANT], {
      [WITH_TENANT]: TENANT,
    });

    const out = await job.run('2026-10-08');

    expect(out).toEqual({ series: 1, materialised: 1 });
    expect(created).toEqual([{ seriesId: WITH_TENANT, tenantId: TENANT }]);
  });

  it('the engine runs in that tenant too, so the roster and catalogue read it', async () => {
    process.env.SERIES_JOB_TENANT = 'true';
    const { job, seenByHandler } = nightlyJob([WITH_TENANT], {
      [WITH_TENANT]: TENANT,
    });

    await job.run('2026-10-08');

    expect(seenByHandler).toEqual([{ seriesId: WITH_TENANT, tenant: TENANT }]);
  });

  it('a series with a NULL tenant still materialises, stamped NULL as before', async () => {
    process.env.SERIES_JOB_TENANT = 'true';
    const { job, created } = nightlyJob([NO_TENANT], { [NO_TENANT]: null });

    const out = await job.run('2026-10-08');

    expect(out).toEqual({ series: 1, materialised: 1 });
    expect(created).toEqual([{ seriesId: NO_TENANT, tenantId: null }]);
  });

  it('a series whose row is gone runs with no tenant rather than throwing', async () => {
    process.env.SERIES_JOB_TENANT = 'true';
    const gone = 'cccccccc-0000-4ccc-8ccc-cccccccccccc';
    const { job, created } = nightlyJob([gone], {});

    const out = await job.run('2026-10-08');

    expect(out).toEqual({ series: 1, materialised: 1 });
    expect(created).toEqual([{ seriesId: gone, tenantId: null }]);
  });

  it("one series' tenant never reaches the next", async () => {
    process.env.SERIES_JOB_TENANT = 'true';
    const { job, created } = nightlyJob([WITH_TENANT, NO_TENANT], {
      [WITH_TENANT]: TENANT,
      [NO_TENANT]: null,
    });

    await job.run('2026-10-08');

    expect(created).toEqual([
      { seriesId: WITH_TENANT, tenantId: TENANT },
      { seriesId: NO_TENANT, tenantId: null },
    ]);
  });
});

describe('the nightly series job with SERIES_JOB_TENANT off', () => {
  it.each([
    ['unset', undefined],
    ['false', 'false'],
    ['blank', ''],
  ])(
    '%s: exactly as before, no tenant read and NULL stamped',
    async (_, value) => {
      if (value !== undefined) process.env.SERIES_JOB_TENANT = value;
      const { job, created, tenantReads, seenByHandler } = nightlyJob(
        [WITH_TENANT],
        { [WITH_TENANT]: TENANT },
      );

      const out = await job.run('2026-10-08');

      expect(out).toEqual({ series: 1, materialised: 1 });
      expect(tenantReads).toEqual([]);
      expect(seenByHandler).toEqual([{ seriesId: WITH_TENANT, tenant: null }]);
      expect(created).toEqual([{ seriesId: WITH_TENANT, tenantId: null }]);
    },
  );
});

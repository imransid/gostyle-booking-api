import { describe, expect, it } from 'vitest';
import {
  MOBILE_NEVER_TOPPED_UP,
  MobileSeriesRepository,
  type CreateMobileSeriesInput,
} from './mobile-series.repository';
import { TenantContext } from '../tenancy/tenant-context';
import { toUuid } from './hold.repository';
import type { PrismaService } from './prisma.service';

/**
 * REPOSITORY SPEC: what is written, with a fake transaction.
 *
 * The constraints are proven live against Postgres
 * (prisma/proof-mobile-series.sql and proof-mobile-series-created.sql,
 * CLAUDE.md 5). What a fake can pin is the shape of every write: a mobile
 * routine must be a series the DESK already knows how to read.
 */

const CUSTOMER = '11111111-1111-4111-8111-111111111111';
const SERIES = 'aaaaaaaa-0000-4aaa-8aaa-aaaaaaaaaaaa';

interface Call {
  readonly method: string;
  readonly arg: unknown;
}

function fakePrisma(over: { linkedCount?: number } = {}) {
  const calls: Call[] = [];
  const record = <T>(method: string, arg: unknown, result: T): Promise<T> => {
    calls.push({ method, arg });
    return Promise.resolve(result);
  };
  const tx = {
    bookingSeries: {
      create: (a: unknown) => record('bookingSeries.create', a, { id: SERIES }),
    },
    seriesOccurrence: {
      createMany: (a: unknown) =>
        record('seriesOccurrence.createMany', a, { count: 0 }),
    },
    booking: {
      updateMany: (a: unknown) =>
        record('booking.updateMany', a, { count: over.linkedCount ?? 1 }),
    },
    eventOutbox: {
      create: (a: unknown) => record('eventOutbox.create', a, {}),
    },
  };
  const prisma = {
    $transaction: <T>(fn: (t: typeof tx) => Promise<T>) => fn(tx),
  } as unknown as PrismaService;
  return { prisma, calls };
}

const INPUT: CreateMobileSeriesInput = {
  branchId: 'marina-walk',
  customerId: CUSTOMER,
  frequency: 'monthly',
  serviceIds: ['haircut-finish', 'blow-dry'],
  stylistId: 'maya',
  startMin: 990,
  paymentPlan: 'pay_at_salon',
  baselinePriceFils: 16_000,
  sessions: [
    {
      index: 0,
      day: '2026-10-15',
      startMin: 990,
      movedFromDayOfMonth: null,
      bookingId: 'b-0',
    },
    // A picked session keeps its own time (D4).
    {
      index: 1,
      day: '2026-11-16',
      startMin: 1020,
      movedFromDayOfMonth: null,
      bookingId: 'b-1',
    },
    {
      index: 2,
      day: '2026-12-15',
      startMin: 990,
      movedFromDayOfMonth: null,
      bookingId: 'b-2',
    },
    // Past the 90 day horizon: planned, not booked yet.
    {
      index: 3,
      day: '2027-01-15',
      startMin: 990,
      movedFromDayOfMonth: null,
      bookingId: null,
    },
  ],
};

const arg = (calls: Call[], method: string) =>
  calls.filter((c) => c.method === method).map((c) => c.arg);

describe('MobileSeriesRepository.create', () => {
  it('writes ONE series row in the shape the desk writes, plus the mobile columns', async () => {
    const { prisma, calls } = fakePrisma();
    const out = await new MobileSeriesRepository(
      prisma,
      new TenantContext(),
    ).create(INPUT);

    expect(out).toEqual({ seriesId: SERIES });
    const [created] = arg(calls, 'bookingSeries.create') as {
      data: Record<string, unknown>;
    }[];
    expect(created!.data).toEqual({
      tenantId: null,
      branchId: toUuid('marina-walk'),
      customerId: CUSTOMER,
      anchorDay: new Date('2026-10-15T00:00:00Z'),
      startMin: 990,
      pattern: 'custom',
      customDates: [
        new Date('2026-10-15T00:00:00Z'),
        new Date('2026-11-16T00:00:00Z'),
        new Date('2026-12-15T00:00:00Z'),
        new Date('2027-01-15T00:00:00Z'),
      ],
      endKind: 'after_count',
      endCount: 4,
      autoConfirmRule: 'auto_confirm_on_schedule',
      serviceId: toUuid('haircut-finish'),
      preferredStaffId: toUuid('maya'),
      baselinePriceFils: 16_000,
      materialisedThrough: new Date(`${MOBILE_NEVER_TOPPED_UP}T00:00:00Z`),
      source: 'mobile',
      frequency: 'monthly',
      serviceIds: [toUuid('haircut-finish'), toUuid('blow-dry')],
      paymentPlan: 'pay_at_salon',
    });
  });

  it('writes one occurrence per session: materialised with its booking, or planned', async () => {
    const { prisma, calls } = fakePrisma();
    await new MobileSeriesRepository(prisma, new TenantContext()).create(INPUT);

    const [occ] = arg(calls, 'seriesOccurrence.createMany') as {
      data: Record<string, unknown>[];
    }[];
    expect(
      occ!.data.map((o) => [o.index, o.state, o.bookingId, o.plannedStartMin]),
    ).toEqual([
      [0, 'materialised', 'b-0', 990],
      [1, 'materialised', 'b-1', 1020],
      [2, 'materialised', 'b-2', 990],
      [3, 'planned', null, 990],
    ]);
    expect(occ!.data.every((o) => o.seriesId === SERIES)).toBe(true);
  });

  it('links each booked session: series_id and routine together, channel recurring, only the customer own booking', async () => {
    const { prisma, calls } = fakePrisma();
    await new MobileSeriesRepository(prisma, new TenantContext()).create(INPUT);

    const links = arg(calls, 'booking.updateMany');
    expect(links).toEqual(
      ['b-0', 'b-1', 'b-2'].map((id) => ({
        where: { id, customerId: CUSTOMER, seriesId: null },
        data: {
          seriesId: SERIES,
          bookingType: 'routine',
          channel: 'recurring',
        },
      })),
    );
  });

  it('refuses the whole routine when a booking cannot be linked', async () => {
    const { prisma } = fakePrisma({ linkedCount: 0 });
    await expect(
      new MobileSeriesRepository(prisma, new TenantContext()).create(INPUT),
    ).rejects.toThrow('could not be linked');
  });

  it('says what happened on the outbox, as the desk create does', async () => {
    const { prisma, calls } = fakePrisma();
    await new MobileSeriesRepository(prisma, new TenantContext()).create(INPUT);
    expect(arg(calls, 'eventOutbox.create')).toEqual([
      {
        data: {
          aggregateType: 'series',
          aggregateId: SERIES,
          eventType: 'series.created',
          payload: {
            source: 'mobile',
            frequency: 'monthly',
            occurrences: 4,
            booked: 3,
          },
        },
      },
    ]);
  });

  it('refuses an empty routine as a bug', async () => {
    const { prisma } = fakePrisma();
    await expect(
      new MobileSeriesRepository(prisma, new TenantContext()).create({
        ...INPUT,
        sessions: [],
      }),
    ).rejects.toThrow();
  });
});

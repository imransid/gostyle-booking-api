import { describe, expect, it, vi } from 'vitest';
import {
  MobileSeriesReadHandler,
  type SeriesReader,
} from './mobile-series-read.handler';
import { isMobileContractError } from '@application/commands/mobile-booking.error';
import { TenantContext } from '@infrastructure/tenancy/tenant-context';
import { toUuid } from '@infrastructure/persistence/hold.repository';

/**
 * HUB SPEC: the rows as the database would hold them, the view the app gets.
 *
 * Every state is derived on the read, so what the DESK does to a mobile
 * routine (cancel a session, skip one, pause, resume) shows up here with no
 * mobile code involved. That is what these pin.
 */

const SERIES = 'aaaaaaaa-0000-4aaa-8aaa-aaaaaaaaaaaa';
const CUSTOMER = '11111111-1111-4111-8111-111111111111';
const STRANGER = '33333333-3333-4333-8333-333333333333';
/** 2026-10-20 09:00 at the branch (UTC+6). */
const NOW = Date.UTC(2026, 9, 20, 3, 0);

const owner: SeriesReader = {
  actorId: CUSTOMER,
  actorKind: 'customer',
  actorBranchId: null,
};

const occ = (
  index: number,
  day: string,
  state: string,
  bookingId: string | null,
) => ({
  id: `occ-${index}`,
  index,
  plannedDay: new Date(`${day}T00:00:00Z`),
  plannedStartMin: 990,
  state,
  bookingId,
});

function series(over: Record<string, unknown> = {}) {
  return {
    id: SERIES,
    tenantId: null,
    branchId: toUuid('marina-walk'),
    customerId: CUSTOMER,
    startMin: 990,
    status: 'active',
    serviceId: toUuid('haircut-finish'),
    preferredStaffId: toUuid('maya'),
    source: 'mobile',
    frequency: 'weekly',
    serviceIds: [toUuid('haircut-finish')],
    paymentPlan: 'pay_at_salon',
    pausedUntil: null as Date | null,
    pauseReason: null as string | null,
    pauseNote: null as string | null,
    createdAt: new Date('2026-09-20T05:00:00Z'),
    occurrences: [
      occ(0, '2026-09-29', 'materialised', 'b-0'),
      occ(1, '2026-10-06', 'materialised', 'b-1'),
      // Skipped through the routine (or the desk's skip).
      occ(2, '2026-10-13', 'skipped', 'b-2'),
      // Today at 16:30: inside the 24h lock.
      occ(3, '2026-10-20', 'materialised', 'b-3'),
      occ(4, '2026-10-27', 'materialised', 'b-4'),
      // Past the 90 day horizon: planned, nothing booked.
      occ(5, '2027-02-02', 'planned', null),
    ],
    ...over,
  };
}

const booking = (id: string, day: string, status: string) => ({
  id,
  code: `GS-${id}`,
  status,
  tradingDay: new Date(`${day}T00:00:00Z`),
  startMinute: 990,
  durationMin: 45,
  priceFils: 10_000,
  netFils: 10_000,
  taxFils: 500,
  discountFils: 0,
  items: [
    {
      serviceId: toUuid('haircut-finish'),
      serviceName: 'Haircut & finish',
      staffId: toUuid('maya'),
    },
  ],
  products: [] as { priceFils: number; quantity: number }[],
});

const BOOKINGS = [
  booking('b-0', '2026-09-29', 'completed'),
  booking('b-1', '2026-10-06', 'no_show'),
  booking('b-2', '2026-10-13', 'cancelled'),
  booking('b-3', '2026-10-20', 'confirmed'),
  booking('b-4', '2026-10-27', 'confirmed'),
];

function harness(
  over: {
    series?: unknown;
    bookings?: unknown[];
    noShows?: { bookingId: string; actorKind: string }[];
  } = {},
) {
  const prisma = {
    bookingSeries: {
      findUnique: vi.fn(() =>
        Promise.resolve(over.series === undefined ? series() : over.series),
      ),
    },
    booking: {
      findMany: vi.fn(() => Promise.resolve(over.bookings ?? BOOKINGS)),
    },
    bookingStatusHistory: {
      findMany: vi.fn(() =>
        Promise.resolve(
          over.noShows ?? [{ bookingId: 'b-1', actorKind: 'staff' }],
        ),
      ),
    },
  };
  const context = {
    loadDay: vi.fn(() =>
      Promise.resolve({ professionals: [{ id: 'maya', name: 'Maya' }] }),
    ),
    loadCatalogue: vi.fn(() =>
      Promise.resolve([{ id: 'haircut-finish', name: 'Haircut & finish' }]),
    ),
  };
  const handler = new MobileSeriesReadHandler(
    prisma as never,
    new TenantContext(),
    context as never,
  );
  return { handler, prisma };
}

async function notFound(p: Promise<unknown>): Promise<boolean> {
  try {
    await p;
    return false;
  } catch (e) {
    return (
      isMobileContractError(e) &&
      e.status === 404 &&
      e.errors[0]?.code === 'not_found'
    );
  }
}

describe('who may read it: 404, never 403', () => {
  it('a malformed id is 404, and the database is not asked', async () => {
    const { handler, prisma } = harness();
    expect(await notFound(handler.read('not-a-uuid', owner, NOW))).toBe(true);
    expect(prisma.bookingSeries.findUnique).not.toHaveBeenCalled();
  });

  it('no such routine is 404', async () => {
    const { handler } = harness({ series: null });
    expect(await notFound(handler.read(SERIES, owner, NOW))).toBe(true);
  });

  it('a DESK series id is 404: this route answers for the routines the app made', async () => {
    const { handler } = harness({ series: series({ source: null }) });
    expect(await notFound(handler.read(SERIES, owner, NOW))).toBe(true);
  });

  it("someone else's routine is 404, exactly like no routine", async () => {
    const { handler } = harness();
    expect(
      await notFound(
        handler.read(SERIES, { ...owner, actorId: STRANGER }, NOW),
      ),
    ).toBe(true);
  });

  it('staff of the salon may read it; staff of another salon may not', async () => {
    const { handler } = harness();
    await expect(
      handler.read(
        SERIES,
        { actorId: 'desk', actorKind: 'staff', actorBranchId: 'marina-walk' },
        NOW,
      ),
    ).resolves.toMatchObject({ id: SERIES });
    expect(
      await notFound(
        handler.read(
          SERIES,
          { actorId: 'desk', actorKind: 'staff', actorBranchId: 'other-salon' },
          NOW,
        ),
      ),
    ).toBe(true);
  });
});

describe('the hub', () => {
  it('the routine, in the app words', async () => {
    const { handler } = harness();
    const hub = await handler.read(SERIES, owner, NOW);
    expect(hub).toMatchObject({
      id: SERIES,
      booking_type: 'ROUTINE',
      salon_id: 'marina-walk',
      status: 'ACTIVE',
      frequency: 'WEEKLY',
      time: '16:30',
      stylist: { id: 'maya', name: 'Maya' },
      services: [{ id: 'haircut-finish', name: 'Haircut & finish' }],
      payment_plan: 'PAY_AT_SALON',
      pause: null,
      rules: { min_sessions: 2, max_sessions: 6, lock_hours: 24 },
      created_at: '2026-09-20T11:00:00+06:00',
    });
  });

  it('every session, its state derived from the rows and the clock', async () => {
    const { handler } = harness();
    const hub = await handler.read(SERIES, owner, NOW);
    expect(
      hub.sessions.map((s) => [s.index, s.date, s.state, s.locked, s.can_skip]),
    ).toEqual([
      [0, '2026-09-29', 'COMPLETED', true, false],
      [1, '2026-10-06', 'MISSED', true, false],
      [2, '2026-10-13', 'SKIPPED', true, false],
      [3, '2026-10-20', 'CONFIRMED', true, false],
      [4, '2026-10-27', 'SCHEDULED', false, true],
      [5, '2027-02-02', 'PLANNED', false, true],
    ]);
    expect(hub.sessions[4]).toMatchObject({
      id: 'occ-4',
      booking_id: 'b-4',
      booking_code: 'GS-b-4',
      start_time: '2026-10-27T16:30:00+06:00',
      end_time: '2026-10-27T17:15:00+06:00',
      stylist: { id: 'maya', name: 'Maya' },
      total: 105,
    });
    expect(hub.sessions[5]).toMatchObject({
      booking_id: null,
      end_time: null,
      total: null,
    });
  });

  it('"2 of 5 done, 3 remaining", the skip shown apart, the next one named', async () => {
    const { handler } = harness();
    const hub = await handler.read(SERIES, owner, NOW);
    expect(hub.counts).toEqual({
      total: 5,
      done: 2,
      remaining: 3,
      skipped: 1,
      cancelled: 0,
    });
    expect(hub.next_session?.index).toBe(3);
    // Four booked sessions that did or will happen, at 105.00 each.
    expect(hub.money).toEqual({ total: 420, pay_now: 0 });
    expect(hub.can).toEqual({
      skip: true,
      reschedule: true,
      extend: true,
      pause: true,
      resume: false,
      cancel: true,
    });
  });

  it('a session the DESK cancelled shows as cancelled, and leaves the money', async () => {
    const { handler } = harness({
      bookings: [
        ...BOOKINGS.slice(0, 4),
        booking('b-4', '2026-10-27', 'cancelled'),
      ],
    });
    const hub = await handler.read(SERIES, owner, NOW);
    expect(hub.sessions[4]!.state).toBe('CANCELLED');
    expect(hub.counts).toMatchObject({ remaining: 2, cancelled: 1 });
    expect(hub.money.total).toBe(315);
  });

  it('a no-show the sweeper marked is still a missed session on the hub', async () => {
    const { handler } = harness({
      noShows: [{ bookingId: 'b-1', actorKind: 'system' }],
    });
    const hub = await handler.read(SERIES, owner, NOW);
    expect(hub.sessions[1]!.state).toBe('MISSED');
  });

  it('a DESK pause shows as paused: resume offered, nothing else', async () => {
    const { handler } = harness({ series: series({ status: 'paused' }) });
    const hub = await handler.read(SERIES, owner, NOW);
    expect(hub.status).toBe('PAUSED');
    expect(hub.pause).toEqual({ until: null, reason: null, note: null });
    expect(hub.can).toMatchObject({
      skip: false,
      reschedule: false,
      extend: false,
      pause: false,
      resume: true,
    });
    expect(hub.sessions.every((s) => !s.can_skip)).toBe(true);
  });

  it('an app pause shows its date, reason and note', async () => {
    const { handler } = harness({
      series: series({
        status: 'paused',
        pausedUntil: new Date('2026-11-20T00:00:00Z'),
        pauseReason: 'busy',
        pauseNote: 'Exams',
      }),
    });
    const hub = await handler.read(SERIES, owner, NOW);
    expect(hub.pause).toEqual({
      until: '2026-11-20',
      reason: 'BUSY',
      note: 'Exams',
    });
  });

  it('after a DESK resume, the left-over pause date is ignored', async () => {
    const { handler } = harness({
      series: series({
        status: 'active',
        pausedUntil: new Date('2026-11-20T00:00:00Z'),
        pauseReason: 'travel',
      }),
    });
    const hub = await handler.read(SERIES, owner, NOW);
    expect(hub.status).toBe('ACTIVE');
    expect(hub.pause).toBeNull();
  });

  it('a platform that is down leaves the names off, not the routine', async () => {
    const { handler } = harness();
    (
      handler as unknown as {
        context: { loadDay: () => Promise<never> };
      }
    ).context.loadDay = () => Promise.reject(new Error('down'));
    const hub = await handler.read(SERIES, owner, NOW);
    expect(hub.stylist?.name ?? null).toBeNull();
    expect(hub.sessions).toHaveLength(6);
  });
});

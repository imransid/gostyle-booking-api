import { describe, it, expect } from 'vitest';
import { BookingReadHandler } from './read-models.handler';
import type { ReadModelRepository } from '@infrastructure/persistence/read-model.repository';
import type { BookingContextReader } from '@application/ports/booking-context.port';
import type { CustomerContextReader } from '@application/ports/customer-context.port';
import { CHIP_STATUSES } from '@application/contract/screen-view';
import type { BookingStatus } from '@domain/booking/lifecycle';

/**
 * HANDLER SPEC — the month strip, past the ceiling that used to cut it short.
 *
 * month() read the month's bookings under the week grid's 2000-row cap only
 * to count and sum them, so a busy month undercounted its tiles while its
 * cells stayed right. It now asks for per-status totals. What is worth
 * pinning here is that it never reads rows at all, and that the totals are
 * sorted the way they were: live for the money, every chip for the counts.
 *
 * The SQL itself is proven live against Postgres (CLAUDE.md 5); nothing a
 * fake says can stand in for that.
 */

type Totals = { status: BookingStatus; n: number; revenueFils: number }[];

class FakeReads {
  statusWindow: unknown = null;

  constructor(private readonly totals: Totals) {}

  list(): Promise<never> {
    return Promise.reject(new Error('fake: month() must not read rows'));
  }

  statusTotals(f: unknown): Promise<Totals> {
    this.statusWindow = f;
    return Promise.resolve(this.totals);
  }

  dailyTotals(): Promise<[]> {
    return Promise.resolve([]);
  }

  openConflicts(): Promise<{ trading_day: Date }[]> {
    return Promise.resolve([
      { trading_day: new Date('2026-09-17T00:00:00Z') },
      // Outside the month: must not count.
      { trading_day: new Date('2026-10-02T00:00:00Z') },
    ]);
  }
}

/** Neither port is touched by the month; a call to either is a failure. */
const unused = new Proxy(
  {},
  {
    get: () => () => Promise.reject(new Error('fake: port not expected')),
  },
);

function handlerOver(totals: Totals) {
  const reads = new FakeReads(totals);
  const handler = new BookingReadHandler(
    reads as unknown as ReadModelRepository,
    unused as BookingContextReader,
    unused as CustomerContextReader,
  );
  return { reads, handler };
}

async function month(totals: Totals) {
  const { reads, handler } = handlerOver(totals);
  const body = (await handler.month('marina-walk', '2026-09', 90)) as {
    kpis: Record<string, number>;
    counts: Record<string, number>;
  };
  return { reads, body };
}

/** Well past the old 2000 cap, split so every rule has something to sort. */
const BUSY: Totals = [
  { status: 'confirmed', n: 1_800, revenueFils: 1_800 * 18_000 },
  { status: 'pending_payment', n: 150, revenueFils: 150 * 20_000 },
  { status: 'pending_confirmation', n: 50, revenueFils: 50 * 16_000 },
  { status: 'completed', n: 300, revenueFils: 300 * 15_000 },
  { status: 'settled', n: 250, revenueFils: 250 * 14_050 },
  { status: 'no_show', n: 60, revenueFils: 60 * 16_000 },
  { status: 'cancelled', n: 90, revenueFils: 90 * 16_000 },
];

describe('month()', () => {
  it('counts a month past 2000 bookings in full, without reading a row', async () => {
    const { body } = await month(BUSY);

    expect(body.kpis.booked).toBe(1_800 + 150 + 50 + 300 + 250);
    expect(body.counts).toEqual({
      upcoming: 1_800 + 150 + 50,
      checked_in: 0,
      in_service: 0,
      completed: 300 + 250,
      no_show: 60,
      cancelled: 90,
    });
  });

  it('keeps no-shows and cancellations out of booked and revenue', async () => {
    const { body } = await month(BUSY);

    const liveFils =
      1_800 * 18_000 + 150 * 20_000 + 50 * 16_000 + 300 * 15_000 + 250 * 14_050;
    expect(body.kpis.revenue).toBe(Math.round(liveFils / 100));
    expect(body.kpis.pendingDeposits).toBe(150);
  });

  it('asks for every status a chip can reach, over the month', async () => {
    const { reads } = await month(BUSY);

    expect(reads.statusWindow).toEqual({
      branchId: 'marina-walk',
      fromDay: '2026-09-01',
      toDay: '2026-10-01',
      statuses: CHIP_STATUSES,
    });
  });

  it('publishes four kpis, with utilisation and walk-ins absent rather than zero', async () => {
    const { body } = await month([]);

    expect(Object.keys(body.kpis)).toEqual([
      'booked',
      'revenue',
      'pendingDeposits',
      'conflicts',
    ]);
    expect(body.kpis).toEqual({
      booked: 0,
      revenue: 0,
      pendingDeposits: 0,
      conflicts: 1,
    });
  });
});

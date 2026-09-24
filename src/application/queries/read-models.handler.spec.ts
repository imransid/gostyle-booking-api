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

// ------------------------------------------------------------ the agenda list

/**
 * THE AGENDA'S TILES are the month's four, over the list's own window and
 * filters. What is pinned here is what they are asked of: the same filters as
 * the page, not the chip counts' unfiltered horizon.
 */
class FakeListReads {
  readonly counted: Record<string, unknown>[] = [];
  statusWindow: Record<string, unknown> | null = null;
  pageWindow: Record<string, unknown> | null = null;

  constructor(private readonly totals: Totals) {}

  list(f: Record<string, unknown>): Promise<[]> {
    this.pageWindow = f;
    return Promise.resolve([]);
  }

  statusTotals(f: Record<string, unknown>): Promise<Totals> {
    this.statusWindow = f;
    return Promise.resolve(this.totals);
  }

  /** Conflicts answer 2; every chip count answers 5. */
  count(f: Record<string, unknown>): Promise<number> {
    this.counted.push(f);
    return Promise.resolve(f['conflictsOnly'] === true ? 2 : 5);
  }
}

async function agenda(
  q: Partial<Parameters<BookingReadHandler['list']>[0]>,
  totals: Totals = BUSY,
) {
  const reads = new FakeListReads(totals);
  const handler = new BookingReadHandler(
    reads as unknown as ReadModelRepository,
    unused as BookingContextReader,
    unused as CustomerContextReader,
  );
  const body = await handler.list({ branchId: 'marina-walk', ...q });
  return { reads, body };
}

describe('list() tiles', () => {
  it('publishes the month’s four, with utilisation and walk-ins absent', async () => {
    const { body } = await agenda({ from: '2026-10-01', to: '2026-10-31' });

    expect(Object.keys(body.kpis)).toEqual([
      'booked',
      'revenue',
      'pendingDeposits',
      'conflicts',
    ]);
    expect(body.kpis).not.toHaveProperty('utilisation');
    expect(body.kpis).not.toHaveProperty('walkInsWaiting');
  });

  it('sums live bookings only, exactly as the month does', async () => {
    const { body } = await agenda({ from: '2026-10-01', to: '2026-10-31' });
    const month = (await handlerOver(BUSY).handler.month(
      'm',
      '2026-09',
      90,
    )) as {
      kpis: Record<string, number>;
    };

    expect(body.kpis.booked).toBe(month.kpis.booked);
    expect(body.kpis.revenue).toBe(month.kpis.revenue);
    expect(body.kpis.pendingDeposits).toBe(month.kpis.pendingDeposits);
  });

  it('asks for the totals with the page’s own filters, not the chips’ horizon', async () => {
    const { reads } = await agenda({
      filter: 'DEPOSIT_PENDING',
      from: '2026-10-01',
      to: '2026-10-31',
      staffId: 'maya',
      customerId: 'c-1',
    });

    const { limit: _l, offset: _o, ...pageFilters } = reads.pageWindow!;
    expect(reads.statusWindow).toEqual(pageFilters);
    expect(reads.statusWindow).toMatchObject({
      fromDay: '2026-10-01',
      toDay: '2026-11-01',
      statuses: ['pending_payment'],
      staffIds: ['maya'],
      customerId: 'c-1',
    });
  });

  it('counts conflicts over the same filters, as bookings filter=CONFLICTS would list', async () => {
    const { reads, body } = await agenda({
      from: '2026-10-01',
      to: '2026-10-31',
      staffId: 'maya',
    });

    const asked = reads.counted.filter((f) => f['staffIds'] !== undefined);
    expect(asked).toEqual([{ ...reads.statusWindow, conflictsOnly: true }]);
    expect(body.kpis.conflicts).toBe(2);
  });

  it('derives total from the status totals, so it cannot drift from booked', async () => {
    const { body } = await agenda({ from: '2026-10-01', to: '2026-10-31' });

    expect(body.total).toBe(BUSY.reduce((n, t) => n + t.n, 0));
  });

  it('leaves the older chip counts as they were: seven words, unfiltered', async () => {
    const { reads, body } = await agenda({
      from: '2026-10-01',
      to: '2026-10-31',
      staffId: 'maya',
    });

    expect(Object.keys(body.counts)).toEqual([
      'ALL',
      'TODAY',
      'TOMORROW',
      'DEPOSIT_PENDING',
      'CONFLICTS',
      'NOT_REMINDED',
      'UNCONFIRMED',
    ]);
    const chipCalls = reads.counted.filter((f) => f['staffIds'] === undefined);
    expect(chipCalls).toHaveLength(7);
  });

  it('keeps its staffId as ONE id: the comma list is the calendar’s', async () => {
    const { reads } = await agenda({ staffId: 'maya,reem' });

    expect(reads.statusWindow).toMatchObject({ staffIds: ['maya,reem'] });
  });
});

// ------------------------------------------------------------ staff lists

/**
 * THE DENOMINATOR FOLLOWS THE LIST.
 *
 * One 120-minute booking against the fixture's shifts: anya 540, maya 600,
 * reem 480, lina 600, sara 240, tara 720 -- 3180 for the salon. Maya alone
 * reads 120/600; Maya and Reem read 120/1080; the salon reads 120/3180.
 */
const ROSTER = [
  ['anya', 600, 1140],
  ['maya', 660, 1260],
  ['reem', 600, 1080],
  ['lina', 720, 1320],
  ['sara', 600, 840],
  ['tara', 600, 1320],
].map(([id, startMin, endMin]) => ({
  id: id as string,
  name: `${id as string} n.`,
  shift: { startMin: startMin as number, endMin: endMin as number },
}));

const ONE_BOOKING = {
  id: 'b-1',
  code: 'GS-1',
  branch_id: 'x',
  customer_id: 'c-1',
  status: 'confirmed',
  payment_status: 'none_required',
  trading_day: new Date('2026-09-21T00:00:00Z'),
  start_at: new Date('2026-09-21T06:00:00Z'),
  start_minute: 720,
  duration_min: 120,
  price_fils: 18_000,
  deposit_fils: 0,
  requirement_source: null,
  channel: 'desk',
  move_count: 0,
  overbooked: false,
  overbook_reason: null,
  group_id: null,
  link_expires_at: null,
  reminded_24h_at: null,
  reminded_3h_at: null,
  nudged_15m_at: null,
  service_names: ['Haircut and finish'],
  staff_ids: ['8d820e0c-0250-8c4f-a883-f033c54c8f03'],
  resource_types: ['styling'],
};

class FakeGridReads {
  window: Record<string, unknown> | null = null;
  dailyWindow: Record<string, unknown> | null = null;

  list(f: Record<string, unknown>): Promise<unknown[]> {
    this.window = f;
    return Promise.resolve([ONE_BOOKING]);
  }
  dailyTotals(f: Record<string, unknown>): Promise<[]> {
    this.dailyWindow = f;
    return Promise.resolve([]);
  }
  walkInPressure(): Promise<{ waiting: number; longestWaitMin: number }> {
    return Promise.resolve({ waiting: 0, longestWaitMin: 0 });
  }
  openConflicts(): Promise<[]> {
    return Promise.resolve([]);
  }
  conflictsFor(): Promise<Map<string, never>> {
    return Promise.resolve(new Map<string, never>());
  }
}

function gridHandler() {
  const reads = new FakeGridReads();
  const context = {
    loadDay: () =>
      Promise.resolve({
        professionals: ROSTER,
        staffBookings: new Map(),
        resources: [],
        occupations: [],
      }),
  };
  const customers = {
    load: (customerId: string) => Promise.resolve({ customerId, name: null }),
  };
  const handler = new BookingReadHandler(
    reads as unknown as ReadModelRepository,
    context as unknown as BookingContextReader,
    customers as unknown as CustomerContextReader,
  );
  return { reads, handler };
}

type Grid = {
  columns: { staffId: string }[];
  kpis: { utilisation: number };
};

async function day(staffId?: string, serviceId?: string) {
  const { reads, handler } = gridHandler();
  const body = (await handler.day('marina-walk', '2026-09-21', {
    staffId,
    serviceId,
  })) as Grid;
  return { reads, body, columns: body.columns.map((c) => c.staffId) };
}

describe('day() staff and service lists', () => {
  it('reads one stylist exactly as before: her column, her minutes', async () => {
    const { reads, body, columns } = await day('maya');

    expect(reads.window).toMatchObject({ staffIds: ['maya'] });
    expect(columns).toEqual(['maya']);
    expect(body.kpis.utilisation).toBe(0.2);
  });

  it('narrows the denominator to the CHOSEN stylists, not the salon', async () => {
    const { reads, body, columns } = await day('maya,reem');

    expect(reads.window).toMatchObject({ staffIds: ['maya', 'reem'] });
    expect(columns).toEqual(['maya', 'reem']);
    expect(body.kpis.utilisation).toBe(Number((120 / 1080).toFixed(4)));
  });

  it('answers to either spelling of a stylist within one list', async () => {
    // reem's folded uuid, as the booking columns hold it, beside a slug.
    const { columns } = await day('63d86eee-36f7-89fc-aacb-4c5d87bf8db4,maya');

    expect(columns).toEqual(['maya', 'reem']);
  });

  it('lets an unknown id add nobody, and no minutes', async () => {
    expect((await day('maya,ghost')).body.kpis.utilisation).toBe(0.2);

    const ghost = await day('ghost');
    expect(ghost.columns).toEqual([]);
    expect(ghost.body.kpis.utilisation).toBe(0);
  });

  it('reads an empty list as no filter: the whole salon', async () => {
    for (const blank of [undefined, ',', ' , ']) {
      const { reads, body, columns } = await day(blank);

      expect(reads.window).not.toHaveProperty('staffIds');
      expect(columns).toHaveLength(6);
      expect(body.kpis.utilisation).toBe(Number((120 / 3180).toFixed(4)));
    }
  });

  it('hands services down as a list beside the staff', async () => {
    const { reads } = await day('maya', 'full-colour, blow-dry');

    expect(reads.window).toMatchObject({
      staffIds: ['maya'],
      serviceIds: ['full-colour', 'blow-dry'],
    });
  });
});

describe('week() staff lists', () => {
  it('sums the chosen stylists’ minutes on each of the seven days', async () => {
    const { reads, handler } = gridHandler();
    const body = (await handler.week('marina-walk', '2026-09-21', {
      staffId: 'maya,reem',
    })) as Grid;

    expect(reads.dailyWindow).toMatchObject({ staffIds: ['maya', 'reem'] });
    expect(body.kpis.utilisation).toBe(Number((120 / (7 * 1080)).toFixed(4)));
  });
});

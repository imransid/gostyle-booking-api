import { describe, expect, it, vi } from 'vitest';
import { MobileRoutineBookingViewHandler } from './mobile-routine-booking-view.handler';
import { MobileSeriesReadHandler } from './mobile-series-read.handler';
import { MobileBookingHandler } from '@application/commands/mobile-booking.handler';
import { isMobileContractError } from '@application/commands/mobile-booking.error';
import { TenantContext } from '@infrastructure/tenancy/tenant-context';
import { toUuid } from '@infrastructure/persistence/hold.repository';

/**
 * STEP B7 (gostyle-customer-api docs/ROUTINE_FE_CONTRACT_AUDIT.md): the
 * routine as one booking.
 *
 * THE REAL READS, over one set of rows: the routine read
 * (MobileSeriesReadHandler) and the single read (MobileBookingHandler) are
 * the real classes, with only the database, the quote and the roster faked.
 * So "the routine is the sum of its visits exactly as each reads" is checked
 * against the single read itself, not against a copy of its arithmetic.
 */

const SERIES = 'aaaaaaaa-0000-4aaa-8aaa-aaaaaaaaaaaa';
const CUSTOMER = '11111111-1111-4111-8111-111111111111';
const STRANGER = '33333333-3333-4333-8333-333333333333';
/** 2026-10-20 09:00 at the branch (UTC+6). */
const NOW = Date.UTC(2026, 9, 20, 3, 0);
const owner = { actorId: CUSTOMER, actorKind: 'customer', actorBranchId: null };

/** Every visit costs AED 105: 100 net, 5 VAT. */
const QUOTE = {
  durationMin: 45,
  subtotalMinor: 10_000,
  vatMinor: 500,
  tierDiscountMinor: 0,
  bundleDiscountMinor: 0,
  totalMinor: 10_500,
  depositMinor: 0,
};

const bookingId = (n: number) => `b0000000-0000-4000-8000-00000000000${n}`;

interface Visit {
  readonly n: number;
  readonly day: string;
  readonly status: string;
  readonly paymentStatus?: string;
  readonly ledger?: { entryType: string; amountFils: number; rail: string }[];
}

/** One booking row, as both reads get it from the database. */
const bookingRow = (v: Visit) => ({
  id: bookingId(v.n),
  code: `GS-${v.n}`,
  tenantId: null,
  branchId: toUuid('marina-walk'),
  customerId: CUSTOMER,
  status: v.status,
  paymentStatus: v.paymentStatus ?? 'none_required',
  bookingType: 'routine',
  tradingDay: new Date(`${v.day}T00:00:00Z`),
  startMinute: 990,
  durationMin: 45,
  priceFils: 10_000,
  depositFils: 0,
  netFils: 10_000,
  taxFils: 500,
  discountFils: 0,
  createdAt: new Date('2026-10-01T05:00:00Z'),
  linkExpiresAt: null,
  items: [
    {
      serviceId: toUuid('haircut-finish'),
      serviceName: 'Haircut & finish',
      priceFils: 10_000,
      staffId: toUuid('maya'),
    },
  ],
  products: [] as { priceFils: number; quantity: number }[],
  ledger: v.ledger ?? [],
});

interface Session {
  readonly day: string;
  readonly state: string;
  readonly visit?: Visit;
}

function build(sessions: readonly Session[]) {
  const occurrences = sessions.map((s, index) => ({
    id: `occ-${index}`,
    index,
    plannedDay: new Date(`${s.day}T00:00:00Z`),
    plannedStartMin: 990,
    state: s.state,
    bookingId: s.visit === undefined ? null : bookingId(s.visit.n),
  }));
  const series = {
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
    pausedUntil: null,
    pauseReason: null,
    pauseNote: null,
    createdAt: new Date('2026-10-01T05:00:00Z'),
    occurrences,
  };
  const rows = sessions.flatMap((s) => (s.visit ? [bookingRow(s.visit)] : []));

  const prisma = {
    bookingSeries: {
      findUnique: vi.fn(() => Promise.resolve(series)),
      findMany: vi.fn(() => Promise.resolve([series])),
    },
    booking: { findMany: vi.fn(() => Promise.resolve(rows)) },
    bookingStatusHistory: {
      findMany: vi.fn(() =>
        Promise.resolve(
          rows
            .filter((r) => r.status === 'no_show')
            .map((r) => ({ bookingId: r.id, actorKind: 'staff' })),
        ),
      ),
    },
  };
  const context = {
    loadDay: vi.fn(() =>
      Promise.resolve({
        professionals: [{ id: 'maya', name: 'Maya', bookingsToday: 0 }],
        staffBookings: new Map(),
      }),
    ),
    loadCatalogue: vi.fn(() =>
      Promise.resolve([{ id: 'haircut-finish', name: 'Haircut & finish' }]),
    ),
  };
  const quotes = { execute: vi.fn(() => Promise.resolve(QUOTE)) };
  const tenants = new TenantContext();

  const reads = new MobileSeriesReadHandler(
    prisma as never,
    tenants,
    context as never,
  );
  const single = new MobileBookingHandler(
    {} as never,
    {} as never,
    {} as never,
    quotes as never,
    {
      detail: (id: string) =>
        Promise.resolve(rows.find((r) => r.id === id) ?? null),
    } as never,
    {} as never,
    tenants,
    {} as never,
    context as never,
    { enabled: () => false } as never,
  );
  const view = new MobileRoutineBookingViewHandler(
    reads,
    single,
    quotes as never,
    tenants,
  );
  /** What the single read itself says about one visit. */
  const readVisit = (n: number) =>
    single.read({ ...owner, bookingId: bookingId(n) }) as Promise<
      Record<string, number | string | null>
    >;
  return { view, reads, readVisit, quotes };
}

/** Done and paid at the desk, skipped, booked, planned (past the 90 days). */
const FOUR: readonly Session[] = [
  {
    day: '2026-10-06',
    state: 'materialised',
    visit: {
      n: 0,
      day: '2026-10-06',
      status: 'completed',
      paymentStatus: 'fully_paid',
      // The desk's capture takes price_fils, the NET price (audit F8).
      ledger: [{ entryType: 'captured', amountFils: 10_000, rail: 'cash' }],
    },
  },
  {
    day: '2026-10-13',
    state: 'skipped',
    visit: { n: 1, day: '2026-10-13', status: 'cancelled' },
  },
  {
    day: '2026-10-27',
    state: 'materialised',
    visit: { n: 2, day: '2026-10-27', status: 'confirmed' },
  },
  { day: '2027-02-02', state: 'planned' },
];

// ------------------------------------------------------------ money

describe('B7 money: the routine is the sum of its visits, exactly as each reads', () => {
  it('done and paid at the desk, skipped, booked, planned: the right total, advance and due', async () => {
    const { view } = build(FOUR);
    const r = await view.read(SERIES, owner, NOW);
    expect({
      amount_without_tax: r.amount_without_tax,
      tax_amount: r.tax_amount,
      discount: r.discount,
      total: r.total,
      advance_paid_amount: r.advance_paid_amount,
      due_amount: r.due_amount,
      payment_status: r.payment_status,
    }).toStrictEqual({
      // 100 + 100 + 100: the done one, the booked one, the planned one.
      amount_without_tax: 300,
      tax_amount: 15,
      discount: 0,
      total: 315,
      // What the desk took: the net 100 (F8).
      advance_paid_amount: 100,
      // 5 (the VAT the done one still shows) + 105 + 105.
      due_amount: 215,
      payment_status: 'PAY_AFTER_CHECK_IN',
    });
  });

  it('never disagrees with the single read of each visit', async () => {
    const { view, readVisit } = build(FOUR);
    const r = await view.read(SERIES, owner, NOW);
    const [done, booked] = [await readVisit(0), await readVisit(2)];
    // The planned one is today's price, fully due.
    const planned = { total: 105, advance_paid_amount: 0, due_amount: 105 };
    for (const key of ['total', 'advance_paid_amount', 'due_amount'] as const) {
      expect(r[key]).toBe(
        (done[key] as number) + (booked[key] as number) + planned[key],
      );
    }
    // And each session's own total is its visit's.
    expect(r.sessions[0]!.total).toBe(done.total);
    expect(r.sessions[2]!.total).toBe(booked.total);
    expect(r.sessions[3]!.total).toBe(105);
  });

  it('a missed visit adds nothing, though its own read says it is due', async () => {
    const { view, readVisit } = build([
      FOUR[0]!,
      {
        day: '2026-10-13',
        state: 'materialised',
        visit: { n: 1, day: '2026-10-13', status: 'no_show' },
      },
      FOUR[2]!,
    ]);
    const missed = await readVisit(1);
    expect(missed).toMatchObject({ status: 'CANCELLED', due_amount: 105 });
    const r = await view.read(SERIES, owner, NOW);
    expect(r.sessions[1]!.state).toBe('MISSED');
    expect([r.total, r.advance_paid_amount, r.due_amount]).toStrictEqual([
      210, 100, 110,
    ]);
  });

  it('a skipped session with no booking adds nothing either', async () => {
    const { view, quotes } = build([
      FOUR[2]!,
      { day: '2027-02-02', state: 'skipped' },
    ]);
    const r = await view.read(SERIES, owner, NOW);
    expect([r.total, r.due_amount]).toStrictEqual([105, 105]);
    expect(r.sessions[1]!.total).toBeNull();
    // Only the visit's own read was priced; nothing for the skipped one.
    expect(quotes.execute).toHaveBeenCalledTimes(1);
  });
});

// ------------------------------------------------------------ the top

describe('B7 top: date, start and end of the next session, else the last one', () => {
  it('follows the next session still to come, with its pass', async () => {
    const { view } = build(FOUR);
    const r = await view.read(SERIES, owner, NOW);
    expect([r.date, r.start_time, r.end_time, r.pass_qr_code]).toStrictEqual([
      '2026-10-27',
      '2026-10-27T16:30:00+06:00',
      '2026-10-27T17:15:00+06:00',
      'GS-2',
    ]);
  });

  it('the next one not booked yet: its planned time, the end from its length, no pass', async () => {
    const { view } = build([FOUR[0]!, FOUR[1]!, FOUR[3]!]);
    const r = await view.read(SERIES, owner, NOW);
    expect([r.date, r.start_time, r.end_time, r.pass_qr_code]).toStrictEqual([
      '2027-02-02',
      '2027-02-02T16:30:00+06:00',
      '2027-02-02T17:15:00+06:00',
      null,
    ]);
  });

  it('none left: the last session of the routine', async () => {
    const { view } = build([
      FOUR[0]!,
      {
        day: '2026-10-13',
        state: 'materialised',
        visit: { n: 1, day: '2026-10-13', status: 'completed' },
      },
    ]);
    const r = await view.read(SERIES, owner, NOW);
    expect([r.date, r.start_time, r.end_time, r.pass_qr_code]).toStrictEqual([
      '2026-10-13',
      '2026-10-13T16:30:00+06:00',
      '2026-10-13T17:15:00+06:00',
      'GS-1',
    ]);
  });
});

// ------------------------------------------------------------ the shape

describe('B7 shape: the routine as one booking (draft §3 and §5)', () => {
  it("the whole object, on booking-api's words and clock", async () => {
    const { view } = build(FOUR);
    expect(await view.read(SERIES, owner, NOW)).toMatchSnapshot();
  });

  it('the fields asked for, and those only', async () => {
    const { view } = build(FOUR);
    const r = await view.read(SERIES, owner, NOW);
    expect(Object.keys(r)).toStrictEqual([
      'id',
      'booking_type',
      'salon_id',
      'status',
      'frequency',
      'date',
      'start_time',
      'end_time',
      'services',
      'products',
      'stylists',
      'amount_without_tax',
      'tax_amount',
      'discount',
      'total',
      'promo_code',
      'advance_paid_amount',
      'due_amount',
      'payment_status',
      'payment_method',
      'pass_qr_code',
      'counts',
      'pause',
      'can',
      'sessions',
      'created_at',
    ]);
    expect(Object.keys(r.sessions[0]!)).toStrictEqual([
      'id',
      'index',
      'date',
      'start_time',
      'end_time',
      'state',
      'stylist',
      'booking_id',
      'pass_qr_code',
      'total',
      'locked',
      'can_skip',
      'can_reschedule',
    ]);
    expect(r).toMatchObject({
      booking_type: 'ROUTINE',
      status: 'ACTIVE',
      frequency: 'WEEKLY',
      services: [
        { id: 'haircut-finish', name: 'Haircut & finish', amount: 100 },
      ],
      products: [],
      stylists: [{ id: 'maya', name: 'Maya', avatar_url: null }],
      promo_code: null,
      payment_method: null,
    });
  });

  it('the list: each row is that same object', async () => {
    const { view } = build(FOUR);
    const one = await view.read(SERIES, owner, NOW);
    const page = await view.list(CUSTOMER, { page: 1, pageSize: 20 }, NOW);
    expect(page.count).toBe(1);
    expect(page.results).toStrictEqual([one]);
  });

  it("somebody else's routine is 404, never 403", async () => {
    const { view } = build(FOUR);
    const answer = await view
      .read(SERIES, { ...owner, actorId: STRANGER }, NOW)
      .then(
        () => 'read',
        (e: unknown) => e,
      );
    expect(isMobileContractError(answer) && answer.status).toBe(404);
  });
});

// ------------------------------------------------------------ nothing added

describe('B7: a session that adds nothing shows no total and no pass', () => {
  it('skipped, cancelled at the desk, missed: total and pass null, booking_id kept', async () => {
    const { view, readVisit } = build([
      FOUR[1]!,
      {
        day: '2026-10-15',
        state: 'materialised',
        visit: { n: 3, day: '2026-10-15', status: 'cancelled' },
      },
      {
        day: '2026-10-16',
        state: 'materialised',
        visit: { n: 4, day: '2026-10-16', status: 'no_show' },
      },
      FOUR[2]!,
    ]);
    const r = await view.read(SERIES, owner, NOW);
    expect(
      r.sessions.map((s) => [s.state, s.booking_id, s.total, s.pass_qr_code]),
    ).toStrictEqual([
      ['SKIPPED', bookingId(1), null, null],
      ['CANCELLED', bookingId(3), null, null],
      ['MISSED', bookingId(4), null, null],
      ['SCHEDULED', bookingId(2), 105, 'GS-2'],
    ]);
    // Each visit's own read still has its pass: only the routine hides it.
    expect((await readVisit(3)).pass_qr_code).toBe('GS-3');
  });

  it('none left and the last one adds nothing: no pass at the top either', async () => {
    const { view } = build([
      FOUR[0]!,
      {
        day: '2026-10-13',
        state: 'materialised',
        visit: { n: 1, day: '2026-10-13', status: 'cancelled' },
      },
    ]);
    const r = await view.read(SERIES, owner, NOW);
    expect([r.date, r.pass_qr_code]).toStrictEqual(['2026-10-13', null]);
  });
});

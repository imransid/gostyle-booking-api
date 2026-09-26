import { describe, expect, it, vi } from 'vitest';
import {
  MobileSeriesHandler,
  type MobileSeriesCommand,
  type MobileSeriesPreview,
} from './mobile-series.handler';
import {
  MobileContractError,
  isMobileContractError,
} from './mobile-booking.error';
import type { RoutineClaim } from '@domain/booking/mobile-series-contract';

/**
 * HANDLER SPEC: orchestration only, every collaborator faked.
 *
 * What it pins: every session goes through the single create unchanged, a
 * busy session is never moved (D4), products ride on the first session
 * only (D7), and a failure part way through leaves nothing behind.
 */

/** 2026-10-01 09:00 at the branch (UTC+6). 2026-10-06 is a Tuesday. */
const NOW = Date.UTC(2026, 9, 1, 3, 0);
const CUSTOMER = '11111111-1111-4111-8111-111111111111';

type Starts = Readonly<Record<string, readonly number[]>>;

/** Who is free when, per day. Unlisted days: maya and rana all day long. */
interface Diary {
  readonly closed?: readonly string[];
  readonly starts?: Readonly<Record<string, Starts>>;
}

const ALL_DAY = [900, 930, 960, 990, 1020, 1050, 1080];

function viewFor(day: string, diary: Diary) {
  if (diary.closed?.includes(day)) {
    return { offers: [], closureReason: 'Closed' };
  }
  const who: Starts = diary.starts?.[day] ?? { maya: ALL_DAY, rana: ALL_DAY };
  const minutes = [...new Set(Object.values(who).flat())].sort((a, b) => a - b);
  return {
    offers: minutes.map((m) => ({
      startMin: m,
      staff: Object.entries(who)
        .filter(([, starts]) => starts.includes(m))
        .map(([id]) => ({ id, name: id })),
    })),
  };
}

const QUOTE = {
  subtotalMinor: 10_000,
  vatMinor: 500,
  tierDiscountMinor: 0,
  bundleDiscountMinor: 0,
  totalMinor: 10_500,
  durationMin: 45,
  depositMinor: 0,
};

function harness(
  over: {
    diary?: Diary;
    /** The single create fails on the session of this day. */
    failOn?: { day: string; error: Error };
    repoFails?: boolean;
    productsOn?: boolean;
  } = {},
) {
  const single = {
    execute: vi.fn((cmd: { date: string }) =>
      over.failOn?.day === cmd.date
        ? Promise.reject(over.failOn.error)
        : Promise.resolve({ id: `booking-${cmd.date}` }),
    ),
  };
  const availability = {
    execute: vi.fn((q: { tradingDay: string }) =>
      Promise.resolve(viewFor(q.tradingDay, over.diary ?? {})),
    ),
  };
  const quotes = { execute: vi.fn(() => Promise.resolve(QUOTE)) };
  const lifecycle = {
    transition: vi.fn((_input: unknown) =>
      Promise.resolve({ kind: 'transitioned' }),
    ),
  };
  const repo = {
    create: vi.fn((_input: unknown) =>
      over.repoFails === true
        ? Promise.reject(new Error('database said no'))
        : Promise.resolve({ seriesId: 'series-1' }),
    ),
  };
  const reads = {
    afterCreate: vi.fn((id: string) =>
      Promise.resolve({ id, booking_type: 'ROUTINE' }),
    ),
  };
  const context = {
    loadServices: vi.fn((_b: string, ids: readonly string[]) =>
      Promise.resolve(
        ids
          .filter((id) => id !== 'nope')
          .map((id) => ({ id, name: id, durationMin: 45, currency: 'AED' })),
      ),
    ),
  };
  const productCatalogue = {
    enabled: () => over.productsOn === true,
    resolve: vi.fn(() =>
      Promise.resolve(
        new Map([
          [
            'pomade-100',
            {
              variantId: 'pomade-100',
              productName: 'Pomade',
              variantName: '100ml',
              priceMinor: 2_000,
              currency: 'AED',
              tracked: false,
              available: 0,
            },
          ],
        ]),
      ),
    ),
  };

  const handler = new MobileSeriesHandler(
    single as never,
    availability as never,
    quotes as never,
    lifecycle as never,
    repo as never,
    reads as never,
    context as never,
    productCatalogue as never,
  );
  return { handler, single, availability, lifecycle, repo, reads };
}

const claim = (over: Partial<RoutineClaim> = {}): RoutineClaim => ({
  dryRun: false,
  serviceIds: ['haircut-finish'],
  stylistId: 'maya',
  frequency: 'WEEKLY',
  startDate: '2026-10-06',
  sessions: 3,
  dates: null,
  time: '16:30',
  paymentPlan: 'PAY_AT_SALON',
  picks: [],
  ...over,
});

const RIGHT_MONEY = {
  amountWithoutTax: 300,
  taxAmount: 15,
  discount: 0,
  total: 315,
};

const command = (
  over: Partial<RoutineClaim> = {},
  rest: Partial<MobileSeriesCommand> = {},
): MobileSeriesCommand => ({
  salonId: 'marina-walk',
  customerId: CUSTOMER,
  claim: claim(over),
  products: [],
  money: RIGHT_MONEY,
  depositPercent: 20,
  nowMs: NOW,
  ...rest,
});

async function refusal(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    if (isMobileContractError(e)) {
      return { status: e.status, ...e.errors[0]! };
    }
    throw e;
  }
  throw new Error('expected a refusal');
}

// ------------------------------------------------------------ dry run

describe('dry_run without a time', () => {
  it('answers the times free on EVERY day, and books nothing', async () => {
    const { handler, single, repo } = harness({
      diary: {
        starts: {
          '2026-10-06': { maya: [960, 990, 1020] },
          '2026-10-13': { maya: [990, 1020], rana: [960] },
          '2026-10-20': { maya: [990, 1080] },
        },
      },
    });
    const out = (await handler.execute(
      command({ dryRun: true, time: null }),
    )) as MobileSeriesPreview;

    expect(out.available_times).toEqual(['16:30']);
    expect(out.sessions.map((s) => s.date)).toEqual([
      '2026-10-06',
      '2026-10-13',
      '2026-10-20',
    ]);
    expect(out.money).toBeNull();
    expect(single.execute).not.toHaveBeenCalled();
    expect(repo.create).not.toHaveBeenCalled();
  });
});

describe('dry_run with a time', () => {
  it('every session free: the sessions, the money for three plans, the rules', async () => {
    const { handler, single, repo } = harness();
    const out = (await handler.execute(
      command({ dryRun: true }, { money: null }),
    )) as MobileSeriesPreview;

    expect(out.all_free).toBe(true);
    expect(out.sessions[0]).toMatchObject({
      index: 0,
      date: '2026-10-06',
      start_time: '2026-10-06T16:30:00+06:00',
      end_time: '2026-10-06T17:15:00+06:00',
      free: true,
      later: false,
      alternatives: [],
    });
    expect(out.money!.plans.PAY_AT_SALON).toMatchObject({
      available: true,
      amount_without_tax: 300,
      tax_amount: 15,
      total: 315,
      pay_now: 0,
    });
    // D2: shown, not bookable. 20% of each 105.00 session.
    expect(out.money!.plans.PAY_AS_YOU_GO).toMatchObject({
      available: false,
      pay_now: 63,
    });
    // D8: 10% off 300 of services, VAT 5% on 270.
    expect(out.money!.plans.UPFRONT).toMatchObject({
      available: false,
      discount: 30,
      tax_amount: 13.5,
      total: 283.5,
    });
    expect(out.rules).toMatchObject({ lock_hours: 24, max_sessions: 6 });
    expect(single.execute).not.toHaveBeenCalled();
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('D4: a busy session is shown busy with alternatives, never moved', async () => {
    const { handler } = harness({
      diary: { starts: { '2026-10-13': { maya: [1020], rana: [990] } } },
    });
    const out = (await handler.execute(
      command({ dryRun: true }),
    )) as MobileSeriesPreview;

    expect(out.all_free).toBe(false);
    const busy = out.sessions[1]!;
    expect(busy).toMatchObject({ date: '2026-10-13', free: false });
    expect(busy.start_time).toBe('2026-10-13T16:30:00+06:00');
    // Same stylist same day, then the same time with someone else, then
    // the same stylist and time the nearest other day (never the day of
    // another session: the 6th and the 20th are taken by the routine).
    expect(busy.alternatives).toEqual([
      {
        date: '2026-10-13',
        time: '17:00',
        start_time: '2026-10-13T17:00:00+06:00',
        stylist_id: 'maya',
      },
      {
        date: '2026-10-13',
        time: '16:30',
        start_time: '2026-10-13T16:30:00+06:00',
        stylist_id: 'rana',
      },
      {
        date: '2026-10-12',
        time: '16:30',
        start_time: '2026-10-12T16:30:00+06:00',
        stylist_id: 'maya',
      },
    ]);
  });

  it('D3: DAILY skips the days the salon is closed', async () => {
    const { handler } = harness({ diary: { closed: ['2026-10-05'] } });
    const out = (await handler.execute(
      command({ dryRun: true, frequency: 'DAILY', startDate: '2026-10-04' }),
    )) as MobileSeriesPreview;
    expect(out.sessions.map((s) => s.date)).toEqual([
      '2026-10-04',
      '2026-10-06',
      '2026-10-07',
    ]);
  });

  it('a closed day on a WEEKLY routine is a busy session, not a moved one', async () => {
    const { handler } = harness({ diary: { closed: ['2026-10-13'] } });
    const out = (await handler.execute(
      command({ dryRun: true }),
    )) as MobileSeriesPreview;
    expect(out.sessions[1]).toMatchObject({ date: '2026-10-13', free: false });
  });

  it('past the 90 day horizon: shown as later, not checked', async () => {
    const { handler, availability } = harness();
    const out = (await handler.execute(
      command({
        dryRun: true,
        frequency: 'MONTHLY',
        startDate: '2026-10-15',
        sessions: 4,
      }),
    )) as MobileSeriesPreview;
    expect(out.sessions.map((s) => [s.date, s.later, s.free])).toEqual([
      ['2026-10-15', false, true],
      ['2026-11-15', false, true],
      ['2026-12-15', false, true],
      ['2027-01-15', true, null],
    ]);
    const asked = availability.execute.mock.calls.map((c) => c[0].tradingDay);
    expect(asked).not.toContain('2027-01-15');
  });
});

// ------------------------------------------------------------ create

describe('create', () => {
  it('books every session through the single create, unchanged, then writes the routine', async () => {
    const { handler, single, repo, reads } = harness();
    const out = await handler.execute(command());

    expect(single.execute).toHaveBeenCalledTimes(3);
    expect(single.execute.mock.calls[0]![0]).toEqual({
      salonId: 'marina-walk',
      services: [{ id: 'haircut-finish', amount: 0 }],
      products: undefined,
      stylists: ['maya'],
      date: '2026-10-06',
      startTime: '2026-10-06T16:30:00+06:00',
      endTime: '2026-10-06T17:15:00+06:00',
      amountWithoutTax: 100,
      taxAmount: 5,
      discount: 0,
      promoCode: null,
      total: 105,
      advancePaidAmount: 0,
      dueAmount: 105,
      paymentStatus: 'PAY_AFTER_CHECK_IN',
      status: 'BOOKED',
      bookingType: 'SINGLE',
      customerId: CUSTOMER,
      idempotencyKey: undefined,
    });

    expect(repo.create).toHaveBeenCalledWith({
      branchId: 'marina-walk',
      customerId: CUSTOMER,
      frequency: 'weekly',
      serviceIds: ['haircut-finish'],
      stylistId: 'maya',
      startMin: 990,
      paymentPlan: 'pay_at_salon',
      baselinePriceFils: 10_000,
      sessions: [
        {
          index: 0,
          day: '2026-10-06',
          startMin: 990,
          movedFromDayOfMonth: null,
          bookingId: 'booking-2026-10-06',
        },
        {
          index: 1,
          day: '2026-10-13',
          startMin: 990,
          movedFromDayOfMonth: null,
          bookingId: 'booking-2026-10-13',
        },
        {
          index: 2,
          day: '2026-10-20',
          startMin: 990,
          movedFromDayOfMonth: null,
          bookingId: 'booking-2026-10-20',
        },
      ],
    });
    expect(reads.afterCreate).toHaveBeenCalledWith('series-1', NOW);
    expect(out).toEqual({ id: 'series-1', booking_type: 'ROUTINE' });
  });

  it('D2: PAY_AS_YOU_GO and UPFRONT are refused, and nothing is booked', async () => {
    for (const paymentPlan of ['PAY_AS_YOU_GO', 'UPFRONT']) {
      const { handler, single } = harness();
      expect(
        await refusal(handler.execute(command({ paymentPlan }))),
      ).toMatchObject({
        status: 422,
        code: 'payment_plan_not_available',
      });
      expect(single.execute).not.toHaveBeenCalled();
    }
  });

  it('D4: a busy session refuses the create with 409, before anything is booked', async () => {
    const { handler, single, repo } = harness({
      diary: { starts: { '2026-10-13': { rana: [990] } } },
    });
    expect(await refusal(handler.execute(command()))).toMatchObject({
      status: 409,
      field: 'sessions[1]',
      code: 'session_not_free',
    });
    expect(single.execute).not.toHaveBeenCalled();
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('D4: with a pick for the busy session, it is booked at the pick', async () => {
    const { handler, single, repo } = harness({
      diary: { starts: { '2026-10-13': { maya: [1020] } } },
    });
    await handler.execute(
      command({
        picks: [
          { index: 1, date: '2026-10-13', time: '17:00', stylistId: null },
        ],
      }),
    );
    const second = single.execute.mock.calls[1]![0] as unknown as {
      startTime: string;
    };
    expect(second.startTime).toBe('2026-10-13T17:00:00+06:00');
    const input = repo.create.mock.calls[0]![0] as {
      sessions: { index: number; startMin: number }[];
    };
    expect(input.sessions[1]).toMatchObject({ index: 1, startMin: 1020 });
  });

  it('the money is checked for the whole routine, with the right figure', async () => {
    const { handler, single } = harness();
    expect(
      await refusal(
        handler.execute(command({}, { money: { ...RIGHT_MONEY, total: 300 } })),
      ),
    ).toMatchObject({
      status: 422,
      field: 'total',
      code: 'amount_mismatch',
      expected: 315,
    });
    expect(single.execute).not.toHaveBeenCalled();
  });

  it('a create without the figures is told them', async () => {
    const { handler } = harness();
    expect(
      await refusal(handler.execute(command({}, { money: null }))),
    ).toMatchObject({ code: 'amount_mismatch', expected: 300 });
  });

  it('ALL OR NOTHING: session 3 fails, sessions 1 and 2 are cancelled again', async () => {
    const { handler, lifecycle, repo } = harness({
      failOn: {
        day: '2026-10-20',
        error: MobileContractError.slotTaken(
          'That start is no longer available.',
        ),
      },
    });
    expect(await refusal(handler.execute(command()))).toMatchObject({
      status: 409,
      field: 'sessions[2]',
      code: 'session_not_free',
    });
    expect(lifecycle.transition.mock.calls.map((c) => c[0])).toEqual(
      ['booking-2026-10-13', 'booking-2026-10-06'].map((bookingId) => ({
        bookingId,
        to: 'cancelled',
        actor: 'customer',
        actorId: CUSTOMER,
        reason:
          'The routine could not be booked in full, so this session was released.',
        initiatedBy: 'salon',
      })),
    );
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('ALL OR NOTHING: any other refusal is passed on as it is, after the rollback', async () => {
    const skill = MobileContractError.of(
      'stylists',
      'stylist_missing_skill',
      'Maya does not do this.',
    );
    const { handler, lifecycle } = harness({
      failOn: { day: '2026-10-13', error: skill },
    });
    expect(await refusal(handler.execute(command()))).toMatchObject({
      code: 'stylist_missing_skill',
    });
    expect(lifecycle.transition).toHaveBeenCalledTimes(1);
  });

  it('ALL OR NOTHING: the routine rows fail, every session is cancelled again', async () => {
    const { handler, lifecycle } = harness({ repoFails: true });
    await expect(handler.execute(command())).rejects.toThrow(
      'database said no',
    );
    expect(lifecycle.transition).toHaveBeenCalledTimes(3);
  });

  it('past the 90 day horizon: stored as planned, not booked', async () => {
    const { handler, single, repo } = harness();
    await handler.execute(
      command(
        { frequency: 'MONTHLY', startDate: '2026-10-15', sessions: 4 },
        {
          money: {
            amountWithoutTax: 400,
            taxAmount: 20,
            discount: 0,
            total: 420,
          },
        },
      ),
    );
    expect(single.execute).toHaveBeenCalledTimes(3);
    const input = repo.create.mock.calls[0]![0] as {
      sessions: { day: string; bookingId: string | null }[];
    };
    expect(input.sessions.map((s) => [s.day, s.bookingId])).toEqual([
      ['2026-10-15', 'booking-2026-10-15'],
      ['2026-11-15', 'booking-2026-11-15'],
      ['2026-12-15', 'booking-2026-12-15'],
      ['2027-01-15', null],
    ]);
  });

  it('D7: products go on the first session only', async () => {
    const { handler, single } = harness({ productsOn: true });
    await handler.execute(
      command(
        {},
        {
          products: [{ id: 'pomade-100', amount: 20 }],
          // 300 + 20 of product; VAT 15 + 1; total 336.
          money: {
            amountWithoutTax: 320,
            taxAmount: 16,
            discount: 0,
            total: 336,
          },
        },
      ),
    );
    const calls = single.execute.mock.calls.map(
      (c) => c[0] as unknown as { products?: unknown; total: number },
    );
    expect(calls[0]!.products).toEqual([{ id: 'pomade-100', amount: 20 }]);
    expect(calls[0]!.total).toBe(126);
    expect(calls[1]!.products).toBeUndefined();
    expect(calls[2]!.total).toBe(105);
  });

  it('products with the catalogue off are refused, as the single create does', async () => {
    const { handler } = harness();
    expect(
      await refusal(
        handler.execute(
          command({}, { products: [{ id: 'pomade-100', amount: 20 }] }),
        ),
      ),
    ).toMatchObject({ code: 'products_not_supported' });
  });

  it('a service the salon does not sell is unknown_service', async () => {
    const { handler } = harness();
    expect(
      await refusal(handler.execute(command({ serviceIds: ['nope'] }))),
    ).toMatchObject({ code: 'unknown_service' });
  });
});

import { describe, expect, it, vi } from 'vitest';
import {
  MobileSeriesHandler,
  type MobileSeriesCommand,
  type MobileSeriesPreview,
  type RoutineContractOptions,
} from './mobile-series.handler';
import {
  MobileContractError,
  isMobileContractError,
} from './mobile-booking.error';
import type { RoutineClaim } from '@domain/booking/mobile-series-contract';
import { MobileSeriesJobHandler } from './mobile-series-job.handler';
import { branchInstant } from '@infrastructure/persistence/hold.repository';

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

// ------------------------------------------------------------ B2

/**
 * STEP B2 (gostyle-customer-api docs/ROUTINE_FE_CONTRACT_AUDIT.md, 4.1):
 * sessions past the 90 day horizon, checked against today's calendar, only
 * when the contract says `check_later` (the flag is the controller's gate:
 * with it off, no option reaches the handler at all, B1).
 *
 * "AS BEFORE" IS RECORDED, NOT WRITTEN DOWN. The snapshots below were
 * recorded on the code before B2 (commit bb4dcbd). Every run without
 * check_later must still match them, whole: the answer, every single
 * create, the rows saved and anything released.
 */

/** The contract with every option off: exactly the old behaviour. */
const OPTIONS_OFF: RoutineContractOptions = {
  stylistCandidates: null,
  checkLater: false,
  withReasons: false,
  alternativeRule: null,
  alternativesMax: null,
  strictPicks: false,
};
const LATER: RoutineContractOptions = { ...OPTIONS_OFF, checkLater: true };

/**
 * MONTHLY from Tuesday 2026-10-06, six sessions: 10-06, 11-06 and 12-06
 * inside the 90 days (today is 2026-10-01); 2027-01-06 (97 days), 02-06 and
 * 03-06 past them.
 */
const SIX_MONTHLY: Partial<RoutineClaim> = {
  frequency: 'MONTHLY',
  startDate: '2026-10-06',
  sessions: 6,
};
const SIX_MONEY = {
  amountWithoutTax: 600,
  taxAmount: 30,
  discount: 0,
  total: 630,
};

/** Maya has nothing that day; Rana is free all day. */
const mayaOff = (...days: string[]): Diary => ({
  starts: Object.fromEntries(days.map((d) => [d, { rana: ALL_DAY }])),
});

/** Everything a run did: the answer or refusal, each single create, the rows. */
async function everything(
  h: ReturnType<typeof harness>,
  cmd: MobileSeriesCommand,
) {
  let answer: unknown;
  try {
    answer = await h.handler.execute(cmd);
  } catch (e) {
    if (!isMobileContractError(e)) throw e;
    answer = { status: e.status, errors: e.errors };
  }
  return {
    answer,
    booked: h.single.execute.mock.calls.map((c) => c[0]),
    saved: h.repo.create.mock.calls.map((c) => c[0]),
    released: h.lifecycle.transition.mock.calls.map((c) => c[0]),
  };
}

const AS_BEFORE: readonly (readonly [string, Diary, Partial<RoutineClaim>])[] =
  [
    ['preview, six monthly', {}, { ...SIX_MONTHLY, dryRun: true }],
    [
      'preview, maya busy on a near day and a far day',
      mayaOff('2026-11-06', '2027-01-06'),
      { ...SIX_MONTHLY, dryRun: true },
    ],
    ['create, six monthly', {}, SIX_MONTHLY],
    ['create, maya busy on a far day', mayaOff('2027-01-06'), SIX_MONTHLY],
    [
      'create, a far session picked past 90 days',
      {},
      {
        ...SIX_MONTHLY,
        picks: [
          { index: 3, date: '2027-01-07', time: '16:30', stylistId: null },
        ],
      },
    ],
    [
      'create, a far session picked inside 90 days',
      {},
      {
        ...SIX_MONTHLY,
        picks: [
          { index: 3, date: '2026-12-30', time: '17:00', stylistId: null },
        ],
      },
    ],
    [
      'preview, a near session busy on day 89',
      mayaOff('2026-12-29'),
      {
        frequency: 'MONTHLY',
        startDate: '2026-10-29',
        sessions: 4,
        dryRun: true,
      },
    ],
  ];

describe('B2 off: without check_later, exactly as before', () => {
  it.each(AS_BEFORE)('%s', async (_name, diary, over) => {
    const plain = await everything(
      harness({ diary }),
      command(over, { money: SIX_MONEY }),
    );
    const off = await everything(
      harness({ diary }),
      command(over, { money: SIX_MONEY, contract: OPTIONS_OFF }),
    );
    expect(off).toStrictEqual(plain);
    expect(plain).toMatchSnapshot();
  });
});

describe('B2 on: check_later, sessions past the 90 days', () => {
  const withLater = (over: Partial<RoutineClaim>, diary: Diary = {}) =>
    everything(
      harness({ diary }),
      command(over, { money: SIX_MONEY, contract: LATER }),
    );
  const asBefore = (over: Partial<RoutineClaim>, diary: Diary = {}) =>
    everything(harness({ diary }), command(over, { money: SIX_MONEY }));
  const sessionsOf = (r: { answer: unknown }) =>
    (r.answer as MobileSeriesPreview).sessions;

  // ---- 1. The preview

  it("checks a far session against today's calendar, like a near one, and holds nothing", async () => {
    const h = harness();
    const now = await everything(
      h,
      command({ ...SIX_MONTHLY, dryRun: true }, { contract: LATER }),
    );
    expect(sessionsOf(now).map((s) => [s.date, s.later, s.free])).toStrictEqual(
      [
        ['2026-10-06', false, true],
        ['2026-11-06', false, true],
        ['2026-12-06', false, true],
        ['2027-01-06', true, true],
        ['2027-02-06', true, true],
        ['2027-03-06', true, true],
      ],
    );
    const asked = h.availability.execute.mock.calls.map((c) => c[0].tradingDay);
    expect(asked).toEqual(
      expect.arrayContaining(['2027-01-06', '2027-02-06', '2027-03-06']),
    );
    expect(now.booked).toStrictEqual([]);
    expect(now.saved).toStrictEqual([]);
  });

  it("the rest of the preview is exactly as before: only a far session's `free` changes", async () => {
    const before = await asBefore({ ...SIX_MONTHLY, dryRun: true });
    const now = await withLater({ ...SIX_MONTHLY, dryRun: true });
    const blank = (r: { answer: unknown }) => ({
      ...(r.answer as MobileSeriesPreview),
      sessions: sessionsOf(r).map((s) => (s.later ? { ...s, free: null } : s)),
    });
    expect(blank(now)).toStrictEqual(blank(before));
  });

  it('a far session that is not free says so, with alternatives past the 90 days, all with its own stylist', async () => {
    const now = await withLater(
      { ...SIX_MONTHLY, dryRun: true },
      mayaOff('2027-01-06'),
    );
    const far = sessionsOf(now)[3]!;
    expect(far.free).toBe(false);
    expect(far.alternatives).toStrictEqual([
      {
        date: '2027-01-05',
        time: '16:30',
        start_time: '2027-01-05T16:30:00+06:00',
        stylist_id: 'maya',
      },
      {
        date: '2027-01-07',
        time: '16:30',
        start_time: '2027-01-07T16:30:00+06:00',
        stylist_id: 'maya',
      },
      {
        date: '2027-01-04',
        time: '16:30',
        start_time: '2027-01-04T16:30:00+06:00',
        stylist_id: 'maya',
      },
    ]);
    expect((now.answer as MobileSeriesPreview).all_free).toBe(false);
  });

  it('a near session never gets an alternative past the 90 days: exactly as before', async () => {
    const over: Partial<RoutineClaim> = {
      frequency: 'MONTHLY',
      startDate: '2026-10-29',
      sessions: 4,
      dryRun: true,
    };
    const before = await asBefore(over, mayaOff('2026-12-29'));
    const now = await withLater(over, mayaOff('2026-12-29'));
    const near = sessionsOf(now)[2]!;
    expect(near.date).toBe('2026-12-29');
    expect(near.free).toBe(false);
    expect(near).toStrictEqual(sessionsOf(before)[2]);
    expect(near.alternatives.every((a) => a.date <= '2026-12-30')).toBe(true);
    // Its far neighbour, 2027-01-29, is checked now.
    expect(sessionsOf(now)[3]!.free).toBe(true);
  });

  // ---- 2. Picks

  it('a far session may be picked past the 90 days, and the pick is checked like any', async () => {
    const now = await withLater(
      {
        ...SIX_MONTHLY,
        dryRun: true,
        picks: [
          { index: 3, date: '2027-01-07', time: '17:00', stylistId: null },
        ],
      },
      mayaOff('2027-01-06'),
    );
    expect(sessionsOf(now)[3]).toMatchObject({
      date: '2027-01-07',
      start_time: '2027-01-07T17:00:00+06:00',
      stylist_id: 'maya',
      picked: true,
      later: true,
      free: true,
    });
  });

  it('the pick is checked too: a far pick that is not free is not free', async () => {
    const now = await withLater(
      {
        ...SIX_MONTHLY,
        dryRun: true,
        picks: [
          { index: 3, date: '2027-01-07', time: '17:00', stylistId: null },
        ],
      },
      mayaOff('2027-01-06', '2027-01-07'),
    );
    expect(sessionsOf(now)[3]).toMatchObject({
      date: '2027-01-07',
      free: false,
    });
  });

  it.each([
    [
      'a pick past the 90 days for a NEAR session: refused, as before',
      { index: 2, date: '2027-01-07', time: '16:30', stylistId: null },
      'picks[0].date',
      'A pick is a day from today to 90 days ahead.',
    ],
    [
      "a far pick naming another stylist: a saved session keeps the routine's",
      { index: 3, date: '2027-01-07', time: '16:30', stylistId: 'rana' },
      'picks[0].stylist_id',
      "A session more than 90 days away keeps the routine's stylist until it is booked.",
    ],
    [
      'a pick more than 366 days ahead',
      { index: 5, date: '2027-10-05', time: '16:30', stylistId: null },
      'picks[0].date',
      'A pick is a day from today to 90 days ahead, or up to 366 days ahead for a session past them.',
    ],
  ])('%s', async (_name, pick, field, message) => {
    const now = await withLater({ ...SIX_MONTHLY, picks: [pick] });
    expect(now.answer).toStrictEqual({
      status: 422,
      errors: [{ field, code: 'invalid_pick', message }],
    });
    expect(now.booked).toStrictEqual([]);
    expect(now.saved).toStrictEqual([]);
  });

  it("a far pick naming the routine's own stylist is fine", async () => {
    const now = await withLater({
      ...SIX_MONTHLY,
      dryRun: true,
      picks: [
        { index: 3, date: '2027-01-07', time: '16:30', stylistId: 'maya' },
      ],
    });
    expect(sessionsOf(now)[3]).toMatchObject({
      date: '2027-01-07',
      free: true,
    });
  });

  it('a far session picked INSIDE the 90 days is booked now, exactly as before', async () => {
    const over: Partial<RoutineClaim> = {
      ...SIX_MONTHLY,
      picks: [{ index: 3, date: '2026-12-30', time: '17:00', stylistId: null }],
    };
    expect(await withLater(over)).toStrictEqual(await asBefore(over));
  });

  // ---- 3. The create

  it('books the near sessions exactly as before and saves the far ones PLANNED, at their own day and time', async () => {
    const before = await asBefore(SIX_MONTHLY);
    const now = await withLater(SIX_MONTHLY);
    expect(now).toStrictEqual(before);
    expect(now.booked.map((b) => b.date)).toStrictEqual([
      '2026-10-06',
      '2026-11-06',
      '2026-12-06',
    ]);
    const saved = now.saved[0] as {
      stylistId: string;
      sessions: { day: string; startMin: number; bookingId: string | null }[];
    };
    expect(saved.stylistId).toBe('maya');
    expect(saved.sessions.slice(3)).toMatchObject([
      { day: '2027-01-06', startMin: 990, bookingId: null },
      { day: '2027-02-06', startMin: 990, bookingId: null },
      { day: '2027-03-06', startMin: 990, bookingId: null },
    ]);
  });

  it('a far pick is saved at the picked day and time, and not booked', async () => {
    const now = await withLater(
      {
        ...SIX_MONTHLY,
        picks: [
          { index: 4, date: '2027-02-07', time: '17:00', stylistId: null },
        ],
      },
      mayaOff('2027-02-06'),
    );
    expect(now.booked).toHaveLength(3);
    const saved = now.saved[0] as {
      sessions: {
        index: number;
        day: string;
        startMin: number;
        bookingId: string | null;
      }[];
    };
    expect(saved.sessions[4]).toStrictEqual({
      index: 4,
      day: '2027-02-07',
      startMin: 1020,
      movedFromDayOfMonth: null,
      bookingId: null,
    });
    expect(now.answer).toMatchObject({ id: 'series-1' });
  });

  it.each([
    [
      'a far session that is not free and not picked',
      mayaOff('2027-01-06'),
      [],
    ],
    [
      'a far pick that is not free',
      mayaOff('2027-01-06', '2027-01-07'),
      [{ index: 3, date: '2027-01-07', time: '16:30', stylistId: null }],
    ],
  ] as const)(
    '%s is refused like a near one, and nothing is booked',
    async (_n, diary, picks) => {
      const now = await withLater({ ...SIX_MONTHLY, picks: [...picks] }, diary);
      expect(now.answer).toMatchObject({
        status: 409,
        errors: [{ field: 'sessions[3]', code: 'session_not_free' }],
      });
      expect(now.booked).toStrictEqual([]);
      expect(now.saved).toStrictEqual([]);
      expect(now.released).toStrictEqual([]);
    },
  );

  // ---- 4. The hourly job, unchanged

  it('the hourly job books each far session at its SAVED day and time, the picked one included', async () => {
    const made = await withLater(
      {
        ...SIX_MONTHLY,
        picks: [
          { index: 4, date: '2027-02-07', time: '17:00', stylistId: null },
        ],
      },
      mayaOff('2027-02-06'),
    );
    const saved = made.saved[0] as {
      stylistId: string;
      sessions: {
        index: number;
        day: string;
        startMin: number;
        bookingId: string | null;
      }[];
    };

    // The rows as they come back to the job (MobileSeriesReadHandler
    // .factsForJob): a planned row is its saved day and minute.
    const occurrences = saved.sessions.map((s) => ({
      id: `occ-${s.index}`,
      bookingId: s.bookingId,
      plannedStartMin: s.startMin,
    }));
    const facts = saved.sessions.map((s) => ({
      id: `occ-${s.index}`,
      index: s.index,
      day: s.day,
      startAtMs: branchInstant(s.day, s.startMin).getTime(),
      state: s.bookingId === null ? 'planned' : 'materialised',
      bookingStatus: s.bookingId === null ? null : 'confirmed',
      noShowBy: null,
    }));
    const bookSession = vi.fn((_input: unknown) => Promise.resolve('booked'));
    const job = new MobileSeriesJobHandler(
      {
        keepDeskAway: vi.fn().mockResolvedValue(0),
        openRoutines: vi.fn().mockResolvedValue([
          {
            id: 'S',
            customerId: CUSTOMER,
            status: 'active',
            pausedUntil: null,
          },
        ]),
        missStreakAfter: vi.fn().mockResolvedValue(null),
        claimPlanned: vi.fn().mockResolvedValue(true),
        writeEvents: vi.fn().mockResolvedValue(0),
        completeByJob: vi.fn().mockResolvedValue(true),
      } as never,
      {
        factsForJob: vi.fn().mockResolvedValue({
          series: {
            id: 'S',
            status: 'active',
            tenantId: 'T1',
            branchId: 'marina-walk',
            customerId: CUSTOMER,
            frequency: 'monthly',
            serviceIds: ['haircut-finish'],
            preferredStaffId: saved.stylistId,
            occurrences,
          },
          facts,
        }),
      } as never,
      { transition: vi.fn() } as never,
      { bookSession } as never,
      { run: (_t: unknown, f: () => unknown) => f() } as never,
    );

    // 2026-12-01 at the branch: 2027-01-06 and 2027-02-07 are inside the
    // 90 days now, 2027-03-06 is not yet.
    await job.run(Date.parse('2026-12-01T09:00:00+06:00'));
    expect(
      bookSession.mock.calls.map((c) => {
        const i = c[0] as { day: string; startMin: number; stylistId: string };
        return [i.day, i.startMin, i.stylistId];
      }),
    ).toStrictEqual([
      ['2027-01-06', 990, 'maya'],
      ['2027-02-07', 1020, 'maya'],
    ]);
  });
});

// ------------------------------------------------------------ B3

describe('B3: with_reasons, why a session is not free', () => {
  const REASONS: RoutineContractOptions = { ...OPTIONS_OFF, withReasons: true };
  const BOTH: RoutineContractOptions = {
    ...OPTIONS_OFF,
    checkLater: true,
    withReasons: true,
  };
  const preview = async (
    contract: RoutineContractOptions | undefined,
    diary: Diary,
    over: Partial<RoutineClaim> = {},
  ) => {
    const r = await everything(
      harness({ diary }),
      command(
        { ...SIX_MONTHLY, dryRun: true, ...over },
        contract === undefined ? {} : { contract },
      ),
    );
    return (r.answer as MobileSeriesPreview).sessions;
  };

  // ---- 1. Every session that is not free, and only those

  it('a session that is not free says stylist_unavailable; a free one has no reason at all', async () => {
    const sessions = await preview(REASONS, mayaOff('2026-11-06'));
    expect(sessions[1]).toMatchObject({
      date: '2026-11-06',
      free: false,
      reason: 'stylist_unavailable',
    });
    for (const s of [sessions[0]!, sessions[2]!]) {
      expect(s.free).toBe(true);
      expect('reason' in s).toBe(false);
    }
  });

  it.each([
    ['off that day', { starts: { '2026-11-06': { rana: ALL_DAY } } }],
    [
      'busy at that time',
      { starts: { '2026-11-06': { maya: [900, 930], rana: ALL_DAY } } },
    ],
  ])('the stylist %s: stylist_unavailable', async (_name, diary) => {
    const sessions = await preview(REASONS, diary);
    expect(sessions[1]).toMatchObject({
      free: false,
      reason: 'stylist_unavailable',
    });
  });

  it('a far session with check_later says so too', async () => {
    const sessions = await preview(BOTH, mayaOff('2027-01-06'));
    expect(sessions[3]).toMatchObject({
      date: '2027-01-06',
      later: true,
      free: false,
      reason: 'stylist_unavailable',
    });
    expect('reason' in sessions[4]!).toBe(false);
  });

  it('a far session WITHOUT check_later is not checked (free null), so it has no reason', async () => {
    const sessions = await preview(REASONS, mayaOff('2027-01-06'));
    expect(sessions[3]!.free).toBeNull();
    expect('reason' in sessions[3]!).toBe(false);
  });

  it('a picked session says why when its pick is not free, and nothing when it is', async () => {
    const pickedBusy = await preview(
      REASONS,
      mayaOff('2026-11-06', '2026-11-07'),
      {
        picks: [
          { index: 1, date: '2026-11-07', time: '16:30', stylistId: null },
        ],
      },
    );
    expect(pickedBusy[1]).toMatchObject({
      date: '2026-11-07',
      picked: true,
      free: false,
      reason: 'stylist_unavailable',
    });
    const pickedFree = await preview(REASONS, mayaOff('2026-11-06'), {
      picks: [{ index: 1, date: '2026-11-07', time: '16:30', stylistId: null }],
    });
    expect(pickedFree[1]).toMatchObject({ picked: true, free: true });
    expect('reason' in pickedFree[1]!).toBe(false);
  });

  it('a picked FAR session (check_later) says why too', async () => {
    const sessions = await preview(BOTH, mayaOff('2027-01-06', '2027-01-07'), {
      picks: [{ index: 3, date: '2027-01-07', time: '16:30', stylistId: null }],
    });
    expect(sessions[3]).toMatchObject({
      date: '2027-01-07',
      picked: true,
      free: false,
      reason: 'stylist_unavailable',
    });
  });

  // ---- 2. booking-api never says anything about the salon's hours

  it('only ever says stylist_unavailable, even on a day the engine calls closed', async () => {
    const diaries: Diary[] = [
      mayaOff('2026-11-06', '2027-01-06'),
      { closed: ['2026-10-06', '2027-02-06'] },
      { starts: { '2026-12-06': { maya: [900], rana: [900] } } },
    ];
    const reasons = new Set<string>();
    for (const diary of diaries) {
      for (const s of await preview(BOTH, diary)) {
        if (s.free === false) {
          expect(s.reason).toBe('stylist_unavailable');
        }
        if (s.reason !== undefined) reasons.add(s.reason);
      }
    }
    expect([...reasons]).toStrictEqual(['stylist_unavailable']);
  });

  // ---- 3. Without with_reasons: as before

  it('without with_reasons no session carries a reason, near or far', async () => {
    for (const contract of [undefined, OPTIONS_OFF, LATER]) {
      const sessions = await preview(
        contract,
        mayaOff('2026-11-06', '2027-01-06'),
      );
      expect(sessions.some((s) => s.free === false)).toBe(true);
      expect(sessions.some((s) => 'reason' in s)).toBe(false);
    }
  });

  it('with_reasons changes nothing else in the preview', async () => {
    const diary = mayaOff('2026-11-06', '2027-01-06');
    const over = { ...SIX_MONTHLY, dryRun: true };
    for (const [plain, withWhy] of [
      [OPTIONS_OFF, REASONS],
      [LATER, BOTH],
    ] as const) {
      const before = await everything(
        harness({ diary }),
        command(over, { contract: plain }),
      );
      const now = await everything(
        harness({ diary }),
        command(over, { contract: withWhy }),
      );
      const strip = (r: { answer: unknown }) => ({
        ...(r.answer as MobileSeriesPreview),
        sessions: sessionsOf(r).map(({ reason: _reason, ...rest }) => rest),
      });
      expect(strip(now)).toStrictEqual(strip(before));
    }
  });

  it('a create answers exactly as without it, booked or refused', async () => {
    for (const diary of [{}, mayaOff('2026-11-06')]) {
      const before = await everything(
        harness({ diary }),
        command(SIX_MONTHLY, { money: SIX_MONEY, contract: LATER }),
      );
      const now = await everything(
        harness({ diary }),
        command(SIX_MONTHLY, { money: SIX_MONEY, contract: BOTH }),
      );
      expect(now).toStrictEqual(before);
    }
  });
});

function sessionsOf(r: { answer: unknown }) {
  return (r.answer as MobileSeriesPreview).sessions;
}

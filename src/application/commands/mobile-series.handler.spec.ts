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
    /**
     * B5: by day, the stylists the engine has and the minutes each is
     * already reserved in the diary. Default: maya and rana, nothing booked.
     * The roster's bookingsToday is 0 for everyone, as platform publishes it.
     */
    busy?: Readonly<Record<string, Readonly<Record<string, number>>>>;
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
    loadDay: vi.fn((_b: string, day: string) => {
      const busy = Object.entries(over.busy?.[day] ?? { maya: 0, rana: 0 });
      return Promise.resolve({
        professionals: busy.map(([id]) => ({ id, bookingsToday: 0 })),
        staffBookings: new Map(
          busy
            .filter(([, minutes]) => minutes > 0)
            .map(([id, minutes]) => [
              id,
              [
                {
                  startMin: 600,
                  endMin: 600 + minutes,
                  claims: { preMin: 0, postMin: 0 },
                },
              ],
            ]),
        ),
      });
    }),
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
  return { handler, single, availability, lifecycle, repo, reads, context };
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

// ------------------------------------------------------------ B4

describe('B4: alternative_rule SAME_STYLIST_FORWARD', () => {
  const RULE: RoutineContractOptions = {
    ...OPTIONS_OFF,
    alternativeRule: 'SAME_STYLIST_FORWARD',
  };
  const ruleWith = (over: Partial<RoutineContractOptions>) => ({
    ...RULE,
    ...over,
  });
  const run = (
    contract: RoutineContractOptions,
    diary: Diary,
    over: Partial<RoutineClaim> = {},
  ) => {
    const h = harness({ diary });
    return everything(
      h,
      command({ ...SIX_MONTHLY, dryRun: true, ...over }, { contract }),
    ).then((r) => ({
      ...r,
      asked: h.availability.execute.mock.calls.map((c) => c[0].tradingDay),
    }));
  };
  const altsOf = (r: { answer: unknown }, index: number) =>
    sessionsOf(r)[index]!.alternatives.map((a) => [
      a.date,
      a.time,
      a.stylist_id,
    ]);
  const daysOf = (r: { answer: unknown }, index: number) =>
    sessionsOf(r)[index]!.alternatives.map((a) => a.date);

  // ---- 1 and 2. The rule, in the preview

  it("uses the rule: the session's own stylist, the next days, nothing before", async () => {
    const now = await run(RULE, mayaOff('2026-11-06'));
    expect(sessionsOf(now)[1]!.alternatives).toStrictEqual([
      {
        date: '2026-11-07',
        time: '16:30',
        start_time: '2026-11-07T16:30:00+06:00',
        stylist_id: 'maya',
      },
      {
        date: '2026-11-07',
        time: '16:00',
        start_time: '2026-11-07T16:00:00+06:00',
        stylist_id: 'maya',
      },
      {
        date: '2026-11-08',
        time: '16:30',
        start_time: '2026-11-08T16:30:00+06:00',
        stylist_id: 'maya',
      },
    ]);
    // The old rule (D4) offers another stylist first, and the days before.
    const before = await run(OPTIONS_OFF, mayaOff('2026-11-06'));
    const old = altsOf(before, 1);
    expect(old.some(([, , who]) => who === 'rana')).toBe(true);
  });

  it('the same day first, nearest time first, when the stylist is only busy then', async () => {
    const now = await run(RULE, {
      starts: {
        '2026-11-06': { maya: ALL_DAY.filter((m) => m !== 990), rana: ALL_DAY },
      },
    });
    expect(altsOf(now, 1)).toStrictEqual([
      ['2026-11-06', '16:00', 'maya'],
      ['2026-11-06', '17:00', 'maya'],
      ['2026-11-07', '16:30', 'maya'],
    ]);
  });

  // ---- 3. At most 2 on one day

  it('a same day full of free times still leaves room for the next days', async () => {
    const now = await run(ruleWith({ alternativesMax: 12 }), {
      starts: {
        '2026-11-06': { maya: ALL_DAY.filter((m) => m !== 990), rana: ALL_DAY },
      },
    });
    expect(daysOf(now, 1)).toStrictEqual([
      '2026-11-06',
      '2026-11-06',
      '2026-11-07',
      '2026-11-07',
      '2026-11-08',
      '2026-11-08',
      '2026-11-09',
      '2026-11-09',
      '2026-11-10',
      '2026-11-10',
      '2026-11-11',
      '2026-11-11',
    ]);
  });

  it('+8 days is never offered, nor even asked about', async () => {
    const off = mayaOff(
      '2026-11-06',
      '2026-11-07',
      '2026-11-08',
      '2026-11-09',
      '2026-11-10',
      '2026-11-11',
      '2026-11-12',
      '2026-11-13',
    );
    const now = await run(ruleWith({ alternativesMax: 12 }), off);
    expect(sessionsOf(now)[1]!.free).toBe(false);
    expect(sessionsOf(now)[1]!.alternatives).toStrictEqual([]);
    expect(now.asked).toContain('2026-11-13');
    expect(now.asked).not.toContain('2026-11-14');
  });

  it('never a day another session of the routine already has', async () => {
    // WEEKLY: 10-06, 10-13, 10-20. Maya is off 10-13 to 10-19; 10-20 is free
    // but it is session 2's day.
    const now = await run(
      ruleWith({ alternativesMax: 12 }),
      mayaOff(
        '2026-10-13',
        '2026-10-14',
        '2026-10-15',
        '2026-10-16',
        '2026-10-17',
        '2026-10-18',
        '2026-10-19',
      ),
      { frequency: 'WEEKLY', startDate: '2026-10-06', sessions: 3 },
    );
    expect(sessionsOf(now)[1]!.free).toBe(false);
    expect(sessionsOf(now)[1]!.alternatives).toStrictEqual([]);
  });

  // ---- 4. alternatives_max

  it.each([
    [1, 1],
    [12, 12],
    [null, 3],
  ] as const)('alternatives_max %j gives %i', async (max, count) => {
    const now = await run(
      ruleWith({ alternativesMax: max }),
      mayaOff('2026-11-06'),
    );
    expect(sessionsOf(now)[1]!.alternatives).toHaveLength(count);
  });

  // ---- 5. The 90 days

  it('a near session never gets one past the 90 days; a far one (check_later) may', async () => {
    const over: Partial<RoutineClaim> = {
      frequency: 'MONTHLY',
      startDate: '2026-10-29',
      sessions: 4,
    };
    const off = mayaOff('2026-12-29', '2026-12-30', '2027-01-29');
    const now = await run(
      ruleWith({ checkLater: true, alternativesMax: 12 }),
      off,
      over,
    );
    expect(sessionsOf(now)[2]).toMatchObject({
      date: '2026-12-29',
      free: false,
      alternatives: [],
    });
    expect(now.asked).not.toContain('2026-12-31');
    expect(sessionsOf(now)[3]!.free).toBe(false);
    expect(daysOf(now, 3).slice(0, 3)).toStrictEqual([
      '2027-01-30',
      '2027-01-30',
      '2027-01-31',
    ]);
    // Without check_later a far session is not checked, so it has none.
    const notLater = await run(ruleWith({ alternativesMax: 12 }), off, over);
    expect(sessionsOf(notLater)[3]).toMatchObject({
      free: null,
      alternatives: [],
    });
  });

  // ---- 6. Without the rule: as before

  it('alternatives_max without the rule changes nothing', async () => {
    const diary = mayaOff('2026-11-06');
    const plain = await run(OPTIONS_OFF, diary);
    const maxOnly = await run({ ...OPTIONS_OFF, alternativesMax: 12 }, diary);
    expect(maxOnly).toStrictEqual(plain);
  });

  it('the rule changes only the alternatives', async () => {
    const diary = mayaOff('2026-11-06', '2026-12-06');
    const plain = await run(OPTIONS_OFF, diary);
    const now = await run(RULE, diary);
    const strip = (r: { answer: unknown }) => ({
      ...(r.answer as MobileSeriesPreview),
      sessions: sessionsOf(r).map(({ alternatives: _a, ...rest }) => rest),
    });
    expect(strip(now)).toStrictEqual(strip(plain));
  });

  it('a create answers exactly as without it, booked or refused', async () => {
    for (const diary of [{}, mayaOff('2026-11-06')]) {
      const plain = await everything(
        harness({ diary }),
        command(SIX_MONTHLY, { money: SIX_MONEY, contract: OPTIONS_OFF }),
      );
      const now = await everything(
        harness({ diary }),
        command(SIX_MONTHLY, {
          money: SIX_MONEY,
          contract: ruleWith({ alternativesMax: 12 }),
        }),
      );
      expect(now).toStrictEqual(plain);
    }
  });
});

// ------------------------------------------------------------ B5

/** What the hourly job books from the rows a create saved (as in B2). */
async function jobBooks(
  saved: {
    stylistId: string;
    sessions: {
      index: number;
      day: string;
      startMin: number;
      bookingId: string | null;
    }[];
  },
  atMs: number,
) {
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
          occurrences: saved.sessions.map((s) => ({
            id: `occ-${s.index}`,
            bookingId: s.bookingId,
            plannedStartMin: s.startMin,
          })),
        },
        facts: saved.sessions.map((s) => ({
          id: `occ-${s.index}`,
          index: s.index,
          day: s.day,
          startAtMs: branchInstant(s.day, s.startMin).getTime(),
          state: s.bookingId === null ? 'planned' : 'materialised',
          bookingStatus: s.bookingId === null ? null : 'confirmed',
          noShowBy: null,
        })),
      }),
    } as never,
    { transition: vi.fn() } as never,
    { bookSession } as never,
    { run: (_t: unknown, f: () => unknown) => f() } as never,
  );
  await job.run(atMs);
  return bookSession.mock.calls.map((c) => {
    const i = c[0] as { day: string; startMin: number; stylistId: string };
    return [i.day, i.startMin, i.stylistId];
  });
}

describe('B5: Any Available Expert (stylist_candidates, no stylist_id)', () => {
  const any = (
    candidates: string[] = ['maya', 'rana'],
    more: Partial<RoutineContractOptions> = {},
  ): RoutineContractOptions => ({
    ...OPTIONS_OFF,
    stylistCandidates: candidates,
    ...more,
  });
  const ranaOff = (...days: string[]): Readonly<Record<string, Starts>> =>
    Object.fromEntries(days.map((d) => [d, { maya: ALL_DAY }]));
  const run = (
    contract: RoutineContractOptions | undefined,
    diary: Diary,
    over: Partial<RoutineClaim> = {},
    busy?: Record<string, Record<string, number>>,
    customerId: string = CUSTOMER,
  ) => {
    const h = harness({ diary, busy });
    return everything(
      h,
      command(
        { ...SIX_MONTHLY, stylistId: null, ...over },
        {
          money: SIX_MONEY,
          customerId,
          ...(contract === undefined ? {} : { contract }),
        },
      ),
    ).then((r) => ({ ...r, loadDay: h.context.loadDay.mock.calls }));
  };
  const chosen = (r: { answer: unknown }) =>
    (r.answer as MobileSeriesPreview).stylist_id;
  const DRY = { dryRun: true };

  // ---- 1. Who is chosen

  it('the stylist free on more sessions wins, over session 0 and over the diary', async () => {
    // maya: free on 10-06 only. rana: free on 11-06 and 12-06, not 10-06.
    const now = await run(
      any(),
      {
        starts: {
          ...ranaOff('2026-10-06'),
          ...mayaOff('2026-11-06', '2026-12-06').starts,
        },
      },
      DRY,
      { '2026-10-06': { maya: 0, rana: 480 } },
    );
    expect(chosen(now)).toBe('rana');
    expect(sessionsOf(now).every((s) => s.stylist_id === 'rana')).toBe(true);
  });

  it('tie on sessions: free on session 0 wins, over the diary', async () => {
    // Both free on 2 of 3: maya misses 11-06, rana misses 10-06.
    const now = await run(
      any(['rana', 'maya']),
      {
        starts: {
          ...ranaOff('2026-10-06'),
          ...mayaOff('2026-11-06').starts,
        },
      },
      DRY,
      { '2026-10-06': { maya: 480, rana: 0 } },
    );
    expect(chosen(now)).toBe('maya');
  });

  it("tie on both: the fewest minutes already taken in booking-api's diary on session 0's day", async () => {
    // Everyone's roster count is 0 (as platform publishes it): only the
    // diary can tell them apart. Another day's diary does not count.
    const busier = (maya: number, rana: number) => ({
      '2026-10-06': { maya, rana },
      '2026-11-06': { maya: 0, rana: 600 },
    });
    const ranaLess = await run(any(), {}, DRY, busier(120, 45));
    expect(chosen(ranaLess)).toBe('rana');
    expect(ranaLess.loadDay).toStrictEqual([['marina-walk', '2026-10-06']]);
    expect(chosen(await run(any(), {}, DRY, busier(45, 120)))).toBe('maya');
  });

  it('tie on everything: different customers get different stylists; the same customer gets the same one twice', async () => {
    const other = 'cccccccc-cccc-4ccc-8ccc-000000000002';
    // Equally free, equally busy (nothing booked), in either order.
    for (const candidates of [
      ['maya', 'rana'],
      ['rana', 'maya'],
    ]) {
      expect(
        chosen(await run(any(candidates), {}, DRY, undefined, CUSTOMER)),
      ).toBe('maya');
      expect(
        chosen(await run(any(candidates), {}, DRY, undefined, other)),
      ).toBe('rana');
    }
    // The same customer, the preview and then the create: the same stylist.
    for (const [who, stylist] of [
      [CUSTOMER, 'maya'],
      [other, 'rana'],
    ] as const) {
      const preview = await run(any(), {}, DRY, undefined, who);
      const created = await run(any(), {}, {}, undefined, who);
      expect(chosen(preview)).toBe(stylist);
      expect((created.saved[0] as { stylistId: string }).stylistId).toBe(
        stylist,
      );
    }
  });

  it('far sessions count too, with check_later', async () => {
    // maya: off on the 3 far days. rana: off on 11-06 and 12-06.
    const diary: Diary = {
      starts: {
        ...ranaOff('2026-11-06', '2026-12-06'),
        ...mayaOff('2027-01-06', '2027-02-06', '2027-03-06').starts,
      },
    };
    expect(chosen(await run(any(), diary, DRY))).toBe('maya'); // 3 against 1
    expect(
      chosen(
        await run(any(['maya', 'rana'], { checkLater: true }), diary, DRY),
      ),
    ).toBe(
      'rana', // 3 against 4
    );
  });

  // ---- 2. Used exactly as if the app had sent it

  it('the preview is exactly the one for that stylist sent by the app: sessions, alternatives, money, reasons', async () => {
    const options = {
      checkLater: true,
      withReasons: true,
      alternativeRule: 'SAME_STYLIST_FORWARD' as const,
    };
    const diary: Diary = {
      starts: {
        ...ranaOff('2026-10-06'),
        ...mayaOff('2026-11-06', '2026-12-06', '2027-02-06').starts,
        '2027-01-06': { maya: ALL_DAY },
      },
    };
    // maya: 10-06, 01-06, 03-06 (3). rana: 11-06, 12-06, 02-06, 03-06 (4).
    const chosenRun = await run(any(['maya', 'rana'], options), diary, DRY);
    const sentRun = await run({ ...OPTIONS_OFF, ...options }, diary, {
      ...DRY,
      stylistId: 'rana',
    });
    expect(chosen(chosenRun)).toBe('rana');
    const { loadDay: _a, ...a } = chosenRun;
    const { loadDay: _b, ...b } = sentRun;
    expect(a).toStrictEqual(b);
    // It does show a busy session with its reason and rana's alternatives.
    expect(sessionsOf(a)[0]).toMatchObject({
      free: false,
      reason: 'stylist_unavailable',
    });
    expect(
      sessionsOf(a)[0]!.alternatives.every((x) => x.stylist_id === 'rana'),
    ).toBe(true);
  });

  // ---- 3. The create

  it('a create chooses the same way, books all or nothing with that stylist, and saves it as the regular one', async () => {
    const diary: Diary = { starts: ranaOff('2026-10-06') };
    // maya is free everywhere, rana misses 10-06: maya wins.
    const now = await run(any(['rana', 'maya']), diary);
    const sent = await run(OPTIONS_OFF, diary, { stylistId: 'maya' });
    const { loadDay: _a, ...a } = now;
    const { loadDay: _b, ...b } = sent;
    expect(a).toStrictEqual(b);
    expect((now.saved[0] as { stylistId: string }).stylistId).toBe('maya');
    expect(
      now.booked.map((c) => (c as unknown as { stylists: string[] }).stylists),
    ).toStrictEqual([['maya'], ['maya'], ['maya']]);
  });

  it('a create that sends a stylist_id uses it and ignores the candidates', async () => {
    const withCandidates = await run(any(['rana']), {}, { stylistId: 'maya' });
    const without = await run(OPTIONS_OFF, {}, { stylistId: 'maya' });
    expect(withCandidates).toStrictEqual(without);
    expect(withCandidates.loadDay).toStrictEqual([]);
  });

  it('a routine created with candidates: the hourly job books its far sessions with the chosen stylist', async () => {
    // rana is free everywhere; maya misses 10-06. rana is chosen.
    const now = await run(
      any(['maya', 'rana'], { checkLater: true }),
      mayaOff('2026-10-06'),
    );
    const saved = now.saved[0] as Parameters<typeof jobBooks>[0];
    expect(saved.stylistId).toBe('rana');
    expect(
      await jobBooks(saved, Date.parse('2026-12-01T09:00:00+06:00')),
    ).toStrictEqual([
      ['2027-01-06', 990, 'rana'],
      ['2027-02-06', 990, 'rana'],
    ]);
  });

  // ---- 4. Nobody here, nobody free

  it('a candidate who does not work here counts 0, and comes after one who does', async () => {
    expect(chosen(await run(any(['ghost', 'maya']), {}, DRY))).toBe('maya');
    // Neither is free anywhere: the tie still picks the one the engine has.
    const nobody = {
      starts: {
        '2026-10-06': {},
        '2026-11-06': {},
        '2026-12-06': {},
      },
    };
    expect(chosen(await run(any(['ghost', 'maya']), nobody, DRY))).toBe('maya');
  });

  it("nobody free on any session: still one, by the tie rules, and the customer sees that stylist's alternatives", async () => {
    const nobody: Diary = {
      starts: { '2026-10-06': {}, '2026-11-06': {}, '2026-12-06': {} },
    };
    const now = await run(
      any(['maya', 'rana'], { alternativeRule: 'SAME_STYLIST_FORWARD' }),
      nobody,
      DRY,
      { '2026-10-06': { maya: 60, rana: 30 } },
    );
    expect(chosen(now)).toBe('rana');
    const first = sessionsOf(now)[0]!;
    expect(first.free).toBe(false);
    expect(first.alternatives.length).toBeGreaterThan(0);
    expect(first.alternatives.every((x) => x.stylist_id === 'rana')).toBe(true);
  });

  // ---- 5. Only with a time

  it('a preview without a time and without a stylist_id is refused as before (stylist_required)', async () => {
    const over = { dryRun: true, time: null };
    const now = await run(any(), {}, over);
    const before = await run(undefined, {}, over);
    expect(now.answer).toStrictEqual({
      status: 422,
      errors: [
        {
          field: 'stylist_id',
          code: 'stylist_required',
          message: 'A routine keeps one regular stylist. Choose one.',
        },
      ],
    });
    expect(now).toStrictEqual(before);
  });

  // ---- 6. Without candidates: as before

  it('without candidates, no stylist is still stylist_required, exactly as before', async () => {
    const before = await run(undefined, {});
    for (const contract of [OPTIONS_OFF, LATER]) {
      const now = await run(contract, {});
      expect(now).toStrictEqual(before);
    }
    expect(
      (before.answer as { errors: { code: string }[] }).errors[0]!.code,
    ).toBe('stylist_required');
  });
});

// ------------------------------------------------------------ B6

describe('B6: strict_picks, every pick follows the alternatives rule', () => {
  const STRICT: RoutineContractOptions = { ...OPTIONS_OFF, strictPicks: true };
  const strictWith = (over: Partial<RoutineContractOptions>) => ({
    ...STRICT,
    ...over,
  });
  const run = (
    contract: RoutineContractOptions | undefined,
    over: Partial<RoutineClaim>,
    diary: Diary = {},
  ) => {
    const h = harness({ diary });
    return everything(
      h,
      command(
        { ...SIX_MONTHLY, ...over },
        { money: SIX_MONEY, ...(contract === undefined ? {} : { contract }) },
      ),
    ).then((r) => ({
      ...r,
      asked: h.availability.execute.mock.calls.map((c) => c[0].tradingDay),
    }));
  };
  const pick = (
    index: number,
    date: string,
    time = '16:30',
    stylistId: string | null = null,
  ) => ({ index, date, time, stylistId });
  const offRule = (j = 0) => ({
    status: 422,
    errors: [
      expect.objectContaining({
        field: `picks[${j}]`,
        code: 'session_not_offered',
      }),
    ],
  });
  const bookedDays = (r: { booked: unknown[] }) =>
    r.booked.map((b) => (b as { date: string }).date);

  // ---- 1 and 2. Outside the rule: refused, before anything is booked

  it('a free time 2 weeks later is refused, in the preview and in the create, before anything is looked at', async () => {
    const picks = [pick(1, '2026-11-20')];
    for (const dryRun of [true, false]) {
      const now = await run(STRICT, { dryRun, picks });
      expect(now.answer).toStrictEqual(offRule());
      expect(now.booked).toStrictEqual([]);
      expect(now.saved).toStrictEqual([]);
      expect(now.asked).not.toContain('2026-11-20');
    }
    // Without strict_picks the same pick is booked, as before.
    const before = await run(undefined, { picks });
    expect(bookedDays(before)).toContain('2026-11-20');
  });

  it.each([
    ['another stylist', [pick(1, '2026-11-07', '16:30', 'rana')], {}],
    ['the day before its own day', [pick(1, '2026-11-05')], {}],
    [
      "another session's day",
      [pick(1, '2026-10-20')],
      { frequency: 'WEEKLY', startDate: '2026-10-06', sessions: 3 },
    ],
    [
      'a near session past the 90 days, inside its +7',
      [pick(2, '2026-12-31')],
      { frequency: 'MONTHLY', startDate: '2026-10-29', sessions: 4 },
    ],
  ] as const)('%s: session_not_offered', async (_name, picks, over) => {
    const now = await run(strictWith({ checkLater: true }), {
      ...over,
      picks: [...picks],
    });
    expect(now.answer).toStrictEqual(offRule());
    expect(now.booked).toStrictEqual([]);
  });

  it("a far session's pick on day +8 is refused; on day +7 it is saved", async () => {
    const later = strictWith({ checkLater: true });
    const eight = await run(later, { picks: [pick(3, '2027-01-14')] });
    expect(eight.answer).toStrictEqual(offRule());
    const seven = await run(later, { picks: [pick(3, '2027-01-13')] });
    const saved = seven.saved[0] as {
      sessions: { day: string; bookingId: string | null }[];
    };
    expect(saved.sessions[3]).toMatchObject({
      day: '2027-01-13',
      bookingId: null,
    });
    // Without check_later a far session cannot be picked at all.
    const notLater = await run(STRICT, { picks: [pick(3, '2027-01-07')] });
    expect(notLater.answer).toStrictEqual(offRule());
  });

  // ---- 3. Inside the rule: accepted, but it must be free

  it('a free time on day +3 that was not in the list is accepted', async () => {
    const diary = mayaOff('2026-11-06');
    const preview = await run(
      strictWith({ alternativeRule: 'SAME_STYLIST_FORWARD' }),
      { dryRun: true },
      diary,
    );
    const shown = sessionsOf(preview)[1]!.alternatives.map(
      (a) => `${a.date} ${a.time}`,
    );
    expect(shown).not.toContain('2026-11-09 18:00');

    const now = await run(
      strictWith({ alternativeRule: 'SAME_STYLIST_FORWARD' }),
      { picks: [pick(1, '2026-11-09', '18:00')] },
      diary,
    );
    expect(bookedDays(now)).toStrictEqual([
      '2026-10-06',
      '2026-11-09',
      '2026-12-06',
    ]);
    const saved = now.saved[0] as {
      sessions: { day: string; startMin: number }[];
    };
    expect(saved.sessions[1]).toMatchObject({
      day: '2026-11-09',
      startMin: 1080,
    });
  });

  it('a pick inside the rule that is not free: not free in the preview, 409 on the create', async () => {
    const diary: Diary = {
      starts: {
        ...mayaOff('2026-11-06').starts,
        '2026-11-09': { maya: [900], rana: ALL_DAY },
      },
    };
    const picks = [pick(1, '2026-11-09', '18:00')];
    const preview = await run(STRICT, { dryRun: true, picks }, diary);
    expect(sessionsOf(preview)[1]).toMatchObject({
      date: '2026-11-09',
      free: false,
    });
    const now = await run(STRICT, { picks }, diary);
    expect(now.answer).toMatchObject({
      status: 409,
      errors: [{ field: 'sessions[1]', code: 'session_not_free' }],
    });
    expect(now.booked).toStrictEqual([]);
  });

  // ---- 4. Its own slot

  it('a pick equal to its own slot is fine', async () => {
    const now = await run(STRICT, { picks: [pick(1, '2026-11-06')] });
    const plain = await run(STRICT, {});
    expect(now.booked).toStrictEqual(plain.booked);
    expect(now.saved).toStrictEqual(plain.saved);
  });

  // ---- 5. Without strict_picks: as before

  it('without strict_picks every one of these picks answers exactly as with no contract', async () => {
    const cases: Partial<RoutineClaim>[] = [
      { picks: [pick(1, '2026-11-20')] },
      { picks: [pick(1, '2026-11-05')] },
      { picks: [pick(1, '2026-11-07', '16:30', 'rana')] },
      {
        frequency: 'WEEKLY',
        startDate: '2026-10-06',
        sessions: 3,
        picks: [pick(1, '2026-10-20')],
      },
    ];
    for (const over of cases) {
      expect(await run(OPTIONS_OFF, over)).toStrictEqual(
        await run(undefined, over),
      );
    }
  });
});

import { describe, expect, it } from 'vitest';
import {
  PAUSE_NOTE_MAX,
  SERIES_REFUSAL_CODES,
  cancelHistoryReason,
  cancelReasonFromHistory,
  checkCancel,
  checkManage,
  checkRoutine,
  checkRoutineMoney,
  isTradingDay,
  parseRoutineTime,
  pauseReasonColumn,
  pauseReasonFromColumn,
  refusalStatus,
  toRoutineStatus,
  type ManageClaim,
  type RoutineClaim,
} from './mobile-series-contract';
import { NO_PRODUCTS } from './mobile-products';
import { CANCEL_REASONS, PAUSE_REASONS, routineMoney } from './mobile-series';

const TODAY = '2026-10-01';

const weekly = (over: Partial<RoutineClaim> = {}): RoutineClaim => ({
  dryRun: false,
  serviceIds: ['svc-cut', 'svc-blow-dry'],
  stylistId: 'maya',
  frequency: 'WEEKLY',
  startDate: '2026-10-06',
  sessions: 6,
  dates: null,
  time: '18:00',
  paymentPlan: 'PAY_AT_SALON',
  picks: [],
  ...over,
});

const custom = (over: Partial<RoutineClaim> = {}): RoutineClaim =>
  weekly({
    frequency: 'CUSTOM',
    startDate: null,
    sessions: null,
    dates: ['2026-10-20', '2026-10-03', '2026-10-09'],
    ...over,
  });

const codeOf = (claim: RoutineClaim): string | null => {
  const r = checkRoutine(claim, TODAY);
  return r.kind === 'refused' ? r.refusal.code : null;
};

const fieldOf = (claim: RoutineClaim): string | null => {
  const r = checkRoutine(claim, TODAY);
  return r.kind === 'refused' ? r.refusal.field : null;
};

// ------------------------------------------------------------ codes

describe('the codes', () => {
  it('are each listed once', () => {
    expect(new Set(SERIES_REFUSAL_CODES).size).toBe(
      SERIES_REFUSAL_CODES.length,
    );
  });

  it('a race is 409, a hidden id 404, the rest 422', () => {
    expect(refusalStatus('session_not_free')).toBe(409);
    expect(refusalStatus('not_found')).toBe(404);
    for (const code of SERIES_REFUSAL_CODES) {
      if (code !== 'session_not_free' && code !== 'not_found') {
        expect(refusalStatus(code)).toBe(422);
      }
    }
  });
});

describe('words', () => {
  it('status goes out upper case', () => {
    expect(toRoutineStatus('active')).toBe('ACTIVE');
    expect(toRoutineStatus('paused')).toBe('PAUSED');
    expect(toRoutineStatus('ended')).toBe('ENDED');
    expect(toRoutineStatus('completed')).toBe('COMPLETED');
  });

  it('the Figma five pause reasons ("Busy Period" is BUSY)', () => {
    expect(PAUSE_REASONS).toEqual([
      'TRAVEL',
      'HEALTH',
      'BUSY',
      'BUDGET',
      'OTHER',
    ]);
  });

  it('pause reasons round trip; missed_twice is the server word', () => {
    for (const r of PAUSE_REASONS) {
      expect(pauseReasonFromColumn(pauseReasonColumn(r))).toBe(r);
    }
    expect(pauseReasonColumn('BUSY')).toBe('busy');
    expect(pauseReasonFromColumn('travel')).toBe('TRAVEL');
    expect(pauseReasonFromColumn('missed_twice')).toBe('MISSED_TWICE');
    expect(pauseReasonFromColumn(null)).toBeNull();
    expect(pauseReasonFromColumn('bored')).toBeNull();
  });
});

describe('isTradingDay', () => {
  it.each(['2026-10-01', '2028-02-29'])('%s is a day', (d) => {
    expect(isTradingDay(d)).toBe(true);
  });

  it.each(['2026-02-30', '2026-13-01', '1-10-2026', '2026-10-1', ''])(
    '%j is not',
    (d) => {
      expect(isTradingDay(d)).toBe(false);
    },
  );
});

describe('parseRoutineTime', () => {
  it.each([
    ['10:00', 600],
    ['18:05', 1085],
    ['21:55', 1315],
  ])('%s is minute %d', (t, m) => {
    expect(parseRoutineTime(t)).toBe(m);
  });

  it.each(['09:55', '22:00', '18:07', '6pm', '18:00:00', '24:00', ''])(
    '%j is refused (the series CHECK is 10:00 to 22:00, 5 minute steps)',
    (t) => {
      expect(parseRoutineTime(t)).toBeNull();
    },
  );
});

// ------------------------------------------------------------ create

describe('checkRoutine: good requests', () => {
  it('a weekly routine of 6 passes', () => {
    const r = checkRoutine(weekly(), TODAY);
    expect(r).toEqual({
      kind: 'ok',
      value: {
        dryRun: false,
        frequency: 'WEEKLY',
        count: 6,
        first: '2026-10-06',
        days: null,
        startMin: 1080,
        paymentPlan: 'PAY_AT_SALON',
        picks: [],
      },
    });
  });

  it('a custom routine sorts its days and counts them', () => {
    const r = checkRoutine(custom(), TODAY);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.value.days).toEqual(['2026-10-03', '2026-10-09', '2026-10-20']);
      expect(r.value.count).toBe(3);
      expect(r.value.first).toBeNull();
    }
  });

  it('dry_run may leave the time out (to ask which times are free)', () => {
    const r = checkRoutine(weekly({ dryRun: true, time: null }), TODAY);
    expect(r.kind === 'ok' && r.value.startMin).toBeNull();
  });

  it('D2: dry_run shows every plan, so it accepts every plan', () => {
    for (const plan of ['PAY_AS_YOU_GO', 'UPFRONT']) {
      expect(codeOf(weekly({ dryRun: true, paymentPlan: plan }))).toBeNull();
    }
  });

  it('D1: several services per session', () => {
    expect(codeOf(weekly({ serviceIds: ['a', 'b', 'c'] }))).toBeNull();
  });

  it('D4: a pick carries the chosen day, time and (optionally) stylist', () => {
    const r = checkRoutine(
      weekly({
        picks: [
          { index: 2, date: '2026-10-21', time: '11:30', stylistId: 'rana' },
        ],
      }),
      TODAY,
    );
    expect(r.kind === 'ok' && r.value.picks).toEqual([
      { index: 2, day: '2026-10-21', startMin: 690, stylistId: 'rana' },
    ]);
  });

  it('a pick with a blank stylist keeps the routine stylist', () => {
    const r = checkRoutine(
      weekly({
        picks: [
          { index: 0, date: '2026-10-07', time: '18:00', stylistId: ' ' },
        ],
      }),
      TODAY,
    );
    expect(r.kind === 'ok' && r.value.picks[0]?.stylistId).toBeNull();
  });
});

describe('checkRoutine: refusals, each with its code and field', () => {
  it.each<[string, Partial<RoutineClaim>, string, string]>([
    ['no service', { serviceIds: [] }, 'no_services', 'services'],
    ['no stylist', { stylistId: null }, 'stylist_required', 'stylist_id'],
    ['a blank stylist', { stylistId: '  ' }, 'stylist_required', 'stylist_id'],
    [
      'an unknown frequency',
      { frequency: 'YEARLY' },
      'invalid_frequency',
      'frequency',
    ],
    [
      'a lower case frequency',
      { frequency: 'weekly' },
      'invalid_frequency',
      'frequency',
    ],
    ['1 session', { sessions: 1 }, 'invalid_session_count', 'sessions'],
    ['7 sessions', { sessions: 7 }, 'invalid_session_count', 'sessions'],
    [
      'no session count',
      { sessions: null },
      'invalid_session_count',
      'sessions',
    ],
    [
      'a fraction of a session',
      { sessions: 2.5 },
      'invalid_session_count',
      'sessions',
    ],
    ['no start date', { startDate: null }, 'invalid_date', 'start_date'],
    [
      'a bad start date',
      { startDate: '2026-02-30' },
      'invalid_date',
      'start_date',
    ],
    [
      'dates on a weekly routine',
      { dates: ['2026-10-06'] },
      'invalid_date',
      'dates',
    ],
    [
      'a start in the past',
      { startDate: '2026-09-30' },
      'date_out_of_range',
      'start_date',
    ],
    [
      'a start past 90 days',
      { startDate: '2026-12-31' },
      'date_out_of_range',
      'start_date',
    ],
    ['no time on create', { time: null }, 'time_required', 'time'],
    ['a time before 10:00', { time: '09:00' }, 'invalid_time', 'time'],
    ['a time off the grid', { time: '18:02' }, 'invalid_time', 'time'],
    [
      'an unknown plan',
      { paymentPlan: 'CRYPTO' },
      'invalid_payment_plan',
      'payment_plan',
    ],
    [
      'D2: pay as you go on create',
      { paymentPlan: 'PAY_AS_YOU_GO' },
      'payment_plan_not_available',
      'payment_plan',
    ],
    [
      'D2: upfront on create',
      { paymentPlan: 'UPFRONT' },
      'payment_plan_not_available',
      'payment_plan',
    ],
  ])('%s', (_, over, code, field) => {
    const claim = weekly(over);
    expect(codeOf(claim)).toBe(code);
    expect(fieldOf(claim)).toBe(field);
  });

  it('a start today and one 90 days out are both fine', () => {
    expect(codeOf(weekly({ startDate: TODAY }))).toBeNull();
    expect(codeOf(weekly({ startDate: '2026-12-30' }))).toBeNull();
  });

  it.each<[string, Partial<RoutineClaim>, string, string]>([
    ['no dates', { dates: null }, 'invalid_date', 'dates'],
    [
      'a start_date as well',
      { startDate: '2026-10-03' },
      'invalid_date',
      'dates',
    ],
    [
      'a bad date',
      { dates: ['2026-10-03', 'soon'] },
      'invalid_date',
      'dates[1]',
    ],
    [
      'a repeated day',
      { dates: ['2026-10-03', '2026-10-03'] },
      'invalid_date',
      'dates',
    ],
    ['one day', { dates: ['2026-10-03'] }, 'invalid_session_count', 'dates'],
    [
      'seven days',
      {
        dates: ['03', '04', '05', '06', '07', '08', '09'].map(
          (d) => `2026-10-${d}`,
        ),
      },
      'invalid_session_count',
      'dates',
    ],
    [
      'a count that disagrees',
      { sessions: 4 },
      'invalid_session_count',
      'sessions',
    ],
    [
      'a day past 90 days',
      { dates: ['2026-10-03', '2026-12-31'] },
      'date_out_of_range',
      'dates',
    ],
    [
      'a day in the past',
      { dates: ['2026-09-30', '2026-10-03'] },
      'date_out_of_range',
      'dates',
    ],
  ])('CUSTOM: %s', (_, over, code, field) => {
    const claim = custom(over);
    expect(codeOf(claim)).toBe(code);
    expect(fieldOf(claim)).toBe(field);
  });

  it('CUSTOM may send sessions when it matches the dates', () => {
    expect(codeOf(custom({ sessions: 3 }))).toBeNull();
  });

  it.each<[string, RoutineClaim['picks'], string]>([
    [
      'an index past the last session',
      [{ index: 6, date: '2026-10-07', time: '18:00', stylistId: null }],
      'picks[0].index',
    ],
    [
      'a negative index',
      [{ index: -1, date: '2026-10-07', time: '18:00', stylistId: null }],
      'picks[0].index',
    ],
    [
      'two picks for one session',
      [
        { index: 1, date: '2026-10-14', time: '18:00', stylistId: null },
        { index: 1, date: '2026-10-15', time: '18:00', stylistId: null },
      ],
      'picks[1].index',
    ],
    [
      'a bad day',
      [{ index: 1, date: '2026-10-32', time: '18:00', stylistId: null }],
      'picks[0].date',
    ],
    [
      'a day past 90 days',
      [{ index: 1, date: '2027-01-15', time: '18:00', stylistId: null }],
      'picks[0].date',
    ],
    [
      'a bad time',
      [{ index: 1, date: '2026-10-14', time: '08:00', stylistId: null }],
      'picks[0].time',
    ],
  ])('invalid_pick: %s', (_, picks, field) => {
    const claim = weekly({ picks });
    expect(codeOf(claim)).toBe('invalid_pick');
    expect(fieldOf(claim)).toBe(field);
  });
});

// ------------------------------------------------------------ money

describe('checkRoutineMoney', () => {
  const plan = routineMoney({
    sessions: [
      { subtotalFils: 10000, discountFils: 0, vatFils: 500, totalFils: 10500 },
      { subtotalFils: 10000, discountFils: 0, vatFils: 500, totalFils: 10500 },
    ],
    products: NO_PRODUCTS,
    depositPercent: 20,
  }).plans.PAY_AT_SALON;
  const right = {
    amountWithoutTax: 200,
    taxAmount: 10,
    discount: 0,
    total: 210,
  };

  it('the right figures pass', () => {
    expect(checkRoutineMoney(right, plan)).toBeNull();
  });

  it('one fil out is rounding, and passes', () => {
    expect(checkRoutineMoney({ ...right, total: 210.01 }, plan)).toBeNull();
  });

  it.each([
    ['amount_without_tax', { amountWithoutTax: 190 }, 200],
    ['tax_amount', { taxAmount: 9.5 }, 10],
    ['discount', { discount: 5 }, 0],
    ['total', { total: 199.5 }, 210],
  ])(
    'a wrong %s is amount_mismatch with the right figure',
    (field, over, want) => {
      expect(checkRoutineMoney({ ...right, ...over }, plan)).toMatchObject({
        field,
        code: 'amount_mismatch',
        expected: want,
      });
    },
  );

  it('a third decimal is refused, not rounded', () => {
    expect(checkRoutineMoney({ ...right, total: 210.005 }, plan)?.code).toBe(
      'amount_mismatch',
    );
  });
});

// ------------------------------------------------------------ PATCH

const manage = (over: Partial<ManageClaim> = {}): ManageClaim => ({
  action: 'SKIP',
  dryRun: false,
  sessionIds: null,
  sessionId: null,
  date: null,
  time: null,
  stylistId: null,
  sessions: null,
  dates: null,
  until: null,
  reason: null,
  note: null,
  frequency: null,
  ...over,
});

const manageCode = (
  claim: ManageClaim,
  frequency: 'WEEKLY' | 'CUSTOM' = 'WEEKLY',
) => {
  const r = checkManage(claim, frequency);
  return r.kind === 'refused' ? r.refusal.code : null;
};

describe('checkManage', () => {
  it('refuses an action it does not know', () => {
    expect(manageCode(manage({ action: 'DELETE' }))).toBe('invalid_action');
    expect(manageCode(manage({ action: 'skip' }))).toBe('invalid_action');
  });

  describe('SKIP', () => {
    it('takes one or more session ids', () => {
      expect(checkManage(manage({ sessionIds: ['a', 'b'] }), 'WEEKLY')).toEqual(
        {
          kind: 'ok',
          value: { action: 'SKIP', sessionIds: ['a', 'b'] },
        },
      );
    });

    it.each([[null], [[]], [['a', 'a']], [['a', ' ']]])('refuses %j', (ids) => {
      expect(manageCode(manage({ sessionIds: ids }))).toBe('invalid_sessions');
    });
  });

  describe('RESCHEDULE', () => {
    const move = (over: Partial<ManageClaim> = {}) =>
      manage({
        action: 'RESCHEDULE',
        sessionId: 'occ-1',
        date: '2026-10-12',
        time: '11:00',
        ...over,
      });

    it('takes a session, a day and a time', () => {
      expect(checkManage(move(), 'WEEKLY')).toEqual({
        kind: 'ok',
        value: {
          action: 'RESCHEDULE',
          sessionId: 'occ-1',
          day: '2026-10-12',
          startMin: 660,
          stylistId: null,
        },
      });
    });

    it('may change the stylist for that session', () => {
      const r = checkManage(move({ stylistId: 'rana' }), 'WEEKLY');
      expect(r.kind === 'ok' && r.value).toMatchObject({ stylistId: 'rana' });
    });

    it.each<[Partial<ManageClaim>, string]>([
      [{ sessionId: null }, 'invalid_sessions'],
      [{ date: null }, 'invalid_date'],
      [{ date: '12/10/2026' }, 'invalid_date'],
      [{ time: null }, 'invalid_time'],
      [{ time: '23:00' }, 'invalid_time'],
    ])('refuses %j', (over, code) => {
      expect(manageCode(move(over))).toBe(code);
    });
  });

  describe('EXTEND', () => {
    it('a cadence routine takes a count (the range is the rules)', () => {
      expect(
        checkManage(manage({ action: 'EXTEND', sessions: 2 }), 'WEEKLY'),
      ).toEqual({
        kind: 'ok',
        value: { action: 'EXTEND', count: 2, days: null },
      });
    });

    it('a cadence routine refuses dates, and needs a count', () => {
      expect(
        manageCode(manage({ action: 'EXTEND', dates: ['2026-11-01'] })),
      ).toBe('invalid_extend');
      expect(manageCode(manage({ action: 'EXTEND' }))).toBe('invalid_extend');
    });

    it('a CUSTOM routine takes days, sorted', () => {
      expect(
        checkManage(
          manage({ action: 'EXTEND', dates: ['2026-11-09', '2026-11-02'] }),
          'CUSTOM',
        ),
      ).toEqual({
        kind: 'ok',
        value: {
          action: 'EXTEND',
          count: 2,
          days: ['2026-11-02', '2026-11-09'],
        },
      });
    });

    it.each<[Partial<ManageClaim>, string]>([
      [{ sessions: 2 }, 'invalid_extend'],
      [{ dates: [] }, 'invalid_extend'],
      [
        {
          dates: ['01', '02', '03', '04', '05', '06', '07'].map(
            (d) => `2026-11-${d}`,
          ),
        },
        'invalid_extend',
      ],
      [{ dates: ['2026-11-02', 'later'] }, 'invalid_date'],
      [{ dates: ['2026-11-02', '2026-11-02'] }, 'invalid_date'],
    ])('a CUSTOM routine refuses %j', (over, code) => {
      expect(manageCode(manage({ action: 'EXTEND', ...over }), 'CUSTOM')).toBe(
        code,
      );
    });
  });

  describe('PAUSE', () => {
    it('takes a resume day, a reason and a note', () => {
      expect(
        checkManage(
          manage({
            action: 'PAUSE',
            until: '2026-10-30',
            reason: 'TRAVEL',
            note: '  Away  ',
          }),
          'WEEKLY',
        ),
      ).toEqual({
        kind: 'ok',
        value: {
          action: 'PAUSE',
          until: '2026-10-30',
          reason: 'TRAVEL',
          note: 'Away',
        },
      });
    });

    it.each(['TRAVEL', 'HEALTH', 'BUSY', 'BUDGET', 'OTHER'])(
      'takes the reason %s',
      (reason) => {
        expect(
          manageCode(manage({ action: 'PAUSE', until: '2026-10-30', reason })),
        ).toBeNull();
      },
    );

    it('reason and note are optional; a blank note is no note', () => {
      const r = checkManage(
        manage({ action: 'PAUSE', until: '2026-10-30', note: '   ' }),
        'WEEKLY',
      );
      expect(r.kind === 'ok' && r.value).toEqual({
        action: 'PAUSE',
        until: '2026-10-30',
        reason: null,
        note: null,
      });
    });

    it.each<[Partial<ManageClaim>, string]>([
      [{ until: null }, 'invalid_pause'],
      [{ until: 'next week' }, 'invalid_pause'],
      [{ until: '2026-10-30', reason: 'BORED' }, 'invalid_pause_reason'],
      [{ until: '2026-10-30', reason: 'busy' }, 'invalid_pause_reason'],
      [{ until: '2026-10-30', reason: 'MISSED_TWICE' }, 'invalid_pause_reason'],
      [
        { until: '2026-10-30', note: 'x'.repeat(PAUSE_NOTE_MAX + 1) },
        'invalid_pause',
      ],
    ])('refuses %j', (over, code) => {
      expect(manageCode(manage({ action: 'PAUSE', ...over }))).toBe(code);
    });

    it('a note of exactly 200 characters is fine', () => {
      expect(
        manageCode(
          manage({
            action: 'PAUSE',
            until: '2026-10-30',
            note: 'x'.repeat(PAUSE_NOTE_MAX),
          }),
        ),
      ).toBeNull();
    });
  });

  describe('RESUME', () => {
    it('with nothing sent, is a plain resume', () => {
      expect(checkManage(manage({ action: 'RESUME' }), 'WEEKLY')).toEqual({
        kind: 'ok',
        value: {
          action: 'RESUME',
          frequency: null,
          startMin: null,
          stylistId: null,
        },
      });
    });

    it('"Customize first": a new frequency, time and stylist, together', () => {
      expect(
        checkManage(
          manage({
            action: 'RESUME',
            frequency: 'EVERY_2_WEEKS',
            time: '11:30',
            stylistId: 'rana',
          }),
          'WEEKLY',
        ),
      ).toEqual({
        kind: 'ok',
        value: {
          action: 'RESUME',
          frequency: 'EVERY_2_WEEKS',
          startMin: 690,
          stylistId: 'rana',
        },
      });
    });

    it('any one of the three alone', () => {
      expect(
        manageCode(manage({ action: 'RESUME', frequency: 'DAILY' })),
      ).toBeNull();
      expect(
        manageCode(manage({ action: 'RESUME', time: '10:00' })),
      ).toBeNull();
      expect(
        manageCode(manage({ action: 'RESUME', stylistId: 'rana' })),
      ).toBeNull();
    });

    it('a CUSTOM routine may resume on a cadence', () => {
      expect(
        manageCode(
          manage({ action: 'RESUME', frequency: 'MONTHLY' }),
          'CUSTOM',
        ),
      ).toBeNull();
    });

    it.each<[Partial<ManageClaim>, string, string]>([
      [{ frequency: 'CUSTOM' }, 'invalid_frequency', 'frequency'],
      [{ frequency: 'YEARLY' }, 'invalid_frequency', 'frequency'],
      [{ frequency: 'weekly' }, 'invalid_frequency', 'frequency'],
      [{ time: '09:00' }, 'invalid_time', 'time'],
      [{ time: '18:03' }, 'invalid_time', 'time'],
      [{ stylistId: '  ' }, 'stylist_required', 'stylist_id'],
    ])('checks %j like the create', (over, code, field) => {
      const r = checkManage(manage({ action: 'RESUME', ...over }), 'WEEKLY');
      expect(r.kind === 'refused' && r.refusal).toMatchObject({ code, field });
    });
  });
});

// ------------------------------------------------------------ cancel

describe('checkCancel', () => {
  it('the reason is optional', () => {
    expect(checkCancel({ dryRun: true, reason: null })).toEqual({
      kind: 'ok',
      value: { dryRun: true, reason: null },
    });
  });

  it.each(['NOT_SATISFIED', 'TOO_EXPENSIVE', 'MOVING', 'OTHER'])(
    'takes %s',
    (reason) => {
      expect(checkCancel({ dryRun: false, reason })).toEqual({
        kind: 'ok',
        value: { dryRun: false, reason },
      });
    },
  );

  it.each(['BORED', 'moving', ''])('refuses %j', (reason) => {
    expect(checkCancel({ dryRun: false, reason })).toEqual({
      kind: 'refused',
      refusal: {
        field: 'reason',
        code: 'invalid_cancel_reason',
        message:
          'reason must be NOT_SATISFIED, TOO_EXPENSIVE, MOVING or OTHER.',
      },
    });
  });

  it('is a 422', () => {
    expect(refusalStatus('invalid_cancel_reason')).toBe(422);
  });
});

describe('the cancel reason in booking_status_history.reason', () => {
  it('is never empty, so the history CHECK for a cancel is met', () => {
    expect(cancelHistoryReason(null)).toBe('Routine cancelled in the app.');
    expect(cancelHistoryReason('TOO_EXPENSIVE')).toBe(
      'Routine cancelled in the app. Reason: TOO_EXPENSIVE.',
    );
  });

  it('reads back exactly what it wrote', () => {
    for (const r of CANCEL_REASONS) {
      expect(cancelReasonFromHistory(cancelHistoryReason(r))).toBe(r);
    }
    expect(cancelReasonFromHistory(cancelHistoryReason(null))).toBeNull();
  });

  it('reads nothing from a reason it did not write', () => {
    expect(cancelReasonFromHistory(null)).toBeNull();
    expect(cancelReasonFromHistory('Customer called the desk.')).toBeNull();
    expect(
      cancelReasonFromHistory('Routine cancelled in the app. Reason: BORED.'),
    ).toBeNull();
  });
});

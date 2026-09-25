import { describe, expect, it } from 'vitest';
import {
  CALENDAR_CHIPS,
  LIST_FILTERS,
  LIVE_STATUSES,
  isCalendarChip,
  isListFilter,
  isAmbiguous,
  statusesFor,
  statusesForChips,
  toDepositOutcome,
  toScreenPayment,
  toScreenStatus,
  isPaymentChip,
  matchesAnyPaymentChip,
  matchesPaymentChip,
  type ScreenStatus,
  PAYMENT_CHIPS,
} from './screen-view';
import {
  BLOCKING_STATES,
  TRANSITIONS,
  type BookingStatus,
} from '@domain/booking/lifecycle';

/** Every status the state machine can actually reach. */
const ALL_STATUSES: BookingStatus[] = [
  'draft',
  'held',
  'pending_payment',
  'pending_confirmation',
  'confirmed',
  'checked_in',
  'in_service',
  'completed',
  'settled',
  'cancelled',
  'no_show',
  'rescheduled',
  'expired',
  'skipped',
];

describe('toScreenStatus', () => {
  it('maps every status the domain has, with no gaps', () => {
    // THE POINT. A status added to the domain and not here would return
    // undefined and render as an empty pill in production.
    for (const s of ALL_STATUSES) {
      expect(toScreenStatus(s), s).toBeTypeOf('string');
    }
  });

  it('covers every status the transition table mentions', () => {
    const mentioned = new Set<BookingStatus>();
    for (const t of TRANSITIONS) {
      mentioned.add(t.from);
      mentioned.add(t.to);
    }
    for (const s of mentioned) {
      expect(ALL_STATUSES, `${s} missing from the spec's own list`).toContain(
        s,
      );
      expect(toScreenStatus(s), s).toBeTypeOf('string');
    }
  });

  it('never invents a status outside the ten', () => {
    const ten = new Set<ScreenStatus>([
      'PENDING_PAYMENT',
      'PENDING_CONFIRM',
      'CONFIRMED',
      'CHECKED_IN',
      'IN_SERVICE',
      'COMPLETED',
      'SETTLED',
      'NO_SHOW',
      'CANCELLED',
      'EXPIRED',
    ]);
    for (const s of ALL_STATUSES) {
      expect(ten.has(toScreenStatus(s)), `${s} -> ${toScreenStatus(s)}`).toBe(
        true,
      );
    }
  });

  it('is the shouted word wherever the two enums agree on one', () => {
    for (const s of ALL_STATUSES) {
      if (!isAmbiguous(s) && s !== 'pending_confirmation') {
        expect(toScreenStatus(s), s).toBe(s.toUpperCase());
      }
    }
  });

  it('flags exactly the statuses that share a screen word', () => {
    // PENDING_CONFIRM, CANCELLED and EXPIRED each take more than one of ours,
    // which is why statusDetail travels on every row.
    expect(ALL_STATUSES.filter(isAmbiguous).sort()).toEqual([
      'cancelled',
      'draft',
      'expired',
      'held',
      'pending_confirmation',
      'rescheduled',
      'skipped',
    ]);
  });

  it('renames rather than loses information where it is one to one', () => {
    expect(isAmbiguous('confirmed')).toBe(false);
    expect(isAmbiguous('no_show')).toBe(false);
    expect(isAmbiguous('settled')).toBe(false);
  });

  it('reports a given-up slot as a given-up slot', () => {
    expect(toScreenStatus('rescheduled')).toBe('CANCELLED');
    expect(toScreenStatus('skipped')).toBe('EXPIRED');
  });
});

describe('toScreenPayment', () => {
  it('maps all eight payment states', () => {
    for (const p of [
      'none_required',
      'unpaid',
      'deposit_paid',
      'fully_paid',
      'partially_refunded',
      'refunded',
      'forfeited',
      'settled',
    ] as const) {
      expect(toScreenPayment(p), p).toBeTypeOf('string');
    }
  });

  it('treats everything after settlement as money that was taken', () => {
    expect(toScreenPayment('refunded')).toBe('PAID');
    expect(toScreenPayment('forfeited')).toBe('PAID');
    expect(toScreenPayment('settled')).toBe('PAID');
  });

  it('distinguishes nothing owed from nothing paid', () => {
    expect(toScreenPayment('none_required')).toBe('NONE');
    expect(toScreenPayment('unpaid')).toBe('PENDING');
  });
});

describe('toDepositOutcome', () => {
  it('is null while the visit is still ahead', () => {
    expect(toDepositOutcome('deposit_paid')).toBeNull();
    expect(toDepositOutcome('unpaid')).toBeNull();
    expect(toDepositOutcome('none_required')).toBeNull();
  });

  it('names the outcome once there is one', () => {
    expect(toDepositOutcome('forfeited')).toBe('FORFEITED');
    expect(toDepositOutcome('refunded')).toBe('REFUNDED');
    expect(toDepositOutcome('partially_refunded')).toBe('REFUNDED');
    expect(toDepositOutcome('settled')).toBe('KEPT');
  });
});

describe('list filters', () => {
  it('recognises exactly the seven chips', () => {
    expect(LIST_FILTERS.length).toBe(7);
    for (const f of LIST_FILTERS) expect(isListFilter(f)).toBe(true);
  });

  it('rejects anything else, including a lowercased chip', () => {
    expect(isListFilter('today')).toBe(false);
    expect(isListFilter('EVERYTHING')).toBe(false);
    expect(isListFilter('')).toBe(false);
  });

  it('gives a status clause only to the chips that are one', () => {
    expect(statusesFor('DEPOSIT_PENDING')).toEqual(['pending_payment']);
    expect(statusesFor('UNCONFIRMED')).toEqual([
      'pending_confirmation',
      'pending_payment',
    ]);
    expect(statusesFor('ALL')).toBeNull();
    expect(statusesFor('TODAY')).toBeNull();
    expect(statusesFor('CONFLICTS')).toBeNull();
  });

  it('returns null rather than every status, so the two are distinguishable', () => {
    expect(statusesFor('ALL')).not.toEqual(LIVE_STATUSES);
  });
});

describe('LIVE_STATUSES', () => {
  it('is exactly what still occupies a chair', () => {
    // The diary shows what blocks capacity. Sharing the definition with the
    // engine is what stops the grid and the masks disagreeing (CLAUDE.md 4).
    expect([...LIVE_STATUSES].sort()).toEqual([...BLOCKING_STATES].sort());
  });
});

describe('calendar chips', () => {
  it('folds a chip to its stored statuses', () => {
    expect(statusesForChips(['checked_in'])).toEqual(['checked_in']);
  });

  it('upcoming is three statuses, not one', () => {
    expect(statusesForChips(['upcoming'])).toEqual([
      'pending_confirmation',
      'confirmed',
      'pending_payment',
    ]);
  });

  it('completed includes settled', () => {
    expect(statusesForChips(['completed'])).toEqual(['completed', 'settled']);
  });

  it('merges two chips without repeating a status', () => {
    expect(statusesForChips(['checked_in', 'in_service'])).toEqual([
      'checked_in',
      'in_service',
    ]);
  });

  /**
   * NULL, NOT EVERY STATUS. "No chip picked" and "every chip picked" are
   * different questions: the first falls back to LIVE_STATUSES, which hides
   * cancelled visits; the second would show them.
   */
  it('no chips means no filter', () => {
    expect(statusesForChips([])).toBeNull();
  });

  it('refuses a word that is not a chip', () => {
    expect(isCalendarChip('checkedin')).toBe(false);
    expect(isCalendarChip('checked_in')).toBe(true);
  });

  /**
   * The five with no chip. A draft or a held row has no business on a diary,
   * and rescheduled is a move, not a cancellation.
   */
  it('never shows draft, held, expired, skipped or rescheduled', () => {
    const shown = new Set(
      CALENDAR_CHIPS.flatMap((c) => statusesForChips([c]) ?? []),
    );
    for (const hidden of [
      'draft',
      'held',
      'expired',
      'skipped',
      'rescheduled',
    ]) {
      expect(shown.has(hidden as never)).toBe(false);
    }
  });
});

describe('payment chips', () => {
  /**
   * THE WHOLE REASON THIS TAKES TWO COLUMNS. Settling at the till writes
   * ledger rows and never touches payment_status, so the column alone would
   * report a paid-up customer as owing money.
   */
  it('counts a settled visit as fully paid whatever the column says', () => {
    expect(matchesPaymentChip('fully_paid', 'none_required', 'settled')).toBe(
      true,
    );
    expect(matchesPaymentChip('fully_paid', 'deposit_paid', 'settled')).toBe(
      true,
    );
    expect(matchesPaymentChip('fully_paid', 'unpaid', 'settled')).toBe(true);
  });

  it('does not call a settled visit unpaid or part-paid', () => {
    expect(matchesPaymentChip('unpaid', 'unpaid', 'settled')).toBe(false);
    expect(matchesPaymentChip('deposit_paid', 'deposit_paid', 'settled')).toBe(
      false,
    );
  });

  /** none_required means nothing was asked for up front, not "free". */
  it('treats a pay-at-salon booking as unpaid until it settles', () => {
    expect(matchesPaymentChip('unpaid', 'none_required', 'confirmed')).toBe(
      true,
    );
  });

  /** A late move keeps the visit and takes the deposit. It still owes. */
  it('treats a forfeited deposit on a live visit as unpaid', () => {
    expect(matchesPaymentChip('unpaid', 'forfeited', 'confirmed')).toBe(true);
  });

  it('reads deposit_paid off the column while the visit is live', () => {
    expect(
      matchesPaymentChip('deposit_paid', 'deposit_paid', 'confirmed'),
    ).toBe(true);
    expect(matchesPaymentChip('unpaid', 'deposit_paid', 'confirmed')).toBe(
      false,
    );
  });

  it('no chips means no filter', () => {
    expect(matchesAnyPaymentChip([], 'unpaid', 'confirmed')).toBe(true);
    expect(matchesAnyPaymentChip([], 'fully_paid', 'settled')).toBe(true);
  });

  it('any of the chosen chips is enough', () => {
    expect(
      matchesAnyPaymentChip(
        ['unpaid', 'deposit_paid'],
        'deposit_paid',
        'confirmed',
      ),
    ).toBe(true);
    expect(
      matchesAnyPaymentChip(
        ['unpaid', 'deposit_paid'],
        'fully_paid',
        'confirmed',
      ),
    ).toBe(false);
  });

  it('refuses a word that is not a payment chip', () => {
    expect(isPaymentChip('paid')).toBe(false);
    expect(isPaymentChip('fully_paid')).toBe(true);
  });
});

/** No booking may fall through every chip. */
it('puts a refund under fully paid rather than nowhere', () => {
  expect(matchesPaymentChip('fully_paid', 'refunded', 'completed')).toBe(true);
  expect(
    matchesPaymentChip('fully_paid', 'partially_refunded', 'completed'),
  ).toBe(true);
});

it('leaves no payment state unreachable by any chip', () => {
  const every = [
    'none_required',
    'unpaid',
    'deposit_paid',
    'fully_paid',
    'partially_refunded',
    'refunded',
    'forfeited',
    'settled',
  ];
  for (const p of every) {
    expect(matchesAnyPaymentChip([...PAYMENT_CHIPS], p, 'confirmed'), p).toBe(
      true,
    );
  }
});

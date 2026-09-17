import { describe, expect, it } from 'vitest';
import {
  LIST_FILTERS,
  LIVE_STATUSES,
  isListFilter,
  isAmbiguous,
  statusesFor,
  toDepositOutcome,
  toScreenPayment,
  toScreenStatus,
  type ScreenStatus,
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

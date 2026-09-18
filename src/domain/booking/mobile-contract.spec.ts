import { describe, expect, it } from 'vitest';
import {
  AMOUNT_TOLERANCE_FILS,
  aedToFils,
  amountsAgree,
  dateAgreesWithStart,
  filsToAed,
  refuseUnsupported,
  stylistsLineUp,
  toBranchMoment,
  toOffsetIso,
  toMobilePaymentStatus,
  toMobileStatus,
} from './mobile-contract';
import type { BookingStatus } from './lifecycle';

const DUBAI = 240;

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

describe('toMobileStatus', () => {
  it('maps every status the domain has', () => {
    for (const s of ALL_STATUSES)
      expect(toMobileStatus(s), s).toBeTypeOf('string');
  });

  it('calls both waiting states BOOKED, as the contract does', () => {
    expect(toMobileStatus('pending_payment')).toBe('BOOKED');
    expect(toMobileStatus('pending_confirmation')).toBe('BOOKED');
  });

  it('never invents a word outside the app’s five', () => {
    const five = new Set([
      'BOOKED',
      'CONFIRMED_BY_SALON',
      'CHECKED_IN',
      'COMPLETED',
      'CANCELLED',
    ]);
    for (const s of ALL_STATUSES)
      expect(five.has(toMobileStatus(s)), s).toBe(true);
  });
});

describe('toMobilePaymentStatus', () => {
  it('maps the four the contract names', () => {
    expect(toMobilePaymentStatus('unpaid')).toBe('DRAFT');
    expect(toMobilePaymentStatus('deposit_paid')).toBe('PARTIALLY');
    expect(toMobilePaymentStatus('fully_paid')).toBe('FULLY_PAID');
    expect(toMobilePaymentStatus('none_required')).toBe('PAY_AFTER_CHECK_IN');
  });

  it('maps every state we can store, including the post-settlement ones', () => {
    for (const p of [
      'unpaid',
      'none_required',
      'deposit_paid',
      'fully_paid',
      'partially_refunded',
      'refunded',
      'forfeited',
      'settled',
    ] as const) {
      expect(toMobilePaymentStatus(p), p).toBeTypeOf('string');
    }
  });
});

describe('aedToFils', () => {
  it('converts the contract’s own examples exactly', () => {
    expect(aedToFils(216.25)).toBe(21625);
    expect(aedToFils(11.25)).toBe(1125);
    expect(aedToFils(225)).toBe(22500);
    expect(aedToFils(0)).toBe(0);
  });

  it('survives the float cases that bite', () => {
    expect(aedToFils(0.1)).toBe(10);
    expect(aedToFils(0.29)).toBe(29);
    expect(aedToFils(1.15)).toBe(115);
    expect(aedToFils(162.18)).toBe(16218);
    expect(aedToFils(54.07)).toBe(5407);
  });

  it('REFUSES a third decimal rather than rounding it', () => {
    // Rounding 12.005 to 12.01 makes the server agree with a figure the
    // customer was never shown -- the exact thing §3 exists to catch.
    expect(aedToFils(12.005)).toBeNull();
    expect(aedToFils(0.001)).toBeNull();
  });

  it('refuses nonsense rather than producing NaN fils', () => {
    expect(aedToFils(Number.NaN)).toBeNull();
    expect(aedToFils(Number.POSITIVE_INFINITY)).toBeNull();
    expect(aedToFils(-1)).toBeNull();
  });
});

describe('filsToAed', () => {
  it('round-trips', () => {
    for (const aed of [0, 0.05, 11.25, 216.25, 1640]) {
      expect(filsToAed(aedToFils(aed)!)).toBe(aed);
    }
  });

  it('gives two decimals, not a float tail', () => {
    expect(filsToAed(21625)).toBe(216.25);
    expect(filsToAed(1)).toBe(0.01);
  });

  it('refuses a fractional fil at the boundary', () => {
    expect(() => filsToAed(10.5)).toThrow();
  });
});

describe('amountsAgree', () => {
  it('accepts an exact match', () => {
    expect(amountsAgree(21625, 21625)).toBe(true);
  });

  it('accepts one fil either way, because the two round at different points', () => {
    expect(amountsAgree(21625, 21626)).toBe(true);
    expect(amountsAgree(21625, 21624)).toBe(true);
  });

  it('refuses two fils — that is a different calculation', () => {
    expect(amountsAgree(21625, 21627)).toBe(false);
    expect(amountsAgree(21625, 21623)).toBe(false);
  });

  it('refuses a wholly different number', () => {
    expect(amountsAgree(21625, 23625)).toBe(false);
  });

  it('has a tolerance of exactly one minor unit', () => {
    expect(AMOUNT_TOLERANCE_FILS).toBe(1);
  });
});

describe('toBranchMoment', () => {
  it('reads the contract’s own example', () => {
    const m = toBranchMoment('2026-09-20T20:00:00+04:00', DUBAI);
    expect(m).toEqual({ tradingDay: '2026-09-20', minuteOfDay: 20 * 60 });
  });

  it('gives the SAME answer for the same instant written as UTC', () => {
    // The one that matters: a client in another timezone must not land the
    // booking four hours out.
    const local = toBranchMoment('2026-09-20T20:00:00+04:00', DUBAI);
    const utc = toBranchMoment('2026-09-20T16:00:00Z', DUBAI);
    expect(utc).toEqual(local);
  });

  it('rolls the trading day when the instant crosses branch midnight', () => {
    const m = toBranchMoment('2026-09-20T21:30:00Z', DUBAI);
    expect(m).toEqual({ tradingDay: '2026-09-21', minuteOfDay: 90 });
  });

  it('refuses a string that is not a time', () => {
    expect(toBranchMoment('not a date', DUBAI)).toBeNull();
    expect(toBranchMoment('', DUBAI)).toBeNull();
  });
});

describe('dateAgreesWithStart', () => {
  it('accepts a matching pair', () => {
    const m = toBranchMoment('2026-09-20T20:00:00+04:00', DUBAI)!;
    expect(dateAgreesWithStart('2026-09-20', m)).toBe(true);
  });

  it('refuses a pair that disagrees rather than picking one', () => {
    const m = toBranchMoment('2026-09-20T21:30:00Z', DUBAI)!; // 21st, branch-local
    expect(dateAgreesWithStart('2026-09-20', m)).toBe(false);
  });
});

describe('refuseUnsupported', () => {
  const ok = { products: [], bookingType: 'SINGLE', stylists: ['sty_liam'] };

  it('passes a payload this service can actually honour', () => {
    expect(refuseUnsupported(ok)).toBeNull();
    expect(refuseUnsupported({ ...ok, products: undefined })).toBeNull();
  });

  it('refuses products, because there is nothing to price them against', () => {
    const r = refuseUnsupported({ ...ok, products: [{ id: 'prd_pomade' }] });
    expect(r?.code).toBe('products_not_supported');
    expect(r?.field).toBe('products');
  });

  it('refuses ROUTINE, because the payload carries no recurrence rule', () => {
    const r = refuseUnsupported({ ...ok, bookingType: 'ROUTINE' });
    expect(r?.code).toBe('routine_not_supported');
  });

  it('refuses an empty stylist list rather than guessing a qualified one', () => {
    const r = refuseUnsupported({ ...ok, stylists: [] });
    expect(r?.code).toBe('stylist_required');
  });

  it('reports products first when a payload is wrong in several ways', () => {
    // Deterministic order, so the same bad payload always gets the same
    // error rather than a different one per deploy.
    const r = refuseUnsupported({
      products: [{}],
      bookingType: 'ROUTINE',
      stylists: [],
    });
    expect(r?.code).toBe('products_not_supported');
  });
});

describe('stylistsLineUp', () => {
  it('lets one stylist cover the whole visit', () => {
    expect(stylistsLineUp(['a'], [1, 2, 3])).toBe(true);
  });

  it('accepts one stylist per service, in order', () => {
    expect(stylistsLineUp(['a', 'b'], [1, 2])).toBe(true);
  });

  it('refuses a partial list, which is the ambiguity nobody can resolve', () => {
    expect(stylistsLineUp(['a', 'b'], [1, 2, 3])).toBe(false);
    expect(stylistsLineUp(['a', 'b', 'c'], [1, 2])).toBe(false);
  });
});

describe('toOffsetIso', () => {
  it('writes the branch offset, not Z', () => {
    // §8 always shows local time. An app slicing the first 16 characters
    // reads 16:00 off the Z form and shows the customer the wrong hour.
    const instant = new Date('2026-09-20T16:00:00Z');
    expect(toOffsetIso(instant, DUBAI)).toBe('2026-09-20T20:00:00+04:00');
  });

  it('round-trips through toBranchMoment', () => {
    const iso = toOffsetIso(new Date('2026-09-20T16:00:00Z'), DUBAI);
    expect(toBranchMoment(iso, DUBAI)).toEqual({
      tradingDay: '2026-09-20',
      minuteOfDay: 20 * 60,
    });
  });

  it('parses back to the same instant it was given', () => {
    const instant = new Date('2026-09-20T16:00:00Z');
    expect(Date.parse(toOffsetIso(instant, DUBAI))).toBe(instant.getTime());
  });

  it('handles a negative offset', () => {
    expect(toOffsetIso(new Date('2026-09-20T16:00:00Z'), -300)).toBe(
      '2026-09-20T11:00:00-05:00',
    );
  });

  it('handles a half-hour offset', () => {
    expect(toOffsetIso(new Date('2026-09-20T16:00:00Z'), 330)).toBe(
      '2026-09-20T21:30:00+05:30',
    );
  });
});

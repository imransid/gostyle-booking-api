import { describe, expect, it } from 'vitest';
import {
  AMOUNT_TOLERANCE_FILS,
  aedToFils,
  amountsAgree,
  checkPatch,
  createIntentOf,
  dateAgreesWithStart,
  filsToAed,
  methodToRail,
  paymentStatusAfterPatch,
  railToMethod,
  refuseUnsupported,
  stylistsLineUp,
  toBranchMoment,
  toMobilePaymentStatus,
  toMobileStatus,
  toOffsetIso,
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

  /**
   * PRODUCTS_FROM_PLATFORM, as the domain sees it: one boolean.
   *
   * The flag is read in infrastructure; what arrives here is the answer.
   * OMITTED MUST STILL REFUSE, because every other caller of this function
   * passes no such key and none of them can price a product -- a default of
   * "accepted" would let a basket through the group, desk and wizard paths
   * with nothing to check it against.
   */
  const pomade = [{ id: 'prd_pomade' }];

  it('still refuses products when productsAccepted is omitted', () => {
    expect(refuseUnsupported({ ...ok, products: pomade })?.code).toBe(
      'products_not_supported',
    );
  });

  it('still refuses products when productsAccepted is false', () => {
    const r = refuseUnsupported({
      ...ok,
      products: pomade,
      productsAccepted: false,
    });
    expect(r?.code).toBe('products_not_supported');
  });

  it('lets a basket through when productsAccepted is true', () => {
    expect(
      refuseUnsupported({ ...ok, products: pomade, productsAccepted: true }),
    ).toBeNull();
  });

  it.each([
    ['the string "true"', 'true'],
    ['the number 1', 1],
    ['an object', {}],
  ])('refuses products for %s, not only for false', (_name, value) => {
    // `productsAccepted !== true`, so a truthy stand-in from an untyped
    // caller refuses rather than sells.
    expect(
      refuseUnsupported({
        ...ok,
        products: pomade,
        productsAccepted: value as unknown as boolean,
      })?.code,
    ).toBe('products_not_supported');
  });

  it('does not let productsAccepted excuse ROUTINE', () => {
    const r = refuseUnsupported({
      ...ok,
      products: pomade,
      bookingType: 'ROUTINE',
      productsAccepted: true,
    });
    expect(r?.code).toBe('routine_not_supported');
  });

  it('does not let productsAccepted excuse an empty stylist list', () => {
    const r = refuseUnsupported({
      ...ok,
      products: pomade,
      stylists: [],
      productsAccepted: true,
    });
    expect(r?.code).toBe('stylist_required');
  });

  it('accepting products does not change what an empty basket answers', () => {
    expect(
      refuseUnsupported({ ...ok, products: [], productsAccepted: true }),
    ).toBeNull();
    expect(
      refuseUnsupported({ ...ok, products: undefined, productsAccepted: true }),
    ).toBeNull();
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

describe('payment method <-> rail', () => {
  it('round-trips every method the contract lists', () => {
    for (const m of ['WALLET', 'CARD', 'GOOGLE', 'APPLE', 'OTHERS'] as const) {
      expect(railToMethod(methodToRail(m)), m).toBe(m);
    }
  });

  it('keeps GOOGLE distinct from CARD', () => {
    // The reason the enum was widened. Folding GOOGLE into card returns the
    // wrong method on the §8 read and in a dispute.
    expect(methodToRail('GOOGLE')).toBe('google_pay');
    expect(methodToRail('CARD')).toBe('card');
    expect(railToMethod('google_pay')).toBe('GOOGLE');
  });

  it('gives null for a rail the app has no word for', () => {
    expect(railToMethod('link')).toBeNull();
    expect(railToMethod('internal')).toBeNull();
    expect(railToMethod(null)).toBeNull();
  });
});

describe('checkPatch', () => {
  const base = {
    target: 'PARTIALLY' as const,
    method: 'CARD' as const,
    advancePaidFils: 5000,
    dueFils: null,
    reference: 'pi_3Qk2xLJ8n',
    totalFils: 16800,
    requiredDepositFils: 0,
  };

  it('accepts a well-formed deposit', () => {
    expect(checkPatch(base)).toBeNull();
  });

  it('accepts a full payment', () => {
    expect(
      checkPatch({ ...base, target: 'FULLY_PAID', advancePaidFils: 16800 }),
    ).toBeNull();
  });

  it('refuses a move back to DRAFT', () => {
    expect(checkPatch({ ...base, target: 'DRAFT' })?.code).toBe(
      'invalid_payment_status',
    );
  });

  it('refuses an unknown status rather than ignoring it', () => {
    expect(checkPatch({ ...base, target: 'FAILED' })?.code).toBe(
      'invalid_payment_status',
    );
  });

  describe('PAY_AFTER_CHECK_IN', () => {
    const later = {
      ...base,
      target: 'PAY_AFTER_CHECK_IN' as const,
      advancePaidFils: 0,
      method: null,
      reference: null,
    };

    it('needs no method and no reference', () => {
      expect(checkPatch(later)).toBeNull();
    });

    it('refuses money that moved anyway', () => {
      const r = checkPatch({ ...later, advancePaidFils: 100 });
      expect(r?.code).toBe('amount_mismatch');
      expect(r?.expected).toBe(0);
    });
  });

  it('requires a method whenever money moved', () => {
    expect(checkPatch({ ...base, method: null })?.code).toBe(
      'missing_payment_reference',
    );
  });

  /**
   * RELAXED WHILE PAYMENT IS SIMULATED. §11.3 requires a gateway reference
   * whenever money moved, and that is what makes a payment recordable only
   * once. There is no gateway yet, so the rule only forced callers to invent
   * a fake id to satisfy a guard against a real gateway's retries.
   *
   * The test is inverted rather than deleted, so the day the check comes
   * back this fails and says where to look. The cost is written down in
   * `checkPatch`: with no reference, two identical patches are two payments.
   */
  it('accepts a payment with no reference, for now', () => {
    expect(checkPatch({ ...base, reference: null })).toBeNull();
    expect(checkPatch({ ...base, reference: '   ' })).toBeNull();
  });

  it('still takes a reference when one is sent', () => {
    // The plumbing stays wired: a reference that IS sent is stored and
    // still enforced unique, so restoring the rule rebuilds nothing.
    expect(checkPatch({ ...base, reference: 'pi_3Qk2xLJ8n' })).toBeNull();
  });

  it('refuses taking more than the booking is worth', () => {
    const r = checkPatch({ ...base, advancePaidFils: 20000 });
    expect(r?.code).toBe('amount_mismatch');
    expect(r?.expected).toBe(168);
  });

  it('refuses zero or negative money on a paid status', () => {
    expect(checkPatch({ ...base, advancePaidFils: 0 })?.code).toBe(
      'amount_mismatch',
    );
    expect(checkPatch({ ...base, advancePaidFils: -1 })?.code).toBe(
      'amount_mismatch',
    );
  });

  it('refuses FULLY_PAID that does not cover the total', () => {
    const r = checkPatch({
      ...base,
      target: 'FULLY_PAID',
      advancePaidFils: 5000,
    });
    expect(r?.code).toBe('amount_mismatch');
    expect(r?.expected).toBe(168);
  });

  it('allows FULLY_PAID a fil either way', () => {
    expect(
      checkPatch({ ...base, target: 'FULLY_PAID', advancePaidFils: 16801 }),
    ).toBeNull();
  });

  describe('the deposit bar', () => {
    const withRule = { ...base, requiredDepositFils: 8400 };

    it('refuses a deposit below what the ladder required', () => {
      const r = checkPatch({ ...withRule, advancePaidFils: 5000 });
      expect(r?.code).toBe('deposit_too_low');
      expect(r?.expected).toBe(84);
    });

    it('accepts one that clears it', () => {
      expect(checkPatch({ ...withRule, advancePaidFils: 8400 })).toBeNull();
    });

    it('does NOT apply the bar to a full payment', () => {
      // Paying everything satisfies any deposit rule. Checking it here
      // would refuse a customer for paying too much.
      expect(
        checkPatch({
          ...withRule,
          target: 'FULLY_PAID',
          advancePaidFils: 16800,
        }),
      ).toBeNull();
    });
  });

  describe('due_amount, when sent', () => {
    it('accepts the derived figure', () => {
      expect(checkPatch({ ...base, dueFils: 16800 - 5000 })).toBeNull();
    });

    it('refuses one that disagrees, and says the right number', () => {
      const r = checkPatch({ ...base, dueFils: 1 });
      expect(r?.code).toBe('amount_mismatch');
      expect(r?.field).toBe('due_amount');
      expect(r?.expected).toBe(118);
    });

    it('is optional', () => {
      expect(checkPatch({ ...base, dueFils: null })).toBeNull();
    });
  });
});

describe('paymentStatusAfterPatch', () => {
  it('maps the three targets onto stored states', () => {
    expect(paymentStatusAfterPatch('PARTIALLY')).toBe('deposit_paid');
    expect(paymentStatusAfterPatch('FULLY_PAID')).toBe('fully_paid');
    expect(paymentStatusAfterPatch('PAY_AFTER_CHECK_IN')).toBe('none_required');
  });

  it('round-trips back to the app’s word', () => {
    for (const t of [
      'PARTIALLY',
      'FULLY_PAID',
      'PAY_AFTER_CHECK_IN',
    ] as const) {
      expect(toMobilePaymentStatus(paymentStatusAfterPatch(t))).toBe(t);
    }
  });
});

describe('checkPatch reports every figure in decimal AED', () => {
  /**
   * The bug this pins: `expected` was returning fils on two branches and
   * AED on the others, so the app would have shown "expected 16800" as a
   * price on exactly the two refusals a customer is most likely to see.
   */
  const base = {
    target: 'PARTIALLY' as const,
    method: 'CARD' as const,
    advancePaidFils: 5000,
    dueFils: null,
    reference: 'pi_x',
    totalFils: 16800,
    requiredDepositFils: 0,
  };

  it.each([
    ['over the total', { advancePaidFils: 99_999 }],
    ['FULLY_PAID short', { target: 'FULLY_PAID' as const, advancePaidFils: 1 }],
    ['deposit too low', { requiredDepositFils: 8400, advancePaidFils: 100 }],
    ['due wrong', { dueFils: 1 }],
  ])('%s reports AED, never fils', (_label, patch) => {
    const r = checkPatch({ ...base, ...patch });
    expect(r).not.toBeNull();
    // Every figure this contract publishes is decimal AED with at most two
    // places; a fils value would be two orders of magnitude out.
    expect(r!.expected).toBeLessThan(1000);
    expect(aedToFils(r!.expected!)).not.toBeNull();
  });
});

describe('createIntentOf', () => {
  it('sends DRAFT down the payment-link path', () => {
    expect(createIntentOf('DRAFT')).toEqual({ kind: 'link' });
  });

  it('sends PAY_AFTER_CHECK_IN down the no-collection path', () => {
    // Not a draft that skipped payment. A link here would give the booking
    // a link_expires_at and hand it to the sweeper, which would cancel a
    // slot the salon agreed to hold.
    expect(createIntentOf('PAY_AFTER_CHECK_IN')).toEqual({
      kind: 'on_arrival',
    });
  });

  it('refuses money that has already moved', () => {
    // Recorded through §11, never declared at creation.
    expect(createIntentOf('PARTIALLY')).toBeNull();
    expect(createIntentOf('FULLY_PAID')).toBeNull();
  });

  it('refuses anything else, including case variants', () => {
    for (const v of ['', 'draft', 'pay_after_check_in', 'PAID', 'UNPAID']) {
      expect(createIntentOf(v)).toBeNull();
    }
  });

  it('round-trips with the outbound mapping', () => {
    // What create accepts must be what GET reports back, or the app sees a
    // status it never sent.
    expect(toMobilePaymentStatus('unpaid')).toBe('DRAFT');
    expect(toMobilePaymentStatus('none_required')).toBe('PAY_AFTER_CHECK_IN');
  });
});

describe('PAY_AFTER_CHECK_IN, and what it now means', () => {
  it('is still one of the two arrangements a create may ask for', () => {
    expect(createIntentOf('PAY_AFTER_CHECK_IN')).toEqual({
      kind: 'on_arrival',
    });
    expect(createIntentOf('DRAFT')).toEqual({ kind: 'link' });
  });

  it('is still refused money at creation', () => {
    /**
     * WHAT DID NOT CHANGE. The deposit is now DEFERRED for this
     * arrangement -- confirm no longer answers 402 when nothing is tendered
     * -- but "pay at the salon" still means nothing was taken NOW. A payload
     * claiming money moved is still a mismatch, because the two statements
     * cannot both be true.
     */
    const refusal = checkPatch({
      target: 'PAY_AFTER_CHECK_IN',
      method: null,
      advancePaidFils: 5000,
      dueFils: null,
      reference: null,
      totalFils: 36750,
      requiredDepositFils: 7000,
    });
    expect(refusal?.code).toBe('amount_mismatch');
    expect(refusal?.expected).toBe(0);
  });

  it('takes nothing now, whatever deposit the ladder asked for', () => {
    // The ladder still RUNS and the figure is still stored for the desk to
    // ask for on arrival. It just no longer refuses the booking, which is
    // what made this status unusable: every service required something.
    expect(
      checkPatch({
        target: 'PAY_AFTER_CHECK_IN',
        method: null,
        advancePaidFils: 0,
        dueFils: null,
        reference: null,
        totalFils: 36750,
        requiredDepositFils: 7000,
      }),
    ).toBeNull();
  });
});

import { describe, it, expect } from 'vitest';
import {
  quote,
  settle,
  VAT_PERCENT,
  DEFAULT_PROMO_PERCENT,
  type SettlementInput,
} from './quote';
import { Money } from '../shared/money';

const aed = (f: number): string => Money.fils(f).toString();

describe('THE WORKED EXAMPLE from the document', () => {
  const q = quote({
    serviceFils: 48000,
    addOnFils: 0,
    bundleDiscountFils: 0,
    tier: 'none',
    requirementFils: 24000,
  });

  it('net subtotal AED 480', () =>
    expect(aed(q.subtotalNetFils)).toBe('AED 480.00'));
  it('VAT AED 24', () => expect(aed(q.vatFils)).toBe('AED 24.00'));
  it('total AED 504', () => expect(aed(q.totalFils)).toBe('AED 504.00'));
  it('due now AED 240', () => expect(aed(q.dueNowFils)).toBe('AED 240.00'));
  it('AED 264 left at the register', () =>
    expect(aed(q.dueAtCheckoutFils)).toBe('AED 264.00'));
});

describe('VAT sits on the DISCOUNTED subtotal', () => {
  it('after a tier discount, not before', () => {
    const gold = quote({
      serviceFils: 48000,
      addOnFils: 0,
      bundleDiscountFils: 0,
      tier: 'gold',
      requirementFils: 24000,
    });
    // 480 - 48 = 432, VAT 21.60, total 453.60
    expect(aed(gold.tierDiscountFils)).toBe('AED 48.00');
    expect(aed(gold.vatFils)).toBe('AED 21.60');
    expect(aed(gold.totalFils)).toBe('AED 453.60');
  });

  it('after a bundle discount too', () => {
    const q = quote({
      serviceFils: 48000,
      addOnFils: 0,
      bundleDiscountFils: 8000,
      tier: 'none',
      requirementFils: 24000,
    });
    expect(aed(q.vatFils)).toBe('AED 20.00'); // 5% of 400
    expect(aed(q.totalFils)).toBe('AED 420.00');
  });

  it('add-ons are taxed like services', () => {
    const q = quote({
      serviceFils: 48000,
      addOnFils: 6000,
      bundleDiscountFils: 0,
      tier: 'none',
      requirementFils: 24000,
    });
    expect(aed(q.vatFils)).toBe('AED 27.00'); // 5% of 540
  });
});

describe('THE DEPOSIT IS UNTOUCHED BY EITHER', () => {
  it('a discount does not shrink it', () => {
    const gold = quote({
      serviceFils: 48000,
      addOnFils: 0,
      bundleDiscountFils: 0,
      tier: 'gold',
      requirementFils: 24000,
    });
    // The discount cut the total by AED 48; the deposit did not move.
    expect(aed(gold.dueNowFils)).toBe('AED 240.00');
  });

  it('and VAT does not inflate it', () => {
    // 50% of the NET 480, not of the 504 total.
    const q = quote({
      serviceFils: 48000,
      addOnFils: 0,
      bundleDiscountFils: 0,
      tier: 'none',
      requirementFils: 24000,
    });
    expect(q.dueNowFils).toBe(24000);
    expect(q.dueNowFils).not.toBe(Money.fils(50400).percent(50).fils);
  });

  it('the line says so on screen', () => {
    const q = quote({
      serviceFils: 48000,
      addOnFils: 0,
      bundleDiscountFils: 0,
      tier: 'none',
      requirementFils: 24000,
    });
    const due = q.lines.find((l) => l.label === 'Due now')!;
    expect(due.note).toBe('on pre-discount total');
  });
});

describe('the quote lines', () => {
  it('shows only the lines that apply', () => {
    const plain = quote({
      serviceFils: 48000,
      addOnFils: 0,
      bundleDiscountFils: 0,
      tier: 'none',
      requirementFils: 0,
    });
    expect(plain.lines.map((l) => l.label)).toEqual([
      'Subtotal (net)',
      'VAT 5%',
      'Total',
      'Due now',
    ]);
  });

  it('and every line when they all do', () => {
    const full = quote({
      serviceFils: 48000,
      addOnFils: 6000,
      bundleDiscountFils: 4000,
      tier: 'gold',
      requirementFils: 24000,
    });
    expect(full.lines.map((l) => l.label)).toEqual([
      'Subtotal (net)',
      'Add-ons',
      'Bundle discount',
      'Tier discount',
      'VAT 5%',
      'Total',
      'Due now',
    ]);
  });

  it('discounts are marked negative so the column adds up', () => {
    const q = quote({
      serviceFils: 48000,
      addOnFils: 0,
      bundleDiscountFils: 4000,
      tier: 'gold',
      requirementFils: 0,
    });
    expect(q.lines.filter((l) => l.negative).map((l) => l.label)).toEqual([
      'Bundle discount',
      'Tier discount',
    ]);
  });

  it('a deposit larger than the total leaves nothing due, not a negative', () => {
    const q = quote({
      serviceFils: 48000,
      addOnFils: 0,
      bundleDiscountFils: 0,
      tier: 'none',
      requirementFils: 60000,
    });
    expect(q.dueAtCheckoutFils).toBe(0);
  });
});

// ---------------------------------------------------------------- settlement

function bill(over: Partial<SettlementInput> = {}) {
  return settle({
    serviceFils: 48000,
    addOnFils: 0,
    retailFils: 0,
    tier: 'none',
    promo: null,
    depositAppliedFils: 0,
    loyaltyRedeemFils: 0,
    ...over,
  });
}

describe('the settlement arithmetic', () => {
  it('a plain ticket matches the quote', () => {
    const s = bill();
    expect(aed(s.baseFils)).toBe('AED 480.00');
    expect(aed(s.vatFils)).toBe('AED 24.00');
    expect(aed(s.dueFils)).toBe('AED 504.00');
  });

  it('DEPOSITS ARE TENDER, NOT DISCOUNTS: taken off AFTER VAT', () => {
    const s = bill({ depositAppliedFils: 24000 });
    // VAT is still on the full 480, not on 240.
    expect(aed(s.vatFils)).toBe('AED 24.00');
    expect(aed(s.dueFils)).toBe('AED 264.00');
  });

  it('subtracting the deposit before VAT would understate the tax', () => {
    const withDeposit = bill({ depositAppliedFils: 24000 });
    const without = bill();
    // Same tax either way. The deposit is a payment, not a price change.
    expect(withDeposit.vatFils).toBe(without.vatFils);
  });

  it('the tier discount is on services, never on retail', () => {
    const s = bill({ retailFils: 10000, tier: 'gold' });
    expect(aed(s.tierDiscountFils)).toBe('AED 48.00'); // 10% of 480, not 580
  });

  it('a promo stacks on top of the tier discount, not beside it', () => {
    const s = bill({ tier: 'gold', promo: { code: 'HOUSE', percent: 10 } });
    // 10% of (480 - 48) = 43.20
    expect(aed(s.promoFils)).toBe('AED 43.20');
    expect(aed(s.baseFils)).toBe('AED 388.80');
  });
});

describe('the promo rate rides on the code', () => {
  it('takes the rate the code carries, not a house-wide percentage', () => {
    const twenty = bill({ promo: { code: 'SUMMER20', percent: 20 } });
    const five = bill({ promo: { code: 'FRIEND5', percent: 5 } });
    expect(aed(twenty.promoFils)).toBe('AED 96.00'); // 20% of 480
    expect(aed(five.promoFils)).toBe('AED 24.00'); //  5% of 480
  });

  it('falls back to the house default when the code names no rate', () => {
    const s = bill({ promo: { code: 'PLAIN' } });
    expect(s.promoPercent).toBe(DEFAULT_PROMO_PERCENT);
    expect(aed(s.promoFils)).toBe('AED 48.00');
  });

  it('names the code on the settlement so the receipt can print it', () => {
    const s = bill({ promo: { code: 'SUMMER20', percent: 20 } });
    expect(s.promoCode).toBe('SUMMER20');
    expect(s.promoPercent).toBe(20);
  });

  it('reports no code and no rate when none was presented', () => {
    const s = bill();
    expect(s.promoCode).toBeNull();
    expect(s.promoPercent).toBe(0);
    expect(s.promoFils).toBe(0);
  });

  it('a zero-rate code takes nothing and names nothing', () => {
    const s = bill({ promo: { code: 'EXPIRED', percent: 0 } });
    expect(s.promoFils).toBe(0);
    expect(s.promoCode).toBeNull();
  });

  it('still stacks after the tier discount at any rate', () => {
    const s = bill({ tier: 'gold', promo: { code: 'SUMMER20', percent: 20 } });
    // 20% of (480 - 48) = 86.40
    expect(aed(s.promoFils)).toBe('AED 86.40');
  });

  it('refuses a rate outside 0 to 100', () => {
    expect(() => bill({ promo: { code: 'BAD', percent: 120 } })).toThrow(
      /0 to 100/,
    );
    expect(() => bill({ promo: { code: 'BAD', percent: -5 } })).toThrow(
      /0 to 100/,
    );
  });
});

describe('tips', () => {
  it('NOBODY TIPS ON RETAIL', () => {
    const s = bill({ retailFils: 10000, tipPercent: 10 });
    // 10% of 480, not of 580.
    expect(aed(s.tipFils)).toBe('AED 48.00');
  });

  it('a custom amount is taken as given', () => {
    expect(aed(bill({ tipFils: 5000 }).tipFils)).toBe('AED 50.00');
  });

  it('no tip is not a tip of zero percent, it is no line at all', () => {
    expect(bill().tipFils).toBe(0);
  });

  it('a tip is charged fresh, on top of everything', () => {
    const s = bill({ tipFils: 5000, depositAppliedFils: 24000 });
    // 480 + 50 tip + 24 VAT - 240 deposit
    expect(aed(s.dueFils)).toBe('AED 314.00');
  });

  it('and is never drawn from the deposit', () => {
    const withTip = bill({ tipFils: 5000, depositAppliedFils: 24000 });
    const without = bill({ depositAppliedFils: 24000 });
    expect(withTip.dueFils - without.dueFils).toBe(5000);
  });
});

describe('OVERPAYMENT IS CREDITED, NOT KEPT', () => {
  it('a bill below the prepaid amount leaves the customer in credit', () => {
    // Prepaid AED 504 in full, then a service was dropped.
    const s = bill({ serviceFils: 16000, depositAppliedFils: 50400 });
    // 160 + 8 VAT = 168 due, against 504 paid.
    expect(s.dueFils).toBe(0);
    expect(aed(s.creditFils)).toBe('AED 336.00');
  });

  it('due never goes negative', () => {
    expect(bill({ depositAppliedFils: 999999 }).dueFils).toBe(0);
  });

  it('exactly settled is neither due nor credit', () => {
    const s = bill({ depositAppliedFils: 50400 });
    expect(s.dueFils).toBe(0);
    expect(s.creditFils).toBe(0);
  });

  it('loyalty redemption behaves the same way', () => {
    const s = bill({ loyaltyRedeemFils: 60000 });
    expect(s.dueFils).toBe(0);
    expect(aed(s.creditFils)).toBe('AED 96.00');
  });
});

describe('a manager may zero the VAT, and must say why', () => {
  it('the exemption removes the tax', () => {
    const s = bill({ taxExemptReason: 'diplomatic exemption on file' });
    expect(s.vatFils).toBe(0);
    expect(s.taxExempt).toBe(true);
    expect(aed(s.dueFils)).toBe('AED 480.00');
  });

  it('and without one the tax stands', () => {
    expect(bill().taxExempt).toBe(false);
  });
});

describe('invariants', () => {
  const cases = [
    { serviceFils: 48000, retailFils: 0 },
    { serviceFils: 16000, retailFils: 10000 },
    { serviceFils: 500, retailFils: 0 },
    { serviceFils: 500000, retailFils: 25000 },
  ];

  it('due and credit are never both non-zero', () => {
    for (const c of cases)
      for (const deposit of [0, 10000, 999999])
        for (const tier of ['none', 'gold'] as const) {
          const s = bill({ ...c, depositAppliedFils: deposit, tier });
          expect(s.dueFils === 0 || s.creditFils === 0).toBe(true);
        }
  });

  it('neither is ever negative', () => {
    for (const c of cases)
      for (const deposit of [0, 10000, 999999]) {
        const s = bill({ ...c, depositAppliedFils: deposit });
        expect(s.dueFils).toBeGreaterThanOrEqual(0);
        expect(s.creditFils).toBeGreaterThanOrEqual(0);
      }
  });

  it('the books balance: base + tip + VAT = due + deposit + loyalty - credit', () => {
    for (const c of cases)
      for (const deposit of [0, 10000, 999999])
        for (const tipFils of [0, 5000]) {
          const s = bill({
            ...c,
            depositAppliedFils: deposit,
            tipFils,
            loyaltyRedeemFils: 2000,
          });
          const charged = s.baseFils + s.tipFils + s.vatFils;
          const settled =
            s.dueFils +
            s.depositAppliedFils +
            s.loyaltyRedeemFils -
            s.creditFils;
          expect(charged).toBe(settled);
        }
  });

  it('a discount never raises the total', () => {
    for (const c of cases) {
      expect(bill({ ...c, tier: 'gold' }).dueFils).toBeLessThanOrEqual(
        bill({ ...c, tier: 'none' }).dueFils,
      );
    }
  });

  it('VAT is always exactly 5% of the base, or zero', () => {
    for (const c of cases)
      for (const tier of ['none', 'gold'] as const) {
        const s = bill({ ...c, tier });
        expect(s.vatFils).toBe(
          Money.fils(s.baseFils).percent(VAT_PERCENT).fils,
        );
      }
  });
});

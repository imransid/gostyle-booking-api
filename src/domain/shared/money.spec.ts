import { describe, it, expect } from 'vitest';
import { Money } from './money';

describe('Money: construction', () => {
  it('converts dirhams to fils', () => {
    expect(Money.aed(480).fils).toBe(48000);
    expect(Money.aed(34.29).fils).toBe(3429);
  });

  it('refuses a fractional fil', () => {
    expect(() => Money.fils(3428.5)).toThrow();
  });
});

describe('Money: the deposit from the worked example', () => {
  const FLOOR = Money.aed(10);
  const CEILING = Money.aed(500);

  it('Full color and gloss, service rule 50 percent', () => {
    const deposit = Money.aed(480).percent(50);
    expect(deposit.fils).toBe(24000);
    expect(deposit.toDisplay()).toBe('240.00');
  });

  it('raises to the branch floor of AED 10', () => {
    expect(Money.aed(20).percent(20).clamp(FLOOR, CEILING).toDisplay()).toBe(
      '10.00',
    );
  });

  it('caps at the branch ceiling of AED 500', () => {
    expect(Money.aed(2000).percent(50).clamp(FLOOR, CEILING).toDisplay()).toBe(
      '500.00',
    );
  });

  it('leaves an in-range amount alone', () => {
    const d = Money.aed(480).percent(50);
    expect(d.clamp(FLOOR, CEILING).equals(d)).toBe(true);
  });
});

describe('Money: strictest rung wins', () => {
  it('50 percent service rule beats the 20 percent first-visit rule', () => {
    const serviceRule = Money.aed(480).percent(50);
    const firstVisitRule = Money.aed(480).percent(20);
    expect(Money.max(serviceRule, firstVisitRule).toDisplay()).toBe('240.00');
  });

  it('fixed AED 400 keratin deposit beats the computed percentage', () => {
    const computed = Money.aed(850).percent(20);
    const fixed = Money.aed(400);
    expect(Money.max(computed, fixed).toDisplay()).toBe('400.00');
  });
});

describe('Money: split always sums back to the whole', () => {
  const cases: Array<[number, number]> = [
    [24000, 7],
    [10000, 3],
    [9600, 7],
    [4400, 3],
    [32130, 3],
    [1, 5],
    [0, 4],
  ];

  for (const [total, parts] of cases) {
    it(`${total} fils across ${parts} people`, () => {
      const shares = Money.fils(total).split(parts);
      expect(shares).toHaveLength(parts);
      expect(Money.sum(shares).fils).toBe(total);
    });
  }

  it('AED 240 across 7 gives four 34.29 and three 34.28', () => {
    const shares = Money.fils(24000)
      .split(7)
      .map((m) => m.fils);
    expect(shares).toEqual([3429, 3429, 3429, 3429, 3428, 3428, 3428]);
  });

  it('no two shares differ by more than one fil', () => {
    const v = Money.fils(24000)
      .split(7)
      .map((m) => m.fils);
    expect(Math.max(...v) - Math.min(...v)).toBeLessThanOrEqual(1);
  });

  it('the naive decimal split would have been wrong', () => {
    expect(Number((240 / 7).toFixed(2)) * 7).not.toBe(240);
    expect(Money.sum(Money.fils(24000).split(7)).fils).toBe(24000);
  });
});

describe('Money: tips distributed by service value', () => {
  it('AED 61 tip across three professionals, in proportion to work done', () => {
    const tip = Money.aed(61);
    const shares = tip.allocate([480, 140, 62]);
    expect(Money.sum(shares).equals(tip)).toBe(true);
    expect(shares.map((m) => m.toDisplay())).toEqual([
      '42.93',
      '12.52',
      '5.55',
    ]);
  });

  it('a zero-weight participant gets nothing, and the rest still balances', () => {
    const tip = Money.aed(100);
    const shares = tip.allocate([1, 0, 1]);
    expect(shares[1]?.isZero()).toBe(true);
    expect(Money.sum(shares).equals(tip)).toBe(true);
  });

  it('refuses weights that sum to zero', () => {
    expect(() => Money.aed(100).allocate([0, 0])).toThrow();
  });

  it('refuses a negative weight', () => {
    expect(() => Money.aed(100).allocate([1, -1])).toThrow();
  });
});

describe('Money: a negative total allocates the same way', () => {
  it('bundle discount spread across the package parts', () => {
    const parts = [Money.aed(480), Money.aed(220), Money.aed(180)];
    const sumOfParts = Money.sum(parts);
    const bundlePrice = Money.aed(790);
    const discount = bundlePrice.minus(sumOfParts);

    expect(discount.toDisplay()).toBe('-90.00');

    const spread = discount.allocate(parts.map((p) => p.fils));
    expect(Money.sum(spread).equals(discount)).toBe(true);
    expect(spread.every((s) => s.isNegative())).toBe(true);
  });
});

describe('Money: settlement arithmetic', () => {
  it('due = base + vat - deposit applied, and it balances', () => {
    const services = Money.aed(660);
    const base = services.minus(services.percent(10));
    const vat = base.percent(5);
    const depositApplied = Money.aed(240);

    const total = base.plus(vat);
    const due = total.minus(depositApplied);

    expect(base.toDisplay()).toBe('594.00');
    expect(vat.toDisplay()).toBe('29.70');
    expect(total.toDisplay()).toBe('623.70');
    expect(due.toDisplay()).toBe('383.70');

    expect(due.plus(depositApplied).equals(total)).toBe(true);
  });

  it('overpayment surfaces as negative, never silently kept', () => {
    const due = Money.aed(180).minus(Money.aed(240));
    expect(due.isNegative()).toBe(true);
    expect(due.toDisplay()).toBe('-60.00');
    expect(due.negate().toDisplay()).toBe('60.00');
  });
});

describe('Money: allocation never loses or invents a fil', () => {
  it('holds across 400 randomised allocations', () => {
    for (let t = 0; t < 400; t++) {
      const total = Math.floor(Math.random() * 200000) - 50000;
      const n = 1 + Math.floor(Math.random() * 9);
      const weights = Array.from(
        { length: n },
        () => Math.floor(Math.random() * 1000) + 1,
      );
      const shares = Money.fils(total).allocate(weights);
      expect(Money.sum(shares).fils).toBe(total);
    }
  });
});

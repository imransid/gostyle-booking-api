import { describe, it, expect } from 'vitest';
import { planDraws, nextDraw, courseState } from './course';
import { Money } from '../shared/money';
import { VAT_PERCENT } from './quote';

// A six-visit keratin course at AED 1,800 net.
const KERATIN = { totalNetFils: 180_000, visits: 6 };

describe('the draw schedule', () => {
  it('gives one draw per visit', () => {
    expect(planDraws(KERATIN).length).toBe(6);
  });

  it('draws an equal amount when the price divides cleanly', () => {
    const draws = planDraws(KERATIN);
    expect(draws.every((d) => d.netFils === 30_000)).toBe(true);
  });

  it('recognises VAT per draw, not at the point of sale', () => {
    const draws = planDraws(KERATIN);
    // 5% of 30,000 net is 1,500 per visit.
    expect(draws.every((d) => d.vatFils === 1_500)).toBe(true);
    expect(draws.every((d) => d.grossFils === 31_500)).toBe(true);
  });

  it('sums the net back to exactly what was sold', () => {
    const draws = planDraws(KERATIN);
    const net = Money.sum(draws.map((d) => Money.fils(d.netFils)));
    expect(net.fils).toBe(KERATIN.totalNetFils);
  });

  it('sums the VAT back to the VAT on the original receipt', () => {
    const draws = planDraws(KERATIN);
    const vat = Money.sum(draws.map((d) => Money.fils(d.vatFils)));
    expect(vat.fils).toBe(
      Money.fils(KERATIN.totalNetFils).percent(VAT_PERCENT).fils,
    );
  });
});

describe('a price that does not divide cleanly', () => {
  // AED 100 across 3 visits: 3333.33 fils each, which is not a thing.
  const AWKWARD = { totalNetFils: 10_000, visits: 3 };

  it('still sums back to the whole', () => {
    const draws = planDraws(AWKWARD);
    const net = Money.sum(draws.map((d) => Money.fils(d.netFils)));
    expect(net.fils).toBe(10_000);
  });

  it('spreads the remainder rather than dropping it', () => {
    const draws = planDraws(AWKWARD);
    expect(draws.map((d) => d.netFils)).toEqual([3_334, 3_333, 3_333]);
  });

  it('never leaves a fractional fil anywhere', () => {
    for (const d of planDraws(AWKWARD)) {
      expect(Number.isInteger(d.netFils)).toBe(true);
      expect(Number.isInteger(d.vatFils)).toBe(true);
      expect(Number.isInteger(d.grossFils)).toBe(true);
    }
  });

  it('closes at exactly zero even so', () => {
    const draws = planDraws(AWKWARD);
    expect(draws.at(-1)?.remainingAfterFils).toBe(0);
  });
});

describe('the final draw', () => {
  it('ends the course at a zero balance', () => {
    const draws = planDraws(KERATIN);
    const last = draws.at(-1);
    expect(last?.endsCourse).toBe(true);
    expect(last?.remainingAfterFils).toBe(0);
  });

  it('is the only draw that ends it', () => {
    const draws = planDraws(KERATIN);
    expect(draws.filter((d) => d.endsCourse).length).toBe(1);
  });

  it('leaves the meter falling monotonically', () => {
    const draws = planDraws(KERATIN);
    for (let i = 1; i < draws.length; i += 1) {
      expect(draws[i]?.remainingAfterFils).toBeLessThan(
        draws[i - 1]?.remainingAfterFils ?? Infinity,
      );
    }
  });
});

describe('the meter on the series panel', () => {
  it('starts full', () => {
    const s = courseState(KERATIN, 0);
    expect(s.drawnGrossFils).toBe(0);
    expect(s.remainingGrossFils).toBe(s.totalGrossFils);
    expect(s.exhausted).toBe(false);
  });

  it('falls by one visit at a time', () => {
    const s = courseState(KERATIN, 2);
    expect(s.drawnCount).toBe(2);
    expect(s.drawnGrossFils).toBe(63_000);
    expect(s.remainingGrossFils).toBe(189_000 - 63_000);
  });

  it('reads empty and exhausted after the last visit', () => {
    const s = courseState(KERATIN, 6);
    expect(s.remainingGrossFils).toBe(0);
    expect(s.exhausted).toBe(true);
    expect(s.explanation).toMatch(/zero balance/);
  });

  it('does not go negative when asked about more visits than were sold', () => {
    const s = courseState(KERATIN, 99);
    expect(s.remainingGrossFils).toBe(0);
    expect(s.drawnCount).toBe(6);
  });

  it('quotes the remaining balance in dirhams for the panel', () => {
    expect(courseState(KERATIN, 1).explanation).toMatch(
      /AED 1,?575\.00|AED 1575\.00/,
    );
  });
});

describe('drawing one at a time', () => {
  it('hands back the next unused draw', () => {
    expect(nextDraw(KERATIN, 0)?.index).toBe(0);
    expect(nextDraw(KERATIN, 3)?.index).toBe(3);
  });

  it('returns null once the course is spent', () => {
    expect(nextDraw(KERATIN, 6)).toBeNull();
  });
});

describe('a course that makes no sense', () => {
  it('refuses zero visits', () => {
    expect(() => planDraws({ totalNetFils: 1000, visits: 0 })).toThrow(
      /at least one visit/,
    );
  });

  it('refuses a fractional visit count', () => {
    expect(() => planDraws({ totalNetFils: 1000, visits: 2.5 })).toThrow();
  });

  it('refuses a negative sale', () => {
    expect(() => planDraws({ totalNetFils: -1000, visits: 3 })).toThrow(
      /negative/,
    );
  });

  it('allows a single-visit course', () => {
    const draws = planDraws({ totalNetFils: 5_000, visits: 1 });
    expect(draws.length).toBe(1);
    expect(draws[0]?.endsCourse).toBe(true);
    expect(draws[0]?.remainingAfterFils).toBe(0);
  });
});

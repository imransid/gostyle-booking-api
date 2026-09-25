import { describe, expect, it } from 'vitest';
import {
  CHILD_SERVICE_PERCENT,
  chargedServiceFils,
  groupMoney,
  servicesVatFils,
  type MemberBasket,
} from './group-money';
import { productMoney } from './mobile-products';
import { storedTotalFils } from './stored-money';

const adult = (
  serviceFils: number[],
  products: MemberBasket['products'] = [],
): MemberBasket => ({ ageGroup: 'adult', serviceFils, products });
const child = (
  serviceFils: number[],
  products: MemberBasket['products'] = [],
): MemberBasket => ({ ageGroup: 'child', serviceFils, products });

/**
 * A party whose figures are the spec's own (§4, §6): 685 net, 34.25 VAT,
 * 719.25 total, 143.85 deposit at 20%. The spec's example members do not add
 * up to its 685, so this party is built to: two adults, and two children
 * whose list prices are halved.
 */
const SPEC_PARTY: MemberBasket[] = [
  adult([25_000], [{ priceFils: 2_500, quantity: 1 }]),
  adult([25_000]),
  child([24_000], [{ priceFils: 1_500, quantity: 1 }]),
  child([5_000]),
];

describe('the child price', () => {
  it('is half of each service, as the spec says', () => {
    expect(CHILD_SERVICE_PERCENT).toBe(50);
    expect(chargedServiceFils(24_000, 'child')).toBe(12_000);
    expect(chargedServiceFils(24_000, 'adult')).toBe(24_000);
  });

  it('rounds a half fil once, the Money way', () => {
    expect(chargedServiceFils(12_345, 'child')).toBe(6_173);
  });

  it('never touches products', () => {
    const m = groupMoney(
      [child([10_000], [{ priceFils: 4_000, quantity: 2 }]), adult([10_000])],
      0,
    );
    expect(m.members[0]!.servicesNetFils).toBe(5_000);
    expect(m.members[0]!.productsNetFils).toBe(8_000);
  });
});

describe('the spec example', () => {
  const m = groupMoney(SPEC_PARTY, 20);

  it('comes to 685 net, 34.25 VAT, 719.25 total', () => {
    expect(m.netFils).toBe(68_500);
    expect(m.vatFils).toBe(3_425);
    expect(m.discountFils).toBe(0);
    expect(m.totalFils).toBe(71_925);
  });

  it('holds a 143.85 deposit at 20%', () => {
    expect(m.depositPercent).toBe(20);
    expect(m.depositFils).toBe(14_385);
  });

  it('gives each member their own share', () => {
    expect(m.members.map((x) => x.netFils)).toEqual([
      27_500, 25_000, 13_500, 2_500,
    ]);
    expect(m.members.map((x) => x.vatFils)).toEqual([1_375, 1_250, 675, 125]);
    expect(m.members.map((x) => x.totalFils)).toEqual([
      28_875, 26_250, 14_175, 2_625,
    ]);
    expect(m.members.map((x) => x.depositFils)).toEqual([
      5_775, 5_250, 2_835, 525,
    ]);
  });
});

describe('the members always add back up to the party', () => {
  // Odd fils everywhere, so every percent and every split has a remainder.
  const party: MemberBasket[] = [
    adult([10_001, 3_333], [{ priceFils: 999, quantity: 3 }]),
    child([7_777]),
    adult([1]),
    child([12_345, 1], [{ priceFils: 1_111, quantity: 1 }]),
    adult([4_444]),
    adult([8_889]),
    child([3]),
    adult([6_667], [{ priceFils: 7, quantity: 99 }]),
  ];
  const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0);

  for (const percent of [0, 1, 20, 33, 100]) {
    it(`at ${percent}%`, () => {
      const m = groupMoney(party, percent);
      expect(sum(m.members.map((x) => x.netFils))).toBe(m.netFils);
      expect(sum(m.members.map((x) => x.vatFils))).toBe(m.vatFils);
      expect(sum(m.members.map((x) => x.totalFils))).toBe(m.totalFils);
      expect(sum(m.members.map((x) => x.depositFils))).toBe(m.depositFils);
      expect(m.totalFils).toBe(m.netFils + m.vatFils);
    });
  }

  it('rounds VAT once on the party, not once per member', () => {
    // Three members at 1.10 each: 5% is 5.5 fils apiece. Rounded per member
    // that is 18 fils; on the party's 330 it is 17.
    const m = groupMoney([adult([110]), adult([110]), adult([110])], 0);
    expect(m.vatFils).toBe(17);
    expect(sum(m.members.map((x) => x.vatFils))).toBe(17);
  });
});

describe('a party that costs nothing', () => {
  it('owes nothing and splits nothing, rather than throwing', () => {
    const m = groupMoney([adult([0]), child([0])], 20);
    expect(m.totalFils).toBe(0);
    expect(m.members.map((x) => x.depositFils)).toEqual([0, 0]);
  });
});

describe('refusals', () => {
  it('needs members', () => {
    expect(() => groupMoney([], 20)).toThrow(/members/);
  });

  it.each([-1, 101, 12.5, Number.NaN])('refuses a %s percent deposit', (p) => {
    expect(() => groupMoney(SPEC_PARTY, p)).toThrow(/depositPercent/);
  });
});

describe('what a member row stores', () => {
  it('adds back up to the member total by the single read arithmetic', () => {
    const m = groupMoney(SPEC_PARTY, 20);
    SPEC_PARTY.forEach((basket, i) => {
      const member = m.members[i]!;
      const row = {
        netFils: member.servicesNetFils,
        taxFils: servicesVatFils(member, basket.products),
        discountFils: 0,
      };
      expect(
        storedTotalFils(row)! + productMoney(basket.products).totalFils,
      ).toBe(member.totalFils);
    });
  });
});

import { describe, it, expect } from 'vitest';
import {
  expandPackage,
  findPackage,
  resolveSelection,
  type ServicePackage,
} from './package';

const PRICES: Record<string, number> = {
  'full-colour': 48_000,
  'blow-dry': 14_000,
  'luxury-facial': 32_000,
  'gel-manicure': 12_000,
};
const priceOf = (id: string): number => PRICES[id] ?? 0;

const COLOUR_AND_FINISH: ServicePackage = {
  id: 'colour-and-finish',
  name: 'Colour and finish',
  serviceIds: ['full-colour', 'blow-dry'],
  priceFils: 56_000, // parts are 62,000
};

const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0);

describe('expanding a package', () => {
  it('produces the services in order', () => {
    expect(expandPackage(COLOUR_AND_FINISH, priceOf).serviceIds).toEqual([
      'full-colour',
      'blow-dry',
    ]);
  });

  it('totals what the parts would cost separately', () => {
    expect(expandPackage(COLOUR_AND_FINISH, priceOf).partsTotalFils).toBe(
      62_000,
    );
  });

  it('charges the package price, carried by the parts', () => {
    const e = expandPackage(COLOUR_AND_FINISH, priceOf);
    expect(e.packagePriceFils).toBe(56_000);
    expect(sum(e.partPricesFils)).toBe(56_000);
  });

  it('shares the price out in proportion to what each part costs alone', () => {
    // 56,000 x 48/62 = 43,354.8... and 56,000 x 14/62 = 12,645.1...: the
    // spare fil goes to the larger remainder, and nothing is lost.
    expect(expandPackage(COLOUR_AND_FINISH, priceOf).partPricesFils).toEqual([
      43_355, 12_645,
    ]);
  });

  it('works out the saving for display', () => {
    const e = expandPackage(COLOUR_AND_FINISH, priceOf);
    expect(e.savingFils).toBe(6_000);
    expect(e.explanation).toMatch(
      /AED 60\.00 less than booking them separately/,
    );
  });

  it('allows a package priced exactly at its parts', () => {
    const e = expandPackage(
      { ...COLOUR_AND_FINISH, priceFils: 62_000 },
      priceOf,
    );
    expect(e.savingFils).toBe(0);
    expect(e.partPricesFils).toEqual([48_000, 14_000]);
    expect(e.explanation).toMatch(/at the usual price/);
  });

  it('sells a package dearer than its parts at its own price, saving nothing', () => {
    // Branch overrides do this: the package keeps the tenant price while a
    // part is cheaper at this branch. It is what the menu sells it for, so
    // it is what is charged -- not a 500.
    const e = expandPackage(
      { ...COLOUR_AND_FINISH, priceFils: 70_000 },
      priceOf,
    );
    expect(e.savingFils).toBe(0);
    expect(sum(e.partPricesFils)).toBe(70_000);
    expect(e.explanation).toMatch(/2 services for AED 700\.00/);
  });

  it('shares equally when the catalogue prices none of the parts', () => {
    // A share of zero would make a part free; nothing priced means nothing
    // to weight by, so each takes the same.
    const e = expandPackage(
      { id: 'p', name: 'P', serviceIds: ['x', 'y', 'z'], priceFils: 10_000 },
      priceOf,
    );
    expect(e.partPricesFils).toEqual([3_334, 3_333, 3_333]);
    expect(e.savingFils).toBe(0);
  });

  it('charges a part named twice twice', () => {
    const e = expandPackage(
      {
        id: 'two-dries',
        name: 'Two dries',
        serviceIds: ['blow-dry', 'blow-dry'],
        priceFils: 25_000,
      },
      priceOf,
    );
    expect(e.partsTotalFils).toBe(28_000);
    expect(e.partPricesFils).toEqual([12_500, 12_500]);
  });

  it('refuses an empty package', () => {
    expect(() =>
      expandPackage({ ...COLOUR_AND_FINISH, serviceIds: [] }, priceOf),
    ).toThrow(/no services/);
  });

  it('never produces a fractional fil', () => {
    const e = expandPackage(
      { ...COLOUR_AND_FINISH, priceFils: 55_555 },
      priceOf,
    );
    expect(e.partPricesFils.every(Number.isInteger)).toBe(true);
    expect(sum(e.partPricesFils)).toBe(55_555);
  });
});

describe('finding a package', () => {
  it('ignores case, as service ids do', () => {
    const pkg = {
      ...COLOUR_AND_FINISH,
      id: 'aaaaaaaa-0000-0000-0000-00000000000a',
    };
    expect(findPackage([pkg], 'AAAAAAAA-0000-0000-0000-00000000000A')).toBe(
      pkg,
    );
  });
});

describe('resolving a selection', () => {
  const packages = [COLOUR_AND_FINISH];

  it('leaves plain services alone, at their own price', () => {
    const r = resolveSelection(['blow-dry'], packages, priceOf);
    expect(r.serviceIds).toEqual(['blow-dry']);
    expect(r.pricesFils).toEqual([14_000]);
    expect(r.origins).toEqual([null]);
    expect(r.expansions).toEqual([]);
    expect(r.savingFils).toBe(0);
  });

  it('expands a package into its services, priced from the package', () => {
    const r = resolveSelection(['colour-and-finish'], packages, priceOf);
    expect(r.serviceIds).toEqual(['full-colour', 'blow-dry']);
    expect(sum(r.pricesFils)).toBe(56_000);
    expect(r.savingFils).toBe(6_000);
  });

  it('says which package each line came from', () => {
    const r = resolveSelection(
      ['gel-manicure', 'colour-and-finish'],
      packages,
      priceOf,
    );
    const origin = {
      packageId: 'colour-and-finish',
      name: 'Colour and finish',
    };
    expect(r.origins).toEqual([null, origin, origin]);
  });

  it('mixes packages and plain services', () => {
    const r = resolveSelection(
      ['colour-and-finish', 'gel-manicure'],
      packages,
      priceOf,
    );
    expect(r.serviceIds).toEqual(['full-colour', 'blow-dry', 'gel-manicure']);
    expect(sum(r.pricesFils)).toBe(56_000 + 12_000);
  });

  it('adds the savings of two packages', () => {
    const second: ServicePackage = {
      id: 'pamper',
      name: 'Pamper',
      serviceIds: ['luxury-facial', 'gel-manicure'],
      priceFils: 40_000, // parts 44,000
    };
    const r = resolveSelection(
      ['colour-and-finish', 'pamper'],
      [...packages, second],
      priceOf,
    );
    expect(r.savingFils).toBe(10_000);
    expect(r.serviceIds.length).toBe(4);
    expect(sum(r.pricesFils)).toBe(96_000);
  });

  it('is the one place a package stops existing', () => {
    // Nothing downstream should be able to tell. The result is a plain list.
    const r = resolveSelection(['colour-and-finish'], packages, priceOf);
    expect(
      r.serviceIds.every((id) => findPackage(packages, id) === undefined),
    ).toBe(true);
  });

  it('keeps the order the customer chose', () => {
    const r = resolveSelection(
      ['gel-manicure', 'colour-and-finish'],
      packages,
      priceOf,
    );
    expect(r.serviceIds).toEqual(['gel-manicure', 'full-colour', 'blow-dry']);
    expect(r.pricesFils).toEqual([12_000, 43_355, 12_645]);
  });
});

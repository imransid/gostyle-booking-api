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

  it('carries the difference as the bundle discount', () => {
    const e = expandPackage(COLOUR_AND_FINISH, priceOf);
    expect(e.bundleDiscountFils).toBe(6_000);
    expect(e.packagePriceFils).toBe(56_000);
  });

  it('explains the saving in dirhams', () => {
    expect(expandPackage(COLOUR_AND_FINISH, priceOf).explanation).toMatch(
      /AED 60\.00 less than booking them separately/,
    );
  });

  it('allows a package priced exactly at its parts', () => {
    const e = expandPackage(
      { ...COLOUR_AND_FINISH, priceFils: 62_000 },
      priceOf,
    );
    expect(e.bundleDiscountFils).toBe(0);
    expect(e.explanation).toMatch(/at the usual price/);
  });

  it('refuses a package that costs more than its parts', () => {
    // Not a negative discount. A surcharge dressed as a bundle is a pricing
    // mistake, and clamping it at zero would hide it.
    expect(() =>
      expandPackage({ ...COLOUR_AND_FINISH, priceFils: 70_000 }, priceOf),
    ).toThrow(/cannot cost more than its parts/);
  });

  it('refuses an empty package', () => {
    expect(() =>
      expandPackage({ ...COLOUR_AND_FINISH, serviceIds: [] }, priceOf),
    ).toThrow(/no services/);
  });

  it('never produces a fractional fil', () => {
    const e = expandPackage(COLOUR_AND_FINISH, priceOf);
    expect(Number.isInteger(e.bundleDiscountFils)).toBe(true);
    expect(Number.isInteger(e.partsTotalFils)).toBe(true);
  });
});

describe('resolving a selection', () => {
  const packages = [COLOUR_AND_FINISH];

  it('leaves plain services alone', () => {
    const r = resolveSelection(['blow-dry'], packages, priceOf);
    expect(r.serviceIds).toEqual(['blow-dry']);
    expect(r.expansions).toEqual([]);
    expect(r.bundleDiscountFils).toBe(0);
  });

  it('expands a package into its services', () => {
    const r = resolveSelection(['colour-and-finish'], packages, priceOf);
    expect(r.serviceIds).toEqual(['full-colour', 'blow-dry']);
    expect(r.bundleDiscountFils).toBe(6_000);
  });

  it('mixes packages and plain services', () => {
    const r = resolveSelection(
      ['colour-and-finish', 'gel-manicure'],
      packages,
      priceOf,
    );
    expect(r.serviceIds).toEqual(['full-colour', 'blow-dry', 'gel-manicure']);
    expect(r.bundleDiscountFils).toBe(6_000);
  });

  it('adds the discounts of two packages', () => {
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
    expect(r.bundleDiscountFils).toBe(10_000);
    expect(r.serviceIds.length).toBe(4);
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
  });
});

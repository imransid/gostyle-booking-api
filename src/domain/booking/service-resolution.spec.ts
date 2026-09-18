import { describe, expect, it } from 'vitest';
import {
  HOUSE_CURRENCY,
  looksLikePlatformId,
  oneCurrency,
  priceOfService,
  sourceOf,
  sourceOfAll,
  totalOf,
} from './service-resolution';
import type { Service } from '../availability/feasible';

const svc = (over: Partial<Service> = {}): Service => ({
  id: 'haircut-finish',
  name: 'Haircut and finish',
  skill: 'hair',
  requiredLevel: 2,
  durationMin: 45,
  resourceType: 'styling',
  claims: { preMin: 0, postMin: 0 },
  ...over,
});

describe('looksLikePlatformId', () => {
  it('recognises a real uuid', () => {
    expect(looksLikePlatformId('65ababf6-d2ac-459b-90ca-b1adf7a5abbc')).toBe(
      true,
    );
  });

  it('is case-insensitive, because platform is not consistent about it', () => {
    expect(looksLikePlatformId('65ABABF6-D2AC-459B-90CA-B1ADF7A5ABBC')).toBe(
      true,
    );
  });

  it('rejects every slug the fixture uses', () => {
    for (const slug of ['haircut-finish', 'blow-dry', 'full-colour', 'maya']) {
      expect(looksLikePlatformId(slug), slug).toBe(false);
    }
  });

  it('rejects a near-miss rather than routing it to platform', () => {
    expect(looksLikePlatformId('65ababf6-d2ac-459b-90ca')).toBe(false);
    expect(looksLikePlatformId('65ababf6d2ac459b90cab1adf7a5abbc')).toBe(false);
    expect(looksLikePlatformId('')).toBe(false);
  });
});

describe('priceOfService', () => {
  const fixtureMap = (id: string): number =>
    id === 'haircut-finish' ? 16000 : 0;

  it('prefers the price the catalogue carried', () => {
    expect(priceOfService(svc({ priceFils: 21625 }), fixtureMap)).toBe(21625);
  });

  it('falls back to the map for a fixture service', () => {
    expect(priceOfService(svc(), fixtureMap)).toBe(16000);
  });

  it('is what stops a platform service pricing at ZERO', () => {
    // THE BUG. priceOf() returns 0 for an id it does not know, and a
    // platform uuid is exactly such an id. Without the carried price this
    // books at AED 0.00, silently, all the way to the booking row.
    const platform = svc({ id: '65ababf6-d2ac-459b-90ca-b1adf7a5abbc' });
    expect(priceOfService(platform, fixtureMap)).toBe(0);
    expect(priceOfService({ ...platform, priceFils: 12000 }, fixtureMap)).toBe(
      12000,
    );
  });

  it('honours a genuinely free service rather than falling through', () => {
    // 0 carried is a decision; undefined is an absence. They must differ.
    expect(priceOfService(svc({ priceFils: 0 }), fixtureMap)).toBe(0);
  });
});

describe('oneCurrency', () => {
  it('accepts a basket that agrees', () => {
    expect(oneCurrency([{ currency: 'AED' }, { currency: 'AED' }])).toEqual({
      kind: 'ok',
      currency: 'AED',
    });
  });

  it('treats an absent currency as the house currency', () => {
    // The fixture carries no currency field and is all AED.
    expect(oneCurrency([{}, {}])).toEqual({
      kind: 'ok',
      currency: HOUSE_CURRENCY,
    });
    expect(oneCurrency([{ currency: 'AED' }, {}])).toEqual({
      kind: 'ok',
      currency: 'AED',
    });
  });

  it('ignores case, so aed and AED are one currency', () => {
    expect(oneCurrency([{ currency: 'aed' }, { currency: 'AED' }])).toEqual({
      kind: 'ok',
      currency: 'AED',
    });
  });

  it('REFUSES the real production case', () => {
    // Keratin is BDT and NO Kampos is AED, at the same branch. price_fils is
    // one integer with no currency beside it, so summing them is nonsense.
    const v = oneCurrency([{ currency: 'BDT' }, { currency: 'AED' }]);
    expect(v.kind).toBe('mixed');
    if (v.kind !== 'mixed') throw new Error('unreachable');
    expect(v.currencies).toEqual(['AED', 'BDT']);
  });

  it('reports the currencies sorted, so the message is stable', () => {
    const a = oneCurrency([{ currency: 'BDT' }, { currency: 'AED' }]);
    const b = oneCurrency([{ currency: 'AED' }, { currency: 'BDT' }]);
    expect(a).toEqual(b);
  });

  it('catches a mix where one side is the implicit house currency', () => {
    // The nastiest version: a fixture service (no currency) beside a BDT
    // platform service. Nothing in either object says "AED", so a naive
    // check would see one currency and sum them.
    const v = oneCurrency([{}, { currency: 'BDT' }]);
    expect(v.kind).toBe('mixed');
  });

  it('is fine with an empty basket', () => {
    expect(oneCurrency([])).toEqual({ kind: 'ok', currency: HOUSE_CURRENCY });
  });
});

describe('totalOf', () => {
  it('sums a single-currency basket', () => {
    const v = oneCurrency([{ currency: 'AED' }, { currency: 'AED' }]);
    expect(totalOf(v, [16000, 8000]).fils).toBe(24000);
  });

  it('CANNOT be called on a mixed basket', () => {
    // The verdict is the argument, so there is nothing you can pass that
    // skips the check.
    const v = oneCurrency([{ currency: 'BDT' }, { currency: 'AED' }]);
    expect(() => totalOf(v, [16000, 8000])).toThrow(/AED and BDT/);
  });

  it('sums nothing to nothing', () => {
    expect(totalOf({ kind: 'ok', currency: 'AED' }, []).fils).toBe(0);
  });
});

describe('sourceOf', () => {
  it('reports what the resolver recorded', () => {
    expect(sourceOf({ source: 'platform' })).toBe('platform');
    expect(sourceOf({ source: 'fixture' })).toBe('fixture');
  });

  it('treats an unrecorded source as the fixture', () => {
    // The fixture predates provenance and sets nothing.
    expect(sourceOf({})).toBe('fixture');
  });

  it('does NOT infer from the price', () => {
    // It used to be `priceFils !== undefined`, which was true only by
    // accident of the fixture having no prices. A platform service is
    // platform whatever it costs.
    expect(sourceOf({ source: 'platform' })).toBe('platform');
    expect(sourceOf({})).toBe('fixture');
  });
});

describe('sourceOfAll', () => {
  const platform = { source: 'platform' as const };
  const fixture = {};

  it('is the shared source when every service agrees', () => {
    expect(sourceOfAll([platform, platform])).toBe('platform');
    expect(sourceOfAll([fixture, fixture])).toBe('fixture');
  });

  it('is mixed when a single line was priced from both catalogues', () => {
    // A group participant booking one platform service and one slug. The
    // row carries one price covering both, so neither label is true of it.
    expect(sourceOfAll([platform, fixture])).toBe('mixed');
    expect(sourceOfAll([fixture, platform])).toBe('mixed');
  });

  it('calls an empty line fixture, never mixed', () => {
    // mixed must mean "two catalogues", not "no catalogue" -- otherwise a
    // row with nothing on it reads as the interesting case.
    expect(sourceOfAll([])).toBe('fixture');
  });

  it('is unaffected by how many services share one source', () => {
    expect(sourceOfAll([platform, platform, platform])).toBe('platform');
  });
});

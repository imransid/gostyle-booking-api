import { describe, expect, it, vi } from 'vitest';
import { resolveBasket, type PackageSource } from './basket';
import type { BookingContextReader } from '@application/ports/booking-context.port';
import type { ServicePackage } from '@domain/booking/package';
import {
  FixtureBookingContext,
  PACKAGES,
} from '@infrastructure/fixtures/fixture-booking-context';
import { toUuid } from '@infrastructure/persistence/hold.repository';

/**
 * The one place a basket of service and package ids becomes priced
 * services. Run against the FIXTURE catalogue, which is a real
 * BookingContextReader with real prices, so nothing here is a stub of the
 * thing being proven.
 */

const fixture = new FixtureBookingContext();

function contextSpy(): BookingContextReader {
  return {
    loadServices: (b, ids) => fixture.loadServices(b, ids),
    loadDay: (b, d) => fixture.loadDay(b, d),
    loadCatalogue: (b) => fixture.loadCatalogue(b),
    loadMenu: (b) => fixture.loadMenu(b),
  };
}

/** The source, and the spy on it, kept apart so the spy is never unbound. */
function packagesFrom(list: readonly ServicePackage[]): {
  source: PackageSource;
  forBranch: ReturnType<typeof vi.fn>;
} {
  const forBranch = vi.fn(() => Promise.resolve(list));
  return { source: { forBranch }, forBranch };
}

const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0);

describe('a basket of plain services', () => {
  it('never asks for the package list', async () => {
    // THE OUTAGE THIS PREVENTS: with ListPackages on the path of every
    // request, a platform hiccup stopped every booking, a haircut included.
    const packages = packagesFrom(PACKAGES);
    const b = await resolveBasket(
      contextSpy(),
      packages.source,
      'marina-walk',
      ['blow-dry'],
    );
    expect(packages.forBranch).not.toHaveBeenCalled();
    expect(b.serviceIds).toEqual(['blow-dry']);
    expect(b.pricesFils).toEqual([14_000]);
    expect(b.origins).toEqual([null]);
    expect(b.missing).toEqual([]);
  });

  it('still books while the package list is down', async () => {
    const down: PackageSource = {
      forBranch: () => Promise.reject(new Error('ListPackages unavailable')),
    };
    const b = await resolveBasket(contextSpy(), down, 'marina-walk', [
      'blow-dry',
    ]);
    expect(b.totalFils).toBe(14_000);
  });

  it('loads the services once', async () => {
    const loadServices = vi.fn((b: string, ids: readonly string[]) =>
      fixture.loadServices(b, ids),
    );
    await resolveBasket(
      { ...contextSpy(), loadServices },
      packagesFrom([]).source,
      'marina-walk',
      ['blow-dry', 'full-colour'],
    );
    expect(loadServices).toHaveBeenCalledTimes(1);
  });

  it('answers to a stored id as well as the slug (CLAUDE.md 8)', async () => {
    // The series and read paths re-price from booking_item.service_id,
    // which holds the slug folded through toUuid; the fixture answers it
    // with the slug. Keyed on the id as asked, it looked missing.
    const b = await resolveBasket(
      contextSpy(),
      packagesFrom([]).source,
      'marina-walk',
      [toUuid('blow-dry')],
    );
    expect(b.missing).toEqual([]);
    expect(b.services.map((s) => s.id)).toEqual(['blow-dry']);
    expect(b.pricesFils).toEqual([14_000]);
  });
});

describe('a basket holding a package', () => {
  it('expands it, priced from the package', async () => {
    const packages = packagesFrom(PACKAGES);
    const b = await resolveBasket(
      contextSpy(),
      packages.source,
      'marina-walk',
      ['colour-and-finish'],
    );
    expect(packages.forBranch).toHaveBeenCalledTimes(1);
    expect(b.serviceIds).toEqual(['full-colour', 'blow-dry']);
    // Parts of 48,000 + 14,000 sold for 56,000: the lines carry the 56,000.
    expect(sum(b.pricesFils)).toBe(56_000);
    expect(b.totalFils).toBe(56_000);
    expect(b.packages[0]?.savingFils).toBe(6_000);
    expect(b.origins).toEqual([
      { packageId: 'colour-and-finish', name: 'Colour and finish', seq: 0 },
      { packageId: 'colour-and-finish', name: 'Colour and finish', seq: 0 },
    ]);
  });

  it('prices hand-picked extras at their own price beside it', async () => {
    const b = await resolveBasket(
      contextSpy(),
      packagesFrom(PACKAGES).source,
      'marina-walk',
      ['colour-and-finish', 'fringe-trim'],
    );
    expect(b.serviceIds).toEqual(['full-colour', 'blow-dry', 'fringe-trim']);
    expect(b.totalFils).toBe(56_000 + 6_000);
    expect(b.origins[2]).toBeNull();
  });

  it('finds the package whatever the case of its id', async () => {
    const b = await resolveBasket(
      contextSpy(),
      packagesFrom(PACKAGES).source,
      'marina-walk',
      ['Colour-And-Finish'],
    );
    expect(b.missing).toEqual([]);
    expect(b.totalFils).toBe(56_000);
  });

  it('names a part the catalogue cannot find', async () => {
    const broken: ServicePackage = {
      id: 'ghost-pack',
      name: 'Ghost',
      serviceIds: ['blow-dry', 'no-such-service'],
      priceFils: 10_000,
    };
    const b = await resolveBasket(
      contextSpy(),
      packagesFrom([broken]).source,
      'marina-walk',
      ['ghost-pack'],
    );
    expect(b.missing).toEqual(['no-such-service']);
  });
});

describe('a package in another currency', () => {
  /** A catalogue that answers each id with its own currency, as platform does. */
  const priced = (
    rows: Record<string, { currency: string; priceFils: number }>,
  ): BookingContextReader => ({
    ...contextSpy(),
    loadServices: (b, ids) =>
      fixture
        .loadServices(b, ids)
        .then((found) => found.map((s) => ({ ...s, ...rows[s.id] }))),
  });

  it('beside a hand-picked service in another currency, is refused', async () => {
    // The two loads (what was asked for, then the parts) each pass a
    // one-currency check on their own; the basket is what must not mix.
    const groom: ServicePackage = {
      id: 'aed-pack',
      name: 'AED pack',
      serviceIds: ['blow-dry'],
      priceFils: 10_000,
      currency: 'AED',
    };
    const context = priced({
      'blow-dry': { currency: 'AED', priceFils: 14_000 },
      keratin: { currency: 'BDT', priceFils: 500_000 },
    });
    for (const ids of [
      ['aed-pack', 'keratin'],
      ['keratin', 'aed-pack'],
    ]) {
      await expect(
        resolveBasket(
          context,
          packagesFrom([groom]).source,
          'marina-walk',
          ids,
        ),
      ).rejects.toMatchObject({ code: 'BOOKING_CURRENCY_MIXED' });
    }
  });

  it('beside a service in its own currency, is sold', async () => {
    const pack: ServicePackage = {
      id: 'aed-pack',
      name: 'AED pack',
      serviceIds: ['blow-dry'],
      priceFils: 10_000,
      currency: 'AED',
    };
    const context = priced({
      'blow-dry': { currency: 'AED', priceFils: 14_000 },
      'fringe-trim': { currency: 'AED', priceFils: 6_000 },
    });
    const b = await resolveBasket(
      context,
      packagesFrom([pack]).source,
      'marina-walk',
      ['aed-pack', 'fringe-trim'],
    );
    expect(b.totalFils).toBe(16_000);
  });

  it('is refused, as a basket mixing two currencies is', async () => {
    const taka: ServicePackage = {
      id: 'taka-pack',
      name: 'Taka pack',
      serviceIds: ['blow-dry'],
      priceFils: 10_000,
      currency: 'BDT',
    };
    await expect(
      resolveBasket(contextSpy(), packagesFrom([taka]).source, 'marina-walk', [
        'taka-pack',
      ]),
    ).rejects.toMatchObject({ code: 'BOOKING_CURRENCY_MIXED' });
  });
});

describe('an id that is neither', () => {
  it('is missing, and the package list was asked', async () => {
    const packages = packagesFrom(PACKAGES);
    const b = await resolveBasket(
      contextSpy(),
      packages.source,
      'marina-walk',
      ['not-a-thing'],
    );
    expect(b.missing).toEqual(['not-a-thing']);
    expect(packages.forBranch).toHaveBeenCalledTimes(1);
  });
});

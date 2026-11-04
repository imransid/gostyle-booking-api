import { describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { MobilePackagesHandler } from './mobile-packages.handler';
import { bookingError } from '@application/contract/errors';

const svc = (id: string, name: string, durationMin: number) => ({
  id,
  name,
  durationMin,
  skill: 'x',
  requiredLevel: 1,
  resourceType: 'chair',
  claims: { preMin: 0, postMin: 0 },
  priceFils: 35_000,
});

function handlerWith(
  packages: {
    id: string;
    name: string;
    serviceIds: string[];
    priceFils: number;
  }[],
  services = [svc('bala', 'Balayage', 30)],
) {
  const context = {
    loadServices: (_b: string, ids: readonly string[]) =>
      Promise.resolve(services.filter((s) => ids.includes(s.id))),
  };
  const catalogue = { forBranch: () => Promise.resolve(packages) };
  return new MobilePackagesHandler(catalogue as never, context as never);
}

describe('the packages list', () => {
  it('lists a package with its price, parts and saving', async () => {
    const h = handlerWith([
      {
        id: 'pkg-1',
        name: 'Balayage deal',
        serviceIds: ['bala'],
        priceFils: 29_750,
      },
    ]);
    const page = await h.list('salon');
    expect(page.count).toBe(1);
    expect(page.results[0]).toMatchObject({
      id: 'pkg-1',
      amount_without_tax: 297.5,
      parts_total: 350,
      savings: 52.5,
      duration_min: 30,
    });
  });

  it('is empty for a salon with no packages', async () => {
    expect(await handlerWith([]).list('salon')).toStrictEqual({
      count: 0,
      results: [],
    });
  });

  it('lists a package dearer than its parts at its own price, saving nothing', async () => {
    // It is what the salon's menu sells it for, so it is what a booking of
    // it charges. Leaving it out hid a package the app's own tab was showing.
    const h = handlerWith([
      { id: 'dear', name: 'Dear', serviceIds: ['bala'], priceFils: 40_000 },
    ]);
    const page = await h.list('salon');
    expect(page.results[0]).toMatchObject({
      id: 'dear',
      amount_without_tax: 400,
      parts_total: 350,
      savings: 0,
    });
  });

  it('shares the package price over the parts, as a booking stores them', async () => {
    const h = handlerWith(
      [
        {
          id: 'pair',
          name: 'Pair',
          serviceIds: ['cut', 'dry'],
          priceFils: 30_000,
        },
      ],
      [
        { ...svc('cut', 'Cut', 30), priceFils: 20_000 },
        { ...svc('dry', 'Dry', 20), priceFils: 20_000 },
      ],
    );
    const page = await h.list('salon');
    expect(page.results[0]).toMatchObject({
      amount_without_tax: 300,
      parts_total: 400,
      savings: 100,
      duration_min: 50,
      services: [
        { id: 'cut', name: 'Cut', amount: 150 },
        { id: 'dry', name: 'Dry', amount: 150 },
      ],
    });
  });

  it('gives the desk the same figures in its own units', async () => {
    const h = handlerWith([
      {
        id: 'pkg-1',
        name: 'Balayage deal',
        serviceIds: ['bala'],
        priceFils: 29_750,
      },
    ]);
    const [offer] = await h.offers('salon');
    expect(offer).toMatchObject({
      id: 'pkg-1',
      priceFils: 29_750,
      partsTotalFils: 35_000,
      savingFils: 5_250,
      durationMin: 30,
      parts: [{ id: 'bala', name: 'Balayage', priceFils: 29_750 }],
    });
  });

  it('asks the catalogue for every part in one call', async () => {
    const loadServices = vi.fn((_b: string, ids: readonly string[]) =>
      Promise.resolve(
        [svc('cut', 'Cut', 30), svc('dry', 'Dry', 20)].filter((s) =>
          ids.includes(s.id),
        ),
      ),
    );
    const catalogue = {
      forBranch: () =>
        Promise.resolve([
          { id: 'a', name: 'A', serviceIds: ['cut'], priceFils: 100 },
          { id: 'b', name: 'B', serviceIds: ['cut', 'dry'], priceFils: 100 },
        ]),
    };
    const h = new MobilePackagesHandler(
      catalogue as never,
      { loadServices } as never,
    );
    expect((await h.list('salon')).count).toBe(2);
    expect(loadServices).toHaveBeenCalledTimes(1);
  });

  it('skips a package whose part the catalogue cannot find', async () => {
    const warn = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const h = handlerWith([
      { id: 'ghost', name: 'Ghost', serviceIds: ['gone'], priceFils: 100 },
    ]);
    expect((await h.list('salon')).count).toBe(0);
    warn.mockRestore();
  });
});

describe('one bad package among good ones', () => {
  const svcIn = (id: string, currency: string, priceFils = 10_000) => ({
    ...svc(id, id, 30),
    currency,
    priceFils,
  });
  /**
   * The catalogue's own refusals, as the platform catalogue makes them: one
   * currency per lookup, and no part priced at nothing.
   */
  const strict = (rows: ReturnType<typeof svcIn>[]) => ({
    loadServices: (_b: string, ids: readonly string[]) => {
      const found = rows.filter((r) => ids.includes(r.id));
      if (found.some((r) => r.priceFils <= 0)) {
        return Promise.reject(
          bookingError('BOOKING_STATE_INVALID', 'no usable price'),
        );
      }
      if (new Set(found.map((r) => r.currency)).size > 1) {
        return Promise.reject(
          bookingError('BOOKING_CURRENCY_MIXED', 'mixes AED and BDT'),
        );
      }
      return Promise.resolve(found);
    },
  });
  const listing = (
    packages: {
      id: string;
      name: string;
      serviceIds: string[];
      priceFils: number;
      currency?: string;
    }[],
    rows: ReturnType<typeof svcIn>[],
  ) =>
    new MobilePackagesHandler(
      { forBranch: () => Promise.resolve(packages) } as never,
      strict(rows) as never,
    );
  const quiet = () =>
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

  it('two packages in their own currencies are both listed', async () => {
    // Together their parts span two currencies, which one lookup refuses.
    const warn = quiet();
    const h = listing(
      [
        {
          id: 'aed',
          name: 'A',
          serviceIds: ['cut'],
          priceFils: 9_000,
          currency: 'AED',
        },
        {
          id: 'bdt',
          name: 'B',
          serviceIds: ['keratin'],
          priceFils: 9_000,
          currency: 'BDT',
        },
      ],
      [svcIn('cut', 'AED'), svcIn('keratin', 'BDT')],
    );
    expect((await h.offers('salon')).map((o) => o.id)).toEqual(['aed', 'bdt']);
    warn.mockRestore();
  });

  it('a package with a part priced at nothing is left out, the rest listed', async () => {
    const warn = quiet();
    const h = listing(
      [
        { id: 'good', name: 'Good', serviceIds: ['cut'], priceFils: 9_000 },
        { id: 'free', name: 'Free', serviceIds: ['massage'], priceFils: 9_000 },
      ],
      [svcIn('cut', 'AED'), svcIn('massage', 'AED', 0)],
    );
    expect((await h.offers('salon')).map((o) => o.id)).toEqual(['good']);
    warn.mockRestore();
  });

  it('a package priced in another currency from its parts is left out', async () => {
    const warn = quiet();
    const h = listing(
      [
        {
          id: 'taka',
          name: 'Taka',
          serviceIds: ['cut'],
          priceFils: 9_000,
          currency: 'BDT',
        },
        {
          id: 'aed',
          name: 'A',
          serviceIds: ['cut'],
          priceFils: 9_000,
          currency: 'AED',
        },
      ],
      [svcIn('cut', 'AED')],
    );
    expect((await h.offers('salon')).map((o) => o.id)).toEqual(['aed']);
    warn.mockRestore();
  });

  it('an outage is the answer for the whole list, not an empty one', async () => {
    const h = new MobilePackagesHandler(
      {
        forBranch: () =>
          Promise.resolve([
            { id: 'p', name: 'P', serviceIds: ['cut'], priceFils: 9_000 },
          ]),
      } as never,
      {
        loadServices: () =>
          Promise.reject(
            bookingError('DEPENDENCY_UNAVAILABLE', 'platform down'),
          ),
      } as never,
    );
    await expect(h.offers('salon')).rejects.toMatchObject({
      code: 'DEPENDENCY_UNAVAILABLE',
    });
  });
});

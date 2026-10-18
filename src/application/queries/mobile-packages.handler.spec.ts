import { describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { MobilePackagesHandler } from './mobile-packages.handler';

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

  it('skips a package dearer than its parts, and keeps the rest', async () => {
    const warn = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const h = handlerWith([
      { id: 'bad', name: 'Bad', serviceIds: ['bala'], priceFils: 99_000 },
      { id: 'ok', name: 'Ok', serviceIds: ['bala'], priceFils: 29_750 },
    ]);
    const page = await h.list('salon');
    expect(page.results.map((r) => r.id)).toStrictEqual(['ok']);
    warn.mockRestore();
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

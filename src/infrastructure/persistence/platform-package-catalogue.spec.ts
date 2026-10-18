import { afterEach, describe, expect, it } from 'vitest';
import { PlatformPackageCatalogue } from './platform-package-catalogue';
import { PACKAGES } from '../fixtures/fixture-booking-context';

const SVC_A = '00000000-0000-0000-0000-00000000000a';
const SVC_B = '00000000-0000-0000-0000-00000000000b';

function make(rows: unknown[], tenant: string | null = 'tenant-1') {
  const calls: unknown[][] = [];
  const directory = {
    listPackages: (...args: unknown[]) => {
      calls.push(args);
      return Promise.resolve(rows);
    },
  };
  const tenants = { current: () => tenant };
  const catalogue = new PlatformPackageCatalogue(
    directory as never,
    tenants as never,
  );
  return { catalogue, calls };
}

const row = (over: Record<string, unknown> = {}) => ({
  id: 'pkg-1',
  name: 'Bridal',
  priceMinor: 70000,
  currency: 'AED',
  items: [{ serviceId: SVC_A, quantity: 1 }],
  ...over,
});

describe('PlatformPackageCatalogue.forBranch', () => {
  afterEach(() => {
    delete process.env.PACKAGES_FROM_PLATFORM;
  });

  it('switch off: returns the fixtures and never asks platform', async () => {
    const { catalogue, calls } = make([row()]);
    expect(await catalogue.forBranch('b1')).toEqual(PACKAGES);
    expect(calls).toHaveLength(0);
  });

  it('switch on: maps a row and keeps the fixtures after it', async () => {
    process.env.PACKAGES_FROM_PLATFORM = 'true';
    const { catalogue, calls } = make([row()]);
    const out = await catalogue.forBranch('b1');
    expect(calls).toEqual([['tenant-1', 'b1']]);
    expect(out[0]).toEqual({
      id: 'pkg-1',
      name: 'Bridal',
      serviceIds: [SVC_A],
      priceFils: 70000,
    });
    expect(out.slice(1)).toEqual(PACKAGES);
  });

  it('repeats a service id once per quantity', async () => {
    process.env.PACKAGES_FROM_PLATFORM = 'true';
    const { catalogue } = make([
      row({
        items: [
          { serviceId: SVC_A, quantity: 2 },
          { serviceId: SVC_B, quantity: 1 },
        ],
      }),
    ]);
    const out = await catalogue.forBranch('b1');
    expect(out[0]!.serviceIds).toEqual([SVC_A, SVC_A, SVC_B]);
  });

  it('skips unusable rows without failing the rest', async () => {
    process.env.PACKAGES_FROM_PLATFORM = 'true';
    const { catalogue } = make([
      row({ id: 'no-items', items: [] }),
      row({ id: 'no-price', priceMinor: 0 }),
      row({ id: 'good' }),
    ]);
    const out = await catalogue.forBranch('b1');
    expect(out.map((p) => p.id)).toEqual([
      'good',
      ...PACKAGES.map((p) => p.id),
    ]);
  });

  it('no tenant: falls back to the fixtures', async () => {
    process.env.PACKAGES_FROM_PLATFORM = 'true';
    const { catalogue, calls } = make([row()], null);
    expect(await catalogue.forBranch('b1')).toEqual(PACKAGES);
    expect(calls).toHaveLength(0);
  });
});

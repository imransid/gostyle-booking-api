import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PACKAGE_LIST_CACHE_MAX,
  PACKAGE_LIST_TTL_MS,
  PlatformPackageCatalogue,
} from './platform-package-catalogue';
import { PACKAGES } from '../fixtures/fixture-booking-context';

const SVC_A = '00000000-0000-0000-0000-00000000000a';
const SVC_B = '00000000-0000-0000-0000-00000000000b';
const TENANT = '11111111-1111-1111-1111-111111111111';
const BRANCH = '22222222-2222-2222-2222-222222222222';

function make(rows: unknown[], tenant: string | null = TENANT) {
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
  items: [{ serviceId: SVC_A, quantity: 1, variantId: '' }],
  ...over,
});

describe('PlatformPackageCatalogue.forBranch', () => {
  afterEach(() => {
    delete process.env.PACKAGES_FROM_PLATFORM;
    vi.useRealTimers();
  });

  describe('the demo salon', () => {
    it('a slug branch sells the fixture packages, switch on or off', async () => {
      const { catalogue, calls } = make([row()]);
      expect(await catalogue.forBranch('marina-walk')).toEqual(PACKAGES);
      process.env.PACKAGES_FROM_PLATFORM = 'true';
      expect(await catalogue.forBranch('marina-walk')).toEqual(PACKAGES);
      expect(calls).toHaveLength(0);
    });
  });

  describe('a real branch', () => {
    it('switch off: sells nothing, and never the demo packages', async () => {
      // They were this list, so the app was offered "Bridal morning" at
      // salons that never sold it.
      const { catalogue, calls } = make([row()]);
      expect(await catalogue.forBranch(BRANCH)).toEqual([]);
      expect(calls).toHaveLength(0);
    });

    it('switch on: what platform sells, and nothing appended', async () => {
      process.env.PACKAGES_FROM_PLATFORM = 'true';
      const { catalogue, calls } = make([row()]);
      const out = await catalogue.forBranch(BRANCH);
      expect(calls).toEqual([[TENANT, BRANCH]]);
      expect(out).toEqual([
        {
          id: 'pkg-1',
          name: 'Bridal',
          serviceIds: [SVC_A],
          priceFils: 70000,
          currency: 'AED',
        },
      ]);
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
      const out = await catalogue.forBranch(BRANCH);
      expect(out[0]!.serviceIds).toEqual([SVC_A, SVC_A, SVC_B]);
    });

    it('skips unusable rows without failing the rest', async () => {
      process.env.PACKAGES_FROM_PLATFORM = 'true';
      const { catalogue } = make([
        row({ id: 'no-items', items: [] }),
        row({ id: 'no-price', priceMinor: 0 }),
        row({ id: 'good' }),
      ]);
      const out = await catalogue.forBranch(BRANCH);
      expect(out.map((p) => p.id)).toEqual(['good']);
    });

    it('leaves out a package pinned to a service variant', async () => {
      // Booking knows services, not their variants: "Long hair" would be
      // sold with the base service's minutes.
      process.env.PACKAGES_FROM_PLATFORM = 'true';
      const { catalogue } = make([
        row({
          id: 'long-hair',
          items: [{ serviceId: SVC_A, quantity: 1, variantId: SVC_B }],
        }),
        row({ id: 'plain' }),
      ]);
      const out = await catalogue.forBranch(BRANCH);
      expect(out.map((p) => p.id)).toEqual(['plain']);
    });

    it('no tenant: sells nothing rather than guessing one', async () => {
      process.env.PACKAGES_FROM_PLATFORM = 'true';
      const { catalogue, calls } = make([row()], null);
      expect(await catalogue.forBranch(BRANCH)).toEqual([]);
      expect(calls).toHaveLength(0);
    });

    it('a tenant that is not a uuid is not asked about', async () => {
      // ListPackages refuses it with INVALID_ARGUMENT, which reached the
      // client as a 503 for every package booking.
      process.env.PACKAGES_FROM_PLATFORM = 'true';
      const { catalogue, calls } = make([row()], 'tenant-1');
      expect(await catalogue.forBranch(BRANCH)).toEqual([]);
      expect(calls).toHaveLength(0);
    });
  });

  describe('the cache', () => {
    it('asks once per branch within the minute', async () => {
      process.env.PACKAGES_FROM_PLATFORM = 'true';
      const { catalogue, calls } = make([row()]);
      await catalogue.forBranch(BRANCH);
      await catalogue.forBranch(BRANCH);
      expect(calls).toHaveLength(1);
    });

    it('asks again once the minute is up', async () => {
      vi.useFakeTimers();
      process.env.PACKAGES_FROM_PLATFORM = 'true';
      const { catalogue, calls } = make([row()]);
      await catalogue.forBranch(BRANCH);
      vi.advanceTimersByTime(PACKAGE_LIST_TTL_MS + 1);
      await catalogue.forBranch(BRANCH);
      expect(calls).toHaveLength(2);
    });

    it('is bounded: made-up branch ids cannot grow it for ever', async () => {
      process.env.PACKAGES_FROM_PLATFORM = 'true';
      const { catalogue } = make([]);
      for (let i = 0; i < PACKAGE_LIST_CACHE_MAX + 50; i++) {
        const branch = `22222222-2222-2222-2222-${String(i).padStart(12, '0')}`;
        await catalogue.forBranch(branch);
      }
      expect(catalogue.cachedLists()).toBeLessThanOrEqual(
        PACKAGE_LIST_CACHE_MAX,
      );
    });

    it('drops lists that have gone stale', async () => {
      vi.useFakeTimers();
      process.env.PACKAGES_FROM_PLATFORM = 'true';
      const { catalogue } = make([]);
      await catalogue.forBranch(BRANCH);
      vi.advanceTimersByTime(PACKAGE_LIST_TTL_MS + 1);
      await catalogue.forBranch('22222222-2222-2222-2222-222222222223');
      expect(catalogue.cachedLists()).toBe(1);
    });

    it('never keeps a failure', async () => {
      process.env.PACKAGES_FROM_PLATFORM = 'true';
      let fail = true;
      const directory = {
        listPackages: () =>
          fail
            ? Promise.reject(new Error('platform down'))
            : Promise.resolve([row()]),
      };
      const catalogue = new PlatformPackageCatalogue(
        directory as never,
        { current: () => TENANT } as never,
      );
      await expect(catalogue.forBranch(BRANCH)).rejects.toThrow(/down/);
      fail = false;
      expect(await catalogue.forBranch(BRANCH)).toHaveLength(1);
    });
  });
});

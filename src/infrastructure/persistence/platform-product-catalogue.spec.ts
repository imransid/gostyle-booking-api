import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';

import { BookingError } from '@application/contract/errors';
import type {
  CatalogueProduct,
  ProductsDirectoryReader,
} from '@application/ports/products-directory.port';
import { TenantContext } from '../tenancy/tenant-context';
import {
  PRODUCTS_FROM_PLATFORM,
  PlatformProductCatalogue,
} from './platform-product-catalogue';

/**
 * CATALOGUE SPEC — proves what is SENT and what is REFUSED.
 *
 * The port is a fake that records its calls, because the failures worth
 * catching here are all requests that should never have gone out: an empty
 * list (platform reads it as "every variant"), a slug (platform refuses the
 * whole call), a missing branch (every item comes back untracked).
 *
 * TenantContext is the real one, driven with `.run(...)`, so the tenant is
 * read the way it is in a request.
 */

// Letters in every group, so lowercasing is visible.
const TENANT = 'aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaaa';
const BRANCH = 'bbbbbbbb-2222-4bbb-8bbb-bbbbbbbbbbbb';
const OIL = 'cccccccc-3333-4ccc-8ccc-cccccccccccc';
const SPRAY = 'dddddddd-4444-4ddd-8ddd-dddddddddddd';
const STRANGER = 'eeeeeeee-5555-4eee-8eee-eeeeeeeeeeee';

const product = (
  variantId: string,
  over: Partial<CatalogueProduct> = {},
): CatalogueProduct => ({
  variantId,
  productId: `product-of-${variantId}`,
  productName: 'Argan Oil',
  variantName: '100 ml',
  sku: 'ARG-100',
  priceMinor: 8_500,
  currency: 'AED',
  imageUrl: null,
  categoryName: null,
  tracked: true,
  available: 5,
  ...over,
});

function catalogueAnswering(rows: CatalogueProduct[] = []) {
  const listProducts = vi.fn<ProductsDirectoryReader['listProducts']>(() =>
    Promise.resolve(rows),
  );
  const tenants = new TenantContext();
  const catalogue = new PlatformProductCatalogue({ listProducts }, tenants);
  const resolve = (
    branchId: string,
    ids: readonly string[],
    tenant: string | null = TENANT,
  ) => tenants.run(tenant, () => catalogue.resolve(branchId, ids));
  return { catalogue, listProducts, resolve };
}

const saved = process.env.PRODUCTS_FROM_PLATFORM;

beforeEach(() => {
  process.env.PRODUCTS_FROM_PLATFORM = 'true';
  vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  if (saved === undefined) delete process.env.PRODUCTS_FROM_PLATFORM;
  else process.env.PRODUCTS_FROM_PLATFORM = saved;
});

describe('PRODUCTS_FROM_PLATFORM', () => {
  it('is false when unset', () => {
    delete process.env.PRODUCTS_FROM_PLATFORM;
    expect(PRODUCTS_FROM_PLATFORM()).toBe(false);
  });

  it.each(['', 'false', '1', 'yes'])('is false for %j', (value) => {
    process.env.PRODUCTS_FROM_PLATFORM = value;
    expect(PRODUCTS_FROM_PLATFORM()).toBe(false);
  });

  it.each(['true', ' TRUE '])('is true for %j', (value) => {
    process.env.PRODUCTS_FROM_PLATFORM = value;
    expect(PRODUCTS_FROM_PLATFORM()).toBe(true);
  });
});

describe('PlatformProductCatalogue.resolve: what is never sent', () => {
  it('throws with the flag off, and never calls the port', async () => {
    delete process.env.PRODUCTS_FROM_PLATFORM;
    const { listProducts, resolve } = catalogueAnswering([product(OIL)]);

    await expect(resolve(BRANCH, [OIL])).rejects.toThrow(
      /PRODUCTS_FROM_PLATFORM off/,
    );
    expect(listProducts).not.toHaveBeenCalled();
  });

  it.each([
    ['only slugs', ['argan-oil', 'full-colour']],
    ['an empty list', []],
  ])('%s gives an empty map, and never calls the port', async (_name, ids) => {
    // NEVER AN EMPTY LIST ON THE WIRE: platform reads [] as "every variant".
    const { listProducts, resolve } = catalogueAnswering([product(OIL)]);

    const found = await resolve(BRANCH, ids);

    expect(found.size).toBe(0);
    expect(listProducts).not.toHaveBeenCalled();
  });

  it('drops slugs, collapses duplicates and lowercases ids before sending', async () => {
    const { listProducts, resolve } = catalogueAnswering([]);

    await resolve(BRANCH, [
      'argan-oil',
      OIL.toUpperCase(),
      OIL,
      SPRAY,
      'maya',
      SPRAY,
    ]);

    expect(listProducts).toHaveBeenCalledOnce();
    expect(listProducts).toHaveBeenCalledWith(TENANT, BRANCH, [OIL, SPRAY]);
  });

  it.each([
    ['no tenant', null],
    ['a tenant that is not a uuid', 'tenant-1'],
  ])('%s is a 400, and no call', async (_name, tenant) => {
    const { listProducts, resolve } = catalogueAnswering([product(OIL)]);

    const err = await resolve(BRANCH, [OIL], tenant).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BookingError);
    expect(err).toMatchObject({
      code: 'BOOKING_VALIDATION_FAILED',
      status: 400,
    });
    expect(listProducts).not.toHaveBeenCalled();
  });

  it("branch 'marina-walk' is a 400, and no call", async () => {
    // Sent as '', platform would report every item as untracked and the
    // stock check would pass everything.
    const { listProducts, resolve } = catalogueAnswering([product(OIL)]);

    const err = await resolve('marina-walk', [OIL]).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BookingError);
    expect(err).toMatchObject({
      code: 'BOOKING_VALIDATION_FAILED',
      status: 400,
      details: { salonId: 'marina-walk' },
    });
    expect(listProducts).not.toHaveBeenCalled();
  });
});

describe('PlatformProductCatalogue.resolve: what comes back', () => {
  it.each([
    ['the same id twice', [product(OIL), product(OIL, { priceMinor: 9_000 })]],
    [
      'the same id in two cases',
      [product(OIL), product(OIL.toUpperCase(), { priceMinor: 9_000 })],
    ],
  ])('%s is BOOKING_STATE_INVALID', async (_name, rows) => {
    // Two prices for one variant. Picking either is charging a guess.
    const { resolve } = catalogueAnswering(rows);

    await expect(resolve(BRANCH, [OIL])).rejects.toMatchObject({
      code: 'BOOKING_STATE_INVALID',
      status: 409,
      details: { products: [OIL] },
    });
  });

  it('ignores rows platform sent that nobody asked for', async () => {
    const { resolve } = catalogueAnswering([product(OIL), product(STRANGER)]);

    const found = await resolve(BRANCH, [OIL]);

    expect([...found.keys()]).toStrictEqual([OIL]);
    expect(found.has(STRANGER)).toBe(false);
  });

  it('finds the row for an id the app sent in uppercase', async () => {
    const row = product(OIL);
    const { resolve } = catalogueAnswering([row]);

    const found = await resolve(BRANCH, [OIL.toUpperCase()]);

    expect(found.get(OIL)).toBe(row);
  });

  it('returns a row priced 0 rather than filtering it (Part B decides)', async () => {
    // READS, DOES NOT JUDGE. A free item and a mispriced one look the same
    // from here; the domain is where that is told apart and tested.
    const free = product(OIL, { priceMinor: 0 });
    const { resolve } = catalogueAnswering([free]);

    const found = await resolve(BRANCH, [OIL]);

    expect(found.get(OIL)).toBe(free);
  });

  it('leaves an unknown id missing from the map', async () => {
    const { resolve } = catalogueAnswering([product(OIL)]);

    const found = await resolve(BRANCH, [OIL, SPRAY]);

    expect(found.has(OIL)).toBe(true);
    expect(found.has(SPRAY)).toBe(false);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import type { ClientGrpc } from '@nestjs/microservices';
import { status } from '@grpc/grpc-js';
import { of, throwError, type Observable } from 'rxjs';

import { BookingError } from '@application/contract/errors';
import { GrpcProductsDirectory } from './grpc-products-directory';

/**
 * ADAPTER SPEC — proves the wire-to-port mapping and the failure taxonomy.
 *
 * The fake ClientGrpc hands back one `listProducts` spy, so every test can
 * see exactly what went on the wire and choose exactly what came back.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const BRANCH = '22222222-2222-4222-8222-222222222222';
const VARIANT = '33333333-3333-4333-8333-333333333333';

const grpc = (code: number) => Object.assign(new Error('wire'), { code });

type Answer = Observable<{ variants?: Record<string, unknown>[] }>;

function directoryAnswering(answer: () => Answer) {
  const listProducts = vi.fn<(request: unknown) => Answer>(answer);
  const client = {
    getService: vi.fn(() => ({ listProducts })),
  } as unknown as ClientGrpc;
  const directory = new GrpcProductsDirectory(client);
  directory.onModuleInit();
  return { directory, listProducts };
}

const answering = (variants: Record<string, unknown>[]) =>
  directoryAnswering(() => of({ variants }));

const failing = (code: number) =>
  directoryAnswering(() => throwError(() => grpc(code)));

beforeEach(() => {
  // The adapter logs every failure at ERROR and callWithRetry WARNs on the
  // retry. Both are right in production and noise here.
  vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('GrpcProductsDirectory: wire to port', () => {
  it('maps a full wire row to every camelCase field', async () => {
    const { directory } = answering([
      {
        variant_id: VARIANT,
        product_id: 'p-1',
        product_name: 'Argan Oil',
        variant_name: '100 ml',
        sku: 'ARG-100',
        price_minor: 8_500,
        currency: 'AED',
        image_url: 'https://cdn.example/argan.png',
        category_name: 'Hair care',
        tracked: true,
        available: 7,
      },
    ]);

    const rows = await directory.listProducts(TENANT, BRANCH, [VARIANT]);

    expect(rows).toStrictEqual([
      {
        variantId: VARIANT,
        productId: 'p-1',
        productName: 'Argan Oil',
        variantName: '100 ml',
        sku: 'ARG-100',
        priceMinor: 8_500,
        currency: 'AED',
        imageUrl: 'https://cdn.example/argan.png',
        categoryName: 'Hair care',
        tracked: true,
        available: 7,
      },
    ]);
  });

  it("turns an '' image and category into null", async () => {
    const { directory } = answering([
      { variant_id: VARIANT, image_url: '', category_name: '' },
    ]);

    const [row] = await directory.listProducts(TENANT, BRANCH, [VARIANT]);

    expect(row!.imageUrl).toBeNull();
    expect(row!.categoryName).toBeNull();
  });

  it("fills omitted fields with proto3 zeros, and currency '' is NOT 'AED'", async () => {
    // proto3 drops default values from the wire. A row with nothing on it
    // must still be a well-formed CatalogueProduct -- and must not have a
    // currency invented for it.
    const { directory } = answering([{}]);

    const [row] = await directory.listProducts(TENANT, BRANCH, [VARIANT]);

    expect(row).toStrictEqual({
      variantId: '',
      productId: '',
      productName: '',
      variantName: '',
      sku: '',
      priceMinor: 0,
      currency: '',
      imageUrl: null,
      categoryName: null,
      tracked: false,
      available: 0,
    });
  });

  it('keeps a negative available as it is', async () => {
    // An approved oversell. Clamping it to 0 would hide how far over it is.
    const { directory } = answering([
      { variant_id: VARIANT, tracked: true, available: -3 },
    ]);

    const [row] = await directory.listProducts(TENANT, BRANCH, [VARIANT]);

    expect(row!.available).toBe(-3);
  });

  it('answers [] when platform sends no variants field at all', async () => {
    const { directory } = directoryAnswering(() => of({}));

    await expect(
      directory.listProducts(TENANT, BRANCH, [VARIANT]),
    ).resolves.toStrictEqual([]);
  });
});

describe('GrpcProductsDirectory: the request', () => {
  it('sends exactly the tenant_id, branch_id and variant_ids passed in', async () => {
    const { directory, listProducts } = answering([]);
    const other = '44444444-4444-4444-8444-444444444444';

    await directory.listProducts(TENANT, BRANCH, [VARIANT, other]);

    expect(listProducts).toHaveBeenCalledOnce();
    expect(listProducts.mock.calls[0]![0]).toStrictEqual({
      tenant_id: TENANT,
      branch_id: BRANCH,
      variant_ids: [VARIANT, other],
    });
  });
});

describe('GrpcProductsDirectory: failures', () => {
  it('UNAVAILABLE twice is a 503 DEPENDENCY_UNAVAILABLE naming ProductsDirectory', async () => {
    const { directory, listProducts } = failing(status.UNAVAILABLE);

    const err = await directory
      .listProducts(TENANT, BRANCH, [VARIANT])
      .catch((e: unknown) => e);

    // Retried once by callWithRetry, then reported.
    expect(listProducts).toHaveBeenCalledTimes(2);
    expect(err).toBeInstanceOf(BookingError);
    expect(err).toMatchObject({
      code: 'DEPENDENCY_UNAVAILABLE',
      status: 503,
      details: {
        dependency: 'platform-api ProductsDirectory',
        grpcStatus: 'UNAVAILABLE',
      },
    });
  });

  it('UNKNOWN is also a 503, and is not retried', async () => {
    const { directory, listProducts } = failing(status.UNKNOWN);

    await expect(
      directory.listProducts(TENANT, BRANCH, [VARIANT]),
    ).rejects.toMatchObject({
      code: 'DEPENDENCY_UNAVAILABLE',
      status: 503,
      details: {
        dependency: 'platform-api ProductsDirectory',
        grpcStatus: 'UNKNOWN',
      },
    });
    expect(listProducts).toHaveBeenCalledOnce();
  });

  it('NOT_FOUND is a 404 BOOKING_NOT_FOUND', async () => {
    const { directory } = failing(status.NOT_FOUND);

    await expect(
      directory.listProducts(TENANT, BRANCH, [VARIANT]),
    ).rejects.toMatchObject({
      code: 'BOOKING_NOT_FOUND',
      status: 404,
      details: {
        dependency: 'platform-api ProductsDirectory',
        branchId: BRANCH,
      },
    });
  });

  it.each([
    ['INVALID_ARGUMENT', status.INVALID_ARGUMENT],
    ['UNIMPLEMENTED', status.UNIMPLEMENTED],
  ])('%s is re-thrown unchanged', async (_name, code) => {
    // Ours to fix -- a malformed request or a deploy skew -- so it must
    // surface as itself, not dressed up as an outage.
    const original = grpc(code);
    const { directory, listProducts } = directoryAnswering(() =>
      throwError(() => original),
    );

    const err = await directory
      .listProducts(TENANT, BRANCH, [VARIANT])
      .catch((e: unknown) => e);

    expect(err).toBe(original);
    expect(err).not.toBeInstanceOf(BookingError);
    expect(listProducts).toHaveBeenCalledOnce();
  });
});

import { describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import {
  MobileBookingHandler,
  type MobileBookingCommand,
} from './mobile-booking.handler';
import { isMobileContractError } from './mobile-booking.error';
import { TenantContext } from '@infrastructure/tenancy/tenant-context';
import type { CatalogueProduct } from '@application/ports/products-directory.port';
import type { Service } from '@domain/availability/feasible';

/**
 * ORCHESTRATION SPEC — the ORDER of the mobile create, with products in it.
 *
 * Every rule here is proven elsewhere: the product checks in
 * mobile-products.spec, the flag in mobile-contract.spec, the write in
 * booking.repository.spec. What this file pins is the choreography, and
 * three decisions in particular that nothing else can catch:
 *
 *   1. PRODUCTS ARE PRICED BEFORE THE HOLD. A refused line or a platform
 *      outage must cost nobody a chair, and the error must arrive before
 *      any slot is taken.
 *   2. THE APP'S TOTALS MUST INCLUDE ITS PRODUCTS. §3 verifies the combined
 *      figure, so an app that sends the services' total with a basket
 *      attached is refused with the right number to show the customer.
 *   3. THE CATALOGUE IS NOT ASKED WHEN THERE IS NOTHING TO ASK ABOUT.
 *
 * Every collaborator is a hand-written double that records what it was
 * given, so a test asserts on the call the handler actually made.
 */

const SALON = 'marina-walk';
const CUSTOMER = 'cus_ayesha';
const OIL = 'cccccccc-3333-4ccc-8ccc-cccccccccccc';
const SPRAY = 'dddddddd-4444-4ddd-8ddd-dddddddddddd';

/** Asia/Dhaka, +06:00: the same offset the handler reads times with. */
const START = '2026-09-20T14:00:00+06:00';
const END = '2026-09-20T14:45:00+06:00';

const HAIRCUT: Service = {
  id: 'haircut-finish',
  name: 'Haircut & finish',
  skill: 'cut',
  requiredLevel: 1,
  durationMin: 45,
  resourceType: 'chair',
  claims: { preMin: 0, postMin: 0 },
};

/** The services alone: AED 160 net, AED 8 VAT, AED 168 total. */
const QUOTE = {
  durationMin: 45,
  subtotalMinor: 16_000,
  vatMinor: 800,
  tierDiscountMinor: 0,
  bundleDiscountMinor: 0,
  totalMinor: 16_800,
  depositMinor: 5_000,
};

const catalogueRow = (
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
  available: 10,
  ...over,
});

interface HandlerOptions {
  readonly productsEnabled?: boolean;
  readonly offers?: readonly CatalogueProduct[];
  /** Platform could not be reached. */
  readonly resolveThrows?: Error;
  readonly services?: readonly Service[];
}

function handlerWith(options: HandlerOptions = {}) {
  const calls: { readonly method: string; readonly args: unknown }[] = [];
  const record = (method: string, args: unknown) =>
    calls.push({ method, args });

  const holds = {
    execute: (args: unknown) => {
      record('holds.execute', args);
      return Promise.resolve({ holdId: 'hold-1' });
    },
    release: (id: string) => {
      record('holds.release', id);
      return Promise.resolve(undefined);
    },
  };

  const confirms = {
    execute: (args: unknown) => {
      record('confirms.execute', args);
      return Promise.resolve({ bookingId: 'booking-1' });
    },
  };

  const links = {
    execute: (bookingId: string, actor: unknown) => {
      record('links.execute', { bookingId, actor });
      return Promise.resolve({ expiresAt: '2026-09-20T12:00:00.000Z' });
    },
  };

  const quotes = {
    execute: (q: unknown) => {
      record('quotes.execute', q);
      return Promise.resolve(QUOTE);
    },
  };

  const bookings = {
    detail: (id: string) => {
      record('bookings.detail', id);
      return Promise.resolve({
        id,
        code: 'GS-1001',
        tenantId: null,
        branchId: SALON,
        customerId: CUSTOMER,
        status: 'pending_payment',
        paymentStatus: 'unpaid',
        bookingType: 'single',
        tradingDay: new Date('2026-09-20T00:00:00.000Z'),
        startMinute: 840,
        durationMin: 45,
        createdAt: new Date('2026-09-19T10:00:00.000Z'),
        linkExpiresAt: null,
        netFils: null,
        taxFils: null,
        discountFils: null,
        depositFils: 5_000,
        items: [
          {
            serviceId: 'haircut-finish',
            serviceName: 'Haircut & finish',
            priceFils: 16_000,
            staffId: 'maya',
          },
        ],
        ledger: [],
      });
    },
  };

  const context = {
    loadServices: (_branchId: string, ids: readonly string[]) => {
      const all = options.services ?? [HAIRCUT];
      return Promise.resolve(all.filter((s) => ids.includes(s.id)));
    },
    loadDay: () =>
      Promise.resolve({ professionals: [{ id: 'maya', name: 'Maya' }] }),
    loadCatalogue: () => Promise.resolve([{ id: 'haircut-finish' }]),
  };

  const productCatalogue = {
    enabled: () => options.productsEnabled === true,
    resolve: (branchId: string, ids: readonly string[]) => {
      record('catalogue.resolve', { branchId, ids });
      if (options.resolveThrows !== undefined) {
        return Promise.reject(options.resolveThrows);
      }
      return Promise.resolve(
        new Map(
          (options.offers ?? [catalogueRow(OIL)]).map((r) => [
            r.variantId.toLowerCase(),
            r,
          ]),
        ),
      );
    },
  };

  const handler = new MobileBookingHandler(
    holds as never,
    confirms as never,
    links as never,
    quotes as never,
    bookings as never,
    { record: () => Promise.reject(new Error('not used')) } as never,
    new TenantContext(),
    { transition: () => Promise.resolve({ kind: 'transitioned' }) } as never,
    context as never,
    productCatalogue as never,
  );

  const of = (method: string) => calls.filter((c) => c.method === method);
  const confirmArgs = () => {
    const call = of('confirms.execute')[0];
    if (call === undefined)
      throw new Error('confirms.execute was never called');
    return call.args as Record<string, unknown>;
  };

  return { handler, calls, of, confirmArgs };
}

/**
 * A payload whose money already adds up for the services alone.
 * AED 160 + AED 8 VAT = AED 168.
 */
function command(
  over: Partial<MobileBookingCommand> = {},
): MobileBookingCommand {
  return {
    salonId: SALON,
    services: [{ id: 'haircut-finish', amount: 160 }],
    products: undefined,
    stylists: ['maya'],
    date: '2026-09-20',
    startTime: START,
    endTime: END,
    amountWithoutTax: 160,
    taxAmount: 8,
    discount: 0,
    promoCode: null,
    total: 168,
    advancePaidAmount: 0,
    dueAmount: 168,
    paymentStatus: 'DRAFT',
    status: 'BOOKED',
    bookingType: 'SINGLE',
    customerId: CUSTOMER,
    idempotencyKey: undefined,
    ...over,
  };
}

/**
 * The same visit with two bottles of oil on it.
 * Services 160 + products 170 = 330 net; VAT 8 + 8.50 = 16.50; total 346.50.
 */
function withOil(
  over: Partial<MobileBookingCommand> = {},
): MobileBookingCommand {
  return command({
    products: [{ id: OIL, amount: 85, quantity: 2 }],
    amountWithoutTax: 330,
    taxAmount: 16.5,
    total: 346.5,
    dueAmount: 346.5,
    ...over,
  });
}

/** The field errors from a refusal, or a failure that says what happened. */
async function refusal(run: Promise<unknown>) {
  try {
    await run;
  } catch (e) {
    if (isMobileContractError(e)) return e;
    throw new Error(
      `expected a MobileContractError, got ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  throw new Error('expected a refusal, the call succeeded');
}

describe('with PRODUCTS_FROM_PLATFORM off', () => {
  it('still refuses a basket with products_not_supported', async () => {
    const { handler } = handlerWith({ productsEnabled: false });

    const e = await refusal(handler.execute(withOil()));

    expect(e.errors[0]).toMatchObject({
      field: 'products',
      code: 'products_not_supported',
    });
  });

  it('never asks the catalogue and never takes a chair', async () => {
    const { handler, of } = handlerWith({ productsEnabled: false });

    await refusal(handler.execute(withOil()));

    expect(of('catalogue.resolve')).toHaveLength(0);
    expect(of('holds.execute')).toHaveLength(0);
  });

  it('books normally when no products are sent', async () => {
    const { handler, of, confirmArgs } = handlerWith({
      productsEnabled: false,
    });

    await handler.execute(command());

    expect(of('holds.execute')).toHaveLength(1);
    expect('products' in confirmArgs()).toBe(false);
  });
});

describe('with the flag on, a basket that checks out', () => {
  const on = { productsEnabled: true } as const;

  it('confirms the booking and hands the priced lines to confirm', async () => {
    const { handler, confirmArgs } = handlerWith(on);

    await handler.execute(withOil());

    expect(confirmArgs().products).toStrictEqual([
      {
        productId: OIL,
        productName: 'Argan Oil (100 ml)',
        priceFils: 8_500,
        quantity: 2,
      },
    ]);
  });

  it('prices from the catalogue, never from the amount the app sent', async () => {
    // The app says AED 85 and the catalogue says AED 85: within tolerance,
    // so it passes -- but what is WRITTEN is the catalogue's fils.
    const { handler, confirmArgs } = handlerWith({
      ...on,
      offers: [catalogueRow(OIL, { priceMinor: 8_501 })],
    });

    // 8501 x 2 = AED 170.02 of oil, so every combined figure moves with it.
    await handler.execute(
      withOil({
        amountWithoutTax: 330.02,
        total: 346.52,
        dueAmount: 346.52,
      }),
    );

    const lines = confirmArgs().products as readonly { priceFils: number }[];
    expect(lines[0]!.priceFils).toBe(8_501);
  });

  it('asks the catalogue for exactly the ids the app sent, at this salon', async () => {
    const { handler, of } = handlerWith(on);

    await handler.execute(withOil());

    expect(of('catalogue.resolve')[0]!.args).toStrictEqual({
      branchId: SALON,
      ids: [OIL],
    });
  });

  it('prices the products BEFORE it takes the chair', async () => {
    const { handler, calls } = handlerWith(on);

    await handler.execute(withOil());

    const at = (m: string) => calls.findIndex((c) => c.method === m);
    expect(at('catalogue.resolve')).toBeLessThan(at('holds.execute'));
  });

  it('leaves the deposit to the quote, untouched by the basket', async () => {
    // A product is not deposit-bearing. The link is issued for what the
    // ladder asked of the SERVICES.
    const { handler, confirmArgs } = handlerWith(on);

    await handler.execute(withOil());

    expect(confirmArgs().payment).toStrictEqual({
      amountFils: QUOTE.depositMinor,
      rail: 'link',
    });
  });

  it('reports the combined money on the way back out', async () => {
    const { handler } = handlerWith(on);

    const view = (await handler.execute(withOil())) as Record<string, unknown>;

    expect(view.amount_without_tax).toBe(330);
    expect(view.tax_amount).toBe(16.5);
    expect(view.total).toBe(346.5);
    expect(view.due_amount).toBe(346.5);
  });

  it('sums several lines, and orders them as the customer picked', async () => {
    const { handler, confirmArgs } = handlerWith({
      ...on,
      offers: [catalogueRow(OIL), catalogueRow(SPRAY, { priceMinor: 4_000 })],
    });

    // 160 services + 170 oil + 40 spray = 370 net; VAT 8 + 10.50 = 18.50.
    const view = (await handler.execute(
      withOil({
        products: [
          { id: OIL, amount: 85, quantity: 2 },
          { id: SPRAY, amount: 40 },
        ],
        amountWithoutTax: 370,
        taxAmount: 18.5,
        total: 388.5,
        dueAmount: 388.5,
      }),
    )) as Record<string, unknown>;

    expect(view.total).toBe(388.5);
    expect(
      (confirmArgs().products as readonly { productId: string }[]).map(
        (p) => p.productId,
      ),
    ).toStrictEqual([OIL, SPRAY]);
  });
});

describe('the app must have added the products to its own totals', () => {
  const on = { productsEnabled: true } as const;

  it('refuses a basket whose money is the services alone', async () => {
    const { handler, of } = handlerWith(on);

    // The services-only figures, with two bottles of oil attached.
    const e = await refusal(
      handler.execute(
        withOil({
          amountWithoutTax: 160,
          taxAmount: 8,
          total: 168,
          dueAmount: 168,
        }),
      ),
    );

    expect(e.errors[0]).toMatchObject({
      field: 'amount_without_tax',
      code: 'amount_mismatch',
      // The combined figure, so the app can show the customer the new price.
      expected: 330,
    });
    expect(of('holds.execute')).toHaveLength(0);
  });

  it('names the tax when only the VAT is short', async () => {
    const { handler } = handlerWith(on);

    const e = await refusal(handler.execute(withOil({ taxAmount: 8 })));

    expect(e.errors[0]).toMatchObject({
      field: 'tax_amount',
      code: 'amount_mismatch',
      expected: 16.5,
    });
  });

  it('never lets a product be discounted', async () => {
    // discount stays the services' own, whatever the basket costs.
    const { handler } = handlerWith(on);

    const e = await refusal(handler.execute(withOil({ discount: 17 })));

    expect(e.errors[0]).toMatchObject({ field: 'discount', expected: 0 });
  });

  it('still asks for due_amount to equal the combined total on create', async () => {
    const { handler } = handlerWith(on);

    const e = await refusal(handler.execute(withOil({ dueAmount: 168 })));

    expect(e.errors[0]).toMatchObject({
      field: 'due_amount',
      code: 'amount_mismatch',
      expected: 346.5,
    });
  });
});

describe('a line the catalogue refuses', () => {
  const on = { productsEnabled: true } as const;

  it('comes back as the product error, not as a generic validation error', async () => {
    const { handler } = handlerWith({ ...on, offers: [] });

    const e = await refusal(handler.execute(withOil()));

    expect(e.errors).toStrictEqual([
      {
        field: 'products[0].id',
        code: 'unknown_product',
        message: `Not sold at this salon: ${OIL}.`,
      },
    ]);
  });

  it('takes no chair, so a refused basket costs the salon nothing', async () => {
    const { handler, of } = handlerWith({ ...on, offers: [] });

    await refusal(handler.execute(withOil()));

    expect(of('holds.execute')).toHaveLength(0);
    expect(of('holds.release')).toHaveLength(0);
    expect(of('confirms.execute')).toHaveLength(0);
  });

  it('reports every bad line at once', async () => {
    const { handler } = handlerWith({
      ...on,
      offers: [catalogueRow(OIL, { available: 1 })],
    });

    const e = await refusal(
      handler.execute(
        withOil({
          products: [
            { id: OIL, amount: 85, quantity: 2 },
            { id: SPRAY, amount: 40 },
          ],
        }),
      ),
    );

    expect(e.errors.map((x) => [x.field, x.code])).toStrictEqual([
      ['products[0].quantity', 'out_of_stock'],
      ['products[1].id', 'unknown_product'],
    ]);
  });

  it('refuses a product priced in another currency than the services', async () => {
    const { handler } = handlerWith({
      ...on,
      offers: [catalogueRow(OIL, { currency: 'BDT' })],
    });

    const e = await refusal(handler.execute(withOil()));

    expect(e.errors[0]).toMatchObject({
      field: 'products[0].id',
      code: 'currency_mismatch',
    });
  });

  it('answers 422, the shape the app parses for a field error', async () => {
    const { handler } = handlerWith({ ...on, offers: [] });

    const e = await refusal(handler.execute(withOil()));

    expect(e.status).toBe(422);
    expect(e.toBody().code).toBe('validation_error');
  });
});

describe('platform cannot be reached', () => {
  it('fails before the hold, so the slot is still on sale', async () => {
    const { handler, of } = handlerWith({
      productsEnabled: true,
      resolveThrows: new Error('UNAVAILABLE: products directory'),
    });

    await expect(handler.execute(withOil())).rejects.toThrow('UNAVAILABLE');

    expect(of('holds.execute')).toHaveLength(0);
    expect(of('confirms.execute')).toHaveLength(0);
  });
});

describe('an empty basket is not a basket', () => {
  it('does not call the catalogue for products: []', async () => {
    // Platform reads an empty id list as "every variant", and a round trip
    // to learn nothing is a round trip on the customer's phone.
    const { handler, of } = handlerWith({ productsEnabled: true });

    await handler.execute(command({ products: [] }));

    expect(of('catalogue.resolve')).toHaveLength(0);
  });

  it('passes no `products` key to confirm, so no rows are written', async () => {
    const { handler, confirmArgs } = handlerWith({ productsEnabled: true });

    await handler.execute(command({ products: [] }));

    expect('products' in confirmArgs()).toBe(false);
  });

  it('does the same for products omitted entirely', async () => {
    const { handler, of, confirmArgs } = handlerWith({ productsEnabled: true });

    await handler.execute(command());

    expect(of('catalogue.resolve')).toHaveLength(0);
    expect('products' in confirmArgs()).toBe(false);
  });
});

describe('a basket does not disturb the rest of the create', () => {
  const on = { productsEnabled: true } as const;

  it('leaves the window check on the services duration alone', async () => {
    const { handler } = handlerWith(on);

    const e = await refusal(
      handler.execute(withOil({ endTime: '2026-09-20T15:30:00+06:00' })),
    );

    expect(e.errors[0]!.code).toBe('invalid_window');
  });

  it('is refused for ROUTINE before any product is priced', async () => {
    const { handler, of } = handlerWith(on);

    const e = await refusal(
      handler.execute(withOil({ bookingType: 'ROUTINE' })),
    );

    expect(e.errors[0]!.code).toBe('routine_not_supported');
    expect(of('catalogue.resolve')).toHaveLength(0);
  });

  it('releases the hold and expires the booking when a later step fails', async () => {
    const warn = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const { handler, of } = handlerWith(on);
    // The link is the last step; make it the one that breaks.
    const broken = Object.assign(handler, {});
    (broken as unknown as { links: { execute: () => Promise<never> } }).links =
      {
        execute: () => Promise.reject(new Error('gateway down')),
      };

    await expect(handler.execute(withOil())).rejects.toThrow('gateway down');

    expect(of('holds.release')).toHaveLength(1);
    warn.mockRestore();
  });
});

describe('what the create response says about the products', () => {
  it('reports an empty products array, even for a basket that was sold', async () => {
    /**
     * PINNED AS IT IS TODAY, NOT AS THE CONTRACT WANTS IT. §8 of
     * booking-create.md returns `products: [{id, name, amount}]`, and
     * `present` hardcodes `[]` with a comment from when products were
     * refused outright. The rows ARE written -- booking.repository.spec
     * proves that -- so this is a read-back gap, not a lost sale.
     *
     * Change this expectation the day the read fills it in.
     */
    const { handler } = handlerWith({ productsEnabled: true });

    const view = (await handler.execute(withOil())) as Record<string, unknown>;

    expect(view.products).toStrictEqual([]);
  });
});

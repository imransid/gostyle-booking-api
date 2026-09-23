import { afterEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import {
  MobileBookingHandler,
  type MobileBookingCommand,
} from './mobile-booking.handler';
import { isMobileContractError } from './mobile-booking.error';
import { TenantContext } from '@infrastructure/tenancy/tenant-context';
import type { CatalogueProduct } from '@application/ports/products-directory.port';
import type { Service } from '@domain/availability/feasible';
import type { SoldProduct } from '@domain/booking/mobile-products';
import { toUuid } from '@infrastructure/persistence/hold.repository';

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
 *   4. EVERY READ PRICES THE PRODUCTS AS SOLD. Read, list and PATCH add
 *      booking_product to the services' figures, never ask the catalogue,
 *      and never depend on the flag -- and create and read agree.
 *
 * Every collaborator is a hand-written double that records what it was
 * given, so a test asserts on the call the handler actually made.
 */

const SALON = 'marina-walk';
const CUSTOMER = 'cus_ayesha';
const BOOKING = 'eeeeeeee-5555-4eee-8eee-eeeeeeeeeeee';
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
  /** booking_product rows already on the stored booking, before any create. */
  readonly sold?: readonly SoldProduct[];
  /** The customer's list page: one booking per entry, each with these rows. */
  readonly page?: readonly (readonly SoldProduct[])[];
  /** The quote handler cannot price the booking (a retired service, say). */
  readonly quoteThrows?: Error;
  /** The breakdown stored at creation. Null throughout by default. */
  readonly stored?: {
    readonly netFils: number | null;
    readonly taxFils: number | null;
    readonly discountFils: number | null;
  };
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

  /**
   * booking_product, as the repository would hold it: whatever confirm was
   * handed is what every later read gets back. A read test that seeded its
   * own rows could agree with itself and still disagree with create.
   */
  let sold: readonly SoldProduct[] = options.sold ?? [];

  const confirms = {
    execute: (args: unknown) => {
      record('confirms.execute', args);
      sold = (args as { products?: readonly SoldProduct[] }).products ?? [];
      return Promise.resolve({ bookingId: BOOKING });
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
      if (options.quoteThrows !== undefined) {
        return Promise.reject(options.quoteThrows);
      }
      return Promise.resolve(QUOTE);
    },
  };

  /** One stored booking, as detail() and customerPage() both return it. */
  const row = (id: string, products: readonly SoldProduct[]) => ({
    id,
    code: 'GS-1001',
    tenantId: null,
    branchId: SALON,
    // The column holds the folded uuid, never the slug (CLAUDE.md 8).
    customerId: toUuid(CUSTOMER),
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
    ...options.stored,
    depositFils: 5_000,
    items: [
      {
        serviceId: 'haircut-finish',
        serviceName: 'Haircut & finish',
        priceFils: 16_000,
        staffId: 'maya',
      },
    ],
    products,
    ledger: [],
  });

  const bookings = {
    detail: (id: string) => {
      record('bookings.detail', id);
      return Promise.resolve(row(id, sold));
    },
    customerPage: (args: unknown) => {
      record('bookings.customerPage', args);
      const rows = (options.page ?? []).map((p, i) => row(`booking-${i}`, p));
      return Promise.resolve({
        rows,
        count: rows.length,
        counts: { upcoming: rows.length, archive: 0 },
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

  const payments = {
    record: (args: unknown) => {
      record('payments.record', args);
      return Promise.resolve({ kind: 'recorded' });
    },
  };

  const handler = new MobileBookingHandler(
    holds as never,
    confirms as never,
    links as never,
    quotes as never,
    bookings as never,
    payments as never,
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
  it('lists the products sold, read back from the rows confirm wrote', async () => {
    /**
     * §8 returns `products: [{id, name, amount, quantity}]`, and `present`
     * now fills it from booking_product rather than hardcoding `[]`. The
     * name is the catalogue's at the moment of sale and `amount` is the UNIT
     * price, as the app sent it in -- not the line total.
     *
     * The fake's detail() returns exactly what confirm was handed, so this
     * is the round trip: priced on the way in, stored, read back out.
     */
    const { handler } = handlerWith({ productsEnabled: true });

    const view = (await handler.execute(withOil())) as Record<string, unknown>;

    expect(view.products).toStrictEqual([
      { id: OIL, name: 'Argan Oil (100 ml)', amount: 85, quantity: 2 },
    ]);
  });
});

/** Two bottles of oil, as booking_product holds them after a sale. */
const OIL_SOLD: SoldProduct = {
  productId: OIL,
  productName: 'Argan Oil (100 ml)',
  priceFils: 8_500,
  quantity: 2,
};

/** The customer who owns BOOKING, as the token names them. */
const OWNER = {
  bookingId: BOOKING,
  actorId: CUSTOMER,
  actorKind: 'customer',
  actorBranchId: null,
} as const;

/** A §11 body, FULLY_PAID for the combined AED 346.50 unless told otherwise. */
const patch = (
  over: Partial<Parameters<MobileBookingHandler['recordPayment']>[0]> = {},
) => ({
  ...OWNER,
  paymentStatus: 'FULLY_PAID',
  paymentMethod: 'CARD' as const,
  advancePaidAmount: 346.5,
  dueAmount: 0,
  paymentReference: null,
  ...over,
});

describe('§10 read: the products are part of what the booking is worth', () => {
  it('lists the sold products and adds them to every figure', async () => {
    const { handler } = handlerWith({
      productsEnabled: true,
      sold: [OIL_SOLD],
    });

    const view = (await handler.read(OWNER)) as Record<string, unknown>;

    expect(view.products).toStrictEqual([
      { id: OIL, name: 'Argan Oil (100 ml)', amount: 85, quantity: 2 },
    ]);
    // Services 160 + oil 170 = 330; VAT 8 + 8.50 = 16.50; total 346.50.
    expect(view.amount_without_tax).toBe(330);
    expect(view.tax_amount).toBe(16.5);
    expect(view.discount).toBe(0);
    expect(view.total).toBe(346.5);
    expect(view.due_amount).toBe(346.5);
  });

  it('never asks the catalogue: the sold line is priced from its row', async () => {
    const { handler, of } = handlerWith({
      productsEnabled: true,
      sold: [OIL_SOLD],
    });

    await handler.read(OWNER);

    expect(of('catalogue.resolve')).toHaveLength(0);
  });

  it('still lists and charges for them with PRODUCTS_FROM_PLATFORM off', async () => {
    // Sold while the flag was on, read after it was turned off. The
    // customer still owes for the oil.
    const { handler, of } = handlerWith({
      productsEnabled: false,
      sold: [OIL_SOLD],
    });

    const view = (await handler.read(OWNER)) as Record<string, unknown>;

    expect(view.products).toStrictEqual([
      { id: OIL, name: 'Argan Oil (100 ml)', amount: 85, quantity: 2 },
    ]);
    expect(view.total).toBe(346.5);
    expect(of('catalogue.resolve')).toHaveLength(0);
  });

  it('reports only the services for a booking that sold none', async () => {
    const { handler } = handlerWith({ productsEnabled: true });

    const view = (await handler.read(OWNER)) as Record<string, unknown>;

    expect(view.products).toStrictEqual([]);
    expect(view.total).toBe(168);
  });
});

describe('§10 read when the quote cannot price the services', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const unpriced = (stored: HandlerOptions['stored']) => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    return handlerWith({
      productsEnabled: true,
      sold: [OIL_SOLD],
      quoteThrows: new Error('Unknown service: haircut-finish'),
      stored,
    });
  };

  it('adds the products to the stored breakdown', async () => {
    // The breakdown create wrote: the SERVICES' 160 + 8, nothing else.
    const { handler } = unpriced({
      netFils: 16_000,
      taxFils: 800,
      discountFils: 0,
    });

    const view = (await handler.read(OWNER)) as Record<string, unknown>;

    expect(view.amount_without_tax).toBe(330);
    expect(view.tax_amount).toBe(16.5);
    expect(view.total).toBe(346.5);
    expect(view.due_amount).toBe(346.5);
  });

  it('reports no total rather than the products alone when nothing was stored', async () => {
    // AED 178.50 of oil is not what this booking costs. Unknown stays
    // unknown; the lines themselves are still listed.
    const { handler } = unpriced({
      netFils: null,
      taxFils: null,
      discountFils: null,
    });

    const view = (await handler.read(OWNER)) as Record<string, unknown>;

    expect(view.amount_without_tax).toBeNull();
    expect(view.total).toBeNull();
    expect(view.due_amount).toBeNull();
    expect(view.products).toHaveLength(1);
  });
});

describe('the list: each row is worth its own products', () => {
  it("adds a row's products to its total and due, and only to its own", async () => {
    const { handler } = handlerWith({
      productsEnabled: true,
      page: [[OIL_SOLD], []],
    });

    const page = (await handler.list({
      customerId: CUSTOMER,
      filter: 'upcoming',
      page: 1,
      pageSize: 20,
    })) as { results: readonly Record<string, unknown>[] };

    expect(page.results.map((r) => [r.total, r.due_amount])).toStrictEqual([
      [346.5, 346.5],
      [168, 168],
    ]);
  });

  it('never asks the catalogue', async () => {
    const { handler, of } = handlerWith({
      productsEnabled: true,
      page: [[OIL_SOLD]],
    });

    await handler.list({
      customerId: CUSTOMER,
      filter: 'upcoming',
      page: 1,
      pageSize: 20,
    });

    expect(of('catalogue.resolve')).toHaveLength(0);
  });
});

describe('§11 PATCH checks the payment against the combined total', () => {
  it('accepts FULLY_PAID for services and products together', async () => {
    const { handler, of } = handlerWith({
      productsEnabled: true,
      sold: [OIL_SOLD],
    });

    const view = (await handler.recordPayment(patch())) as Record<
      string,
      unknown
    >;

    expect(of('payments.record')[0]!.args).toMatchObject({
      amountFils: 34_650,
      paymentStatus: 'fully_paid',
    });
    expect(view.total).toBe(346.5);
    expect(of('catalogue.resolve')).toHaveLength(0);
  });

  it('refuses FULLY_PAID for the services alone, naming the combined figure', async () => {
    const { handler, of } = handlerWith({
      productsEnabled: true,
      sold: [OIL_SOLD],
    });

    const e = await refusal(
      handler.recordPayment(patch({ advancePaidAmount: 168 })),
    );

    expect(e.errors[0]).toMatchObject({
      field: 'advance_paid_amount',
      code: 'amount_mismatch',
      expected: 346.5,
    });
    expect(of('payments.record')).toHaveLength(0);
  });

  it('checks due_amount against the combined total on a deposit', async () => {
    // AED 50 down leaves 296.50, not the services' 118.
    const { handler } = handlerWith({
      productsEnabled: true,
      sold: [OIL_SOLD],
    });

    const e = await refusal(
      handler.recordPayment(
        patch({
          paymentStatus: 'PARTIALLY',
          advancePaidAmount: 50,
          dueAmount: 118,
        }),
      ),
    );

    expect(e.errors[0]).toMatchObject({
      field: 'due_amount',
      code: 'amount_mismatch',
      expected: 296.5,
    });
  });
});

describe('create and read agree: the products are counted once', () => {
  it('reads back the same money the create reported', async () => {
    // Create already adds the products to the quote; the row's net_fils is
    // the services' alone. If either path added them a second time, one of
    // these would read 525 (346.50 + 178.50).
    const { handler } = handlerWith({ productsEnabled: true });

    const created = (await handler.execute(withOil())) as Record<
      string,
      unknown
    >;
    const read = (await handler.read(OWNER)) as Record<string, unknown>;

    const money = (v: Record<string, unknown>) => ({
      amount_without_tax: v.amount_without_tax,
      tax_amount: v.tax_amount,
      discount: v.discount,
      total: v.total,
      due_amount: v.due_amount,
      products: v.products,
    });
    expect(money(created)).toStrictEqual({
      amount_without_tax: 330,
      tax_amount: 16.5,
      discount: 0,
      total: 346.5,
      due_amount: 346.5,
      products: [
        { id: OIL, name: 'Argan Oil (100 ml)', amount: 85, quantity: 2 },
      ],
    });
    expect(money(read)).toStrictEqual(money(created));
  });
});

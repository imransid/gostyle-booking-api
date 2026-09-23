import { describe, expect, it } from 'vitest';
import { ConfirmBookingHandler } from './confirm-booking.handler';
import type { ConfirmBookingCommand } from './confirm-booking.handler';
import type {
  ConfirmBookingInput,
  ConfirmProduct,
} from '@infrastructure/persistence/booking.repository';
import type { Service } from '@domain/availability/feasible';
import type { CustomerContext } from '@application/ports/customer-context.port';

/**
 * HANDLER SPEC — the PRODUCTS PASS-THROUGH, and nothing else it touches.
 *
 * This handler already owns the deposit ladder, the link window and the
 * nine-write transaction, all proven elsewhere. What is new is one line:
 * `products` reaches the repository if the caller sent any, and the key is
 * absent if they did not. Both halves matter.
 *
 * ABSENT, NOT `undefined`. Every desk, group and wizard path builds its
 * command without the key, and `ConfirmBookingInput.products` is optional.
 * Spreading `{ products: undefined }` into the input would still satisfy the
 * type while changing what persistence receives, so the test asks whether
 * the key is THERE, not what its value is.
 *
 * WHAT IS DELIBERATELY NOT ASSERTED HERE: that the money changes. It does
 * not. The handler quotes the SERVICES and stores those figures; a product
 * adds nothing to price_fils, net_fils or the deposit requirement. That is
 * pinned below so a later change to it is a decision somebody makes rather
 * than one that slips through.
 */

const HOLD = '11111111-1111-4111-8111-111111111111';
const OIL = 'cccccccc-3333-4ccc-8ccc-cccccccccccc';

const HAIRCUT: Service = {
  id: 'haircut-finish',
  name: 'Haircut & finish',
  skill: 'cut',
  requiredLevel: 1,
  durationMin: 45,
  resourceType: 'chair',
  claims: { preMin: 0, postMin: 0 },
  depositPercent: null,
  depositFixedFils: null,
};

const CUSTOMER: CustomerContext = {
  customerId: 'cus_ayesha',
  name: 'Ayesha',
  tier: 'none',
  risk: 'LOW',
  riskScore: 80,
  // A returning customer with no flags, so the ladder asks for nothing and
  // the 402 branch stays out of the way of what is being tested.
  isNewCustomer: false,
  requireDepositFlag: false,
  isVip: false,
};

function handlerWith(
  over: { readonly customer?: Partial<CustomerContext> } = {},
) {
  const seen: ConfirmBookingInput[] = [];

  const context = {
    loadServices: () => Promise.resolve([HAIRCUT]),
    loadDay: () => Promise.reject(new Error('not used')),
    loadCatalogue: () => Promise.reject(new Error('not used')),
  };

  const bookings = {
    confirm: (input: ConfirmBookingInput) => {
      seen.push(input);
      return Promise.resolve({
        kind: 'confirmed' as const,
        booking: {
          bookingId: 'booking-1',
          code: 'GS-1001',
          status: 'confirmed' as const,
          paymentStatus: 'none_required' as const,
          startMin: 600,
          durationMin: 45,
          staffId: 'staff-uuid',
        },
      });
    },
  };

  const prisma = {
    idempotencyKey: {
      findUnique: () => Promise.resolve(null),
      update: () => Promise.resolve({}),
    },
    staffReservation: {
      findFirst: () => Promise.resolve({ staffId: 'maya', startMinute: 600 }),
    },
  };

  const customers = {
    load: () => Promise.resolve({ ...CUSTOMER, ...over.customer }),
  };

  /**
   * `prisma` and `bookings` are cast: both are concrete classes with private
   * state, and a double cannot be structurally assignable to one. `context`
   * and `customers` are plain interfaces, so their doubles satisfy them
   * outright and are passed unhelped -- which is worth something, because a
   * cast is exactly where a fake can drift out of shape unnoticed.
   */
  const handler = new ConfirmBookingHandler(
    context,
    bookings as never,
    prisma as never,
    customers,
  );

  /** What persistence was asked to write. */
  const written = (): ConfirmBookingInput => {
    const input = seen[0];
    if (input === undefined)
      throw new Error('bookings.confirm was never called');
    return input;
  };

  return { handler, written, seen };
}

function command(
  over: Partial<ConfirmBookingCommand> = {},
): ConfirmBookingCommand {
  return {
    holdId: HOLD,
    branchId: 'marina-walk',
    customerId: 'cus_ayesha',
    tradingDay: '2026-09-20',
    serviceIds: ['haircut-finish'],
    channel: 'online',
    ...over,
  };
}

const PRODUCTS: readonly ConfirmProduct[] = [
  {
    productId: OIL,
    productName: 'Argan Oil (100 ml)',
    priceFils: 8_500,
    quantity: 2,
  },
];

describe('products reach persistence, or the key does not exist', () => {
  it('omits the key entirely when the command carries no products', async () => {
    const { handler, written } = handlerWith();

    await handler.execute(command());

    expect('products' in written()).toBe(false);
  });

  it('forwards the lines verbatim when the command carries some', async () => {
    const { handler, written } = handlerWith();

    await handler.execute(command({ products: PRODUCTS }));

    expect(written().products).toStrictEqual(PRODUCTS);
  });

  it('forwards an empty array as an empty array, not as an absent key', async () => {
    // The repository then writes nothing for it, which is the same outcome
    // either way -- but the two are different inputs and this says which
    // one persistence gets.
    const { handler, written } = handlerWith();

    await handler.execute(command({ products: [] }));

    expect('products' in written()).toBe(true);
    expect(written().products).toStrictEqual([]);
  });

  it('changes nothing about the line items beside them', async () => {
    const { handler, written } = handlerWith();

    await handler.execute(command({ products: PRODUCTS }));

    expect(written().items).toStrictEqual([
      {
        serviceId: 'haircut-finish',
        serviceName: 'Haircut & finish',
        resourceType: 'chair',
        requiredSkill: 'cut',
        priceFils: 16_000,
        durationMin: 45,
        staffId: 'maya',
        source: 'fixture',
      },
    ]);
  });
});

describe('a product does not move the money this handler decides', () => {
  /**
   * PINNED, NOT ENDORSED. `price_fils`, `net_fils`, `tax_fils` and the
   * deposit are all quoted from the SERVICES. The product's share of the
   * bill is verified against the app in the mobile handler and stored on
   * booking_product, where the read path adds it back.
   *
   * If that ever changes, these four expectations are where it will be
   * noticed -- rather than in a reconciliation months later.
   */
  it('stores the services figures, with no product money in them', async () => {
    const { handler, written } = handlerWith();

    await handler.execute(command({ products: PRODUCTS }));

    const w = written();
    expect(w.priceFils).toBe(16_000);
    expect(w.netFils).toBe(16_000);
    // 5% of the services' net, with the products' AED 170 nowhere in it.
    expect(w.taxFils).toBe(800);
    expect(w.discountFils).toBe(0);
  });

  it('returns the same totals it would have without them', async () => {
    const { handler } = handlerWith();

    const withProducts = await handler.execute(command({ products: PRODUCTS }));
    const without = await handlerWith().handler.execute(command());

    expect(withProducts.totalMinor).toBe(without.totalMinor);
    expect(withProducts.totalNetMinor).toBe(without.totalNetMinor);
    expect(withProducts.vatMinor).toBe(without.vatMinor);
  });

  it('does not let a product raise the deposit the ladder asks for', async () => {
    // Rung 4a on a first-timer: a percentage of the SERVICES' net. A basket
    // of oil must not change what the customer has to pay up front.
    const { handler, written } = handlerWith({
      customer: { isNewCustomer: true },
    });
    const { written: bare, handler: bareHandler } = handlerWith({
      customer: { isNewCustomer: true },
    });

    await handler.execute(
      command({
        products: PRODUCTS,
        depositDeferred: true,
      }),
    );
    await bareHandler.execute(command({ depositDeferred: true }));

    expect(written().requirementSource).toBe(bare().requirementSource);
  });
});

describe('products ride along with every arrangement', () => {
  it('goes through on the pay-at-the-salon path, which sends no payment', async () => {
    const { handler, written } = handlerWith({
      customer: { isNewCustomer: true },
    });

    await handler.execute(
      command({ products: PRODUCTS, depositDeferred: true }),
    );

    expect(written().payment).toBeNull();
    expect(written().products).toStrictEqual(PRODUCTS);
  });

  it('goes through on the link path, beside the payment record', async () => {
    const { handler, written } = handlerWith();

    await handler.execute(
      command({
        products: PRODUCTS,
        // Far enough out that the six-hour link window is open.
        tradingDay: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
          .toISOString()
          .slice(0, 10),
        payment: { amountFils: 0, rail: 'link' },
      }),
    );

    expect(written().payment).toStrictEqual({
      amountFils: 0,
      rail: 'link',
      gatewayRef: null,
    });
    expect(written().products).toStrictEqual(PRODUCTS);
  });
});

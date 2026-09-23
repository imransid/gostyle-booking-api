import { describe, expect, it } from 'vitest';
import {
  BookingRepository,
  type ConfirmBookingInput,
} from './booking.repository';
import { TenantContext } from '../tenancy/tenant-context';
import { toUuid } from './hold.repository';

/**
 * REPOSITORY SPEC — proves WHAT IS WRITTEN, with a fake transaction.
 *
 * No database here, and that is the point: CLAUDE.md 5 says the constraints
 * and the wiring are proven live, against real Postgres, and nothing a fake
 * says can stand in for that. What a fake CAN pin is the shape of the write
 * itself, and the three things about booking_product that are invisible
 * from outside and silent when wrong:
 *
 *   1. a desk path that never heard of products writes no product rows,
 *   2. `product_id` is the platform variant id and is NOT folded through
 *      toUuid() the way branch, customer and service ids are (CLAUDE.md 8) --
 *      fold it and every row points at a variant that does not exist,
 *   3. the rows go in the SAME transaction as the booking, so a rollback
 *      takes them with it and there is no orphan basket.
 *
 * The double records every call it receives, so a test can assert on the
 * argument the repository actually passed rather than on a return value.
 */

interface Call {
  readonly method: string;
  readonly args: readonly unknown[];
}

/**
 * The transaction client, recording everything.
 *
 * `$queryRaw` is a tagged template in the repository, so it is a function
 * here too, and it answers by looking at the SQL: the hold probe and the
 * code sequence are the only two.
 */
function fakeTx(over: { readonly holdAlive?: boolean } = {}) {
  const calls: Call[] = [];
  const record = <T>(
    method: string,
    args: readonly unknown[],
    result: T,
  ): T => {
    calls.push({ method, args });
    return result;
  };
  let items = 0;

  const tx = {
    $queryRaw: (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join('?');
      if (sql.includes('FROM hold')) {
        return Promise.resolve(
          record(
            'hold.probe',
            values,
            over.holdAlive === false ? [] : [{ id: 'hold-1' }],
          ),
        );
      }
      if (sql.includes('booking_code_seq')) {
        return Promise.resolve(
          record('code.next', values, [{ code: 'GS-1001' }]),
        );
      }
      throw new Error(`unexpected $queryRaw: ${sql}`);
    },
    staffReservation: {
      findFirst: (a: unknown) =>
        Promise.resolve(
          record('staffReservation.findFirst', [a], {
            staffId: 'staff-uuid',
            startMinute: 600,
            startAt: new Date('2026-09-20T06:00:00.000Z'),
            endAt: new Date('2026-09-20T06:45:00.000Z'),
          }),
        ),
      updateMany: (a: unknown) =>
        Promise.resolve(
          record('staffReservation.updateMany', [a], { count: 1 }),
        ),
    },
    resourceReservation: {
      updateMany: (a: unknown) =>
        Promise.resolve(
          record('resourceReservation.updateMany', [a], { count: 1 }),
        ),
    },
    booking: {
      create: (a: unknown) =>
        Promise.resolve(
          record('booking.create', [a], { id: 'booking-1', code: 'GS-1001' }),
        ),
    },
    bookingItem: {
      create: (a: unknown) => {
        items += 1;
        return Promise.resolve(
          record('bookingItem.create', [a], { id: `item-${items}` }),
        );
      },
    },
    bookingProduct: {
      createMany: (a: unknown) =>
        Promise.resolve(record('bookingProduct.createMany', [a], { count: 0 })),
    },
    depositLedger: {
      create: (a: unknown) =>
        Promise.resolve(record('depositLedger.create', [a], {})),
    },
    bookingStatusHistory: {
      create: (a: unknown) =>
        Promise.resolve(record('bookingStatusHistory.create', [a], {})),
    },
    eventOutbox: {
      create: (a: unknown) =>
        Promise.resolve(record('eventOutbox.create', [a], {})),
    },
    idempotencyKey: {
      create: (a: unknown) =>
        Promise.resolve(record('idempotencyKey.create', [a], {})),
    },
    hold: {
      delete: (a: unknown) => Promise.resolve(record('hold.delete', [a], {})),
    },
  };

  return { tx, calls };
}

function repositoryWith(over: { readonly holdAlive?: boolean } = {}) {
  const { tx, calls } = fakeTx(over);

  const prisma = {
    $transaction: <T>(fn: (client: typeof tx) => Promise<T>): Promise<T> =>
      fn(tx),
    idempotencyKey: {
      findUnique: () => Promise.resolve(null),
    },
    /**
     * OUTSIDE the transaction, so a write that landed here instead of on
     * `tx` would not be rolled back with the booking. Nothing may use it.
     */
    bookingProduct: {
      createMany: () => {
        throw new Error('booking_product written OUTSIDE the transaction');
      },
    },
  };

  const repository = new BookingRepository(
    prisma as never,
    new TenantContext(),
  );

  const of = (method: string) => calls.filter((c) => c.method === method);
  return { repository, calls, of };
}

const ITEM = {
  serviceId: 'haircut-finish',
  serviceName: 'Haircut & finish',
  resourceType: 'chair',
  requiredSkill: 'cut',
  priceFils: 16_000,
  durationMin: 45,
  staffId: 'maya',
  source: 'platform' as const,
};

const OIL = 'cccccccc-3333-4ccc-8ccc-cccccccccccc';
const SPRAY = 'dddddddd-4444-4ddd-8ddd-dddddddddddd';

function input(over: Partial<ConfirmBookingInput> = {}): ConfirmBookingInput {
  return {
    holdId: '11111111-1111-4111-8111-111111111111',
    branchId: 'marina-walk',
    customerId: 'cus_ayesha',
    tradingDay: '2026-09-20',
    channel: 'online',
    items: [ITEM],
    priceFils: 16_000,
    depositFils: 0,
    requirementSource: null,
    payment: null,
    actorId: null,
    idempotencyKey: null,
    requestHash: 'hash',
    linkExpiresAt: null,
    ...over,
  };
}

/** The `data` array handed to bookingProduct.createMany. */
function productRows(
  of: (m: string) => Call[],
): readonly Record<string, unknown>[] {
  const call = of('bookingProduct.createMany')[0];
  if (call === undefined)
    throw new Error('bookingProduct.createMany was never called');
  return (call.args[0] as { data: Record<string, unknown>[] }).data;
}

describe('confirm() writes no products unless it is given some', () => {
  it('writes none when the input omits `products` entirely', async () => {
    const { repository, of } = repositoryWith();

    const outcome = await repository.confirm(input());

    expect(outcome.kind).toBe('confirmed');
    expect(of('bookingProduct.createMany')).toHaveLength(0);
  });

  it('writes none for an empty array, rather than an empty createMany', async () => {
    const { repository, of } = repositoryWith();

    await repository.confirm(input({ products: [] }));

    expect(of('bookingProduct.createMany')).toHaveLength(0);
  });

  it('still confirms the booking itself, exactly as before', async () => {
    const { repository, of } = repositoryWith();

    await repository.confirm(input());

    expect(of('booking.create')).toHaveLength(1);
    expect(of('bookingItem.create')).toHaveLength(1);
    expect(of('hold.delete')).toHaveLength(1);
  });
});

describe('confirm() with products', () => {
  const products = [
    {
      productId: OIL,
      productName: 'Argan Oil (100 ml)',
      priceFils: 8_500,
      quantity: 2,
    },
    {
      productId: SPRAY,
      productName: 'Sea Salt Spray',
      priceFils: 4_000,
      quantity: 1,
    },
  ];

  it('writes one row per line, in ONE createMany', async () => {
    const { repository, of } = repositoryWith();

    await repository.confirm(input({ products }));

    expect(of('bookingProduct.createMany')).toHaveLength(1);
    expect(productRows(of)).toHaveLength(2);
  });

  it('carries the name, the unit price and the quantity through untouched', async () => {
    const { repository, of } = repositoryWith();

    await repository.confirm(input({ products }));

    expect(productRows(of)).toStrictEqual([
      {
        bookingId: 'booking-1',
        productId: OIL,
        productName: 'Argan Oil (100 ml)',
        priceFils: 8_500,
        quantity: 2,
        position: 0,
      },
      {
        bookingId: 'booking-1',
        productId: SPRAY,
        productName: 'Sea Salt Spray',
        priceFils: 4_000,
        quantity: 1,
        position: 1,
      },
    ]);
  });

  it('numbers `position` by the order the customer picked, from 0', async () => {
    const { repository, of } = repositoryWith();

    await repository.confirm(input({ products: [...products].reverse() }));

    expect(productRows(of).map((r) => [r.productId, r.position])).toStrictEqual(
      [
        [SPRAY, 0],
        [OIL, 1],
      ],
    );
  });

  it('does NOT fold the variant id through toUuid, though it folds the service', async () => {
    /**
     * CLAUDE.md 8, from the other side. The fold exists so fixture SLUGS can
     * live in uuid columns; a variant id is already a platform uuid and must
     * reach the row as platform spells it.
     *
     * Probed with an UPPERCASE uuid, because that is the one input the two
     * treatments disagree on: toUuid() passes a uuid through but lowercases
     * it, so a `productId` that is still uppercase proves nothing folded it.
     * The service beside it is a slug, and comes out as the hash.
     */
    const { repository, of } = repositoryWith();

    await repository.confirm(
      input({
        products: [{ ...products[0]!, productId: OIL.toUpperCase() }],
      }),
    );

    expect(productRows(of)[0]!.productId).toBe(OIL.toUpperCase());
    expect(productRows(of)[0]!.productId).not.toBe(toUuid(OIL.toUpperCase()));

    const item = of('bookingItem.create')[0]!.args[0] as {
      data: { serviceId: string };
    };
    expect(item.data.serviceId).toBe(toUuid('haircut-finish'));
    expect(item.data.serviceId).not.toBe('haircut-finish');
  });

  it('links every row to the booking just created', async () => {
    const { repository, of } = repositoryWith();

    await repository.confirm(input({ products }));

    for (const row of productRows(of)) expect(row.bookingId).toBe('booking-1');
  });
});

describe('where and when the product rows are written', () => {
  const products = [
    { productId: OIL, productName: 'Argan Oil', priceFils: 8_500, quantity: 1 },
  ];

  it('goes on the transaction client, never on the pooled one', async () => {
    // The fake throws from prisma.bookingProduct.createMany, so a write that
    // escaped the transaction fails this test loudly rather than quietly
    // surviving a rollback.
    const { repository, of } = repositoryWith();

    await repository.confirm(input({ products }));

    expect(of('bookingProduct.createMany')).toHaveLength(1);
  });

  it('runs after the booking exists and before the reservations move', async () => {
    // Order is the only thing standing between a product row and a foreign
    // key violation: booking_product.booking_id references a booking that
    // must already be there.
    const { repository, calls } = repositoryWith();

    await repository.confirm(input({ products }));

    const at = (m: string) => calls.findIndex((c) => c.method === m);
    expect(at('booking.create')).toBeLessThan(at('bookingProduct.createMany'));
    expect(at('bookingProduct.createMany')).toBeLessThan(
      at('staffReservation.updateMany'),
    );
  });

  it('writes nothing at all when the hold is already dead', async () => {
    const { repository, of } = repositoryWith({ holdAlive: false });

    const outcome = await repository.confirm(input({ products }));

    expect(outcome.kind).toBe('hold_expired');
    expect(of('bookingProduct.createMany')).toHaveLength(0);
    expect(of('booking.create')).toHaveLength(0);
  });
});

describe('products do not change what the booking itself stores', () => {
  it('leaves price_fils and deposit_fils exactly as the handler set them', async () => {
    // Persistence does not re-price. The money a product adds is the
    // handler's arithmetic, verified against the app before this runs.
    const { repository, of } = repositoryWith();

    await repository.confirm(
      input({
        priceFils: 16_000,
        depositFils: 8_000,
        products: [
          {
            productId: OIL,
            productName: 'Argan Oil',
            priceFils: 8_500,
            quantity: 2,
          },
        ],
      }),
    );

    const booking = of('booking.create')[0]!.args[0] as {
      data: { priceFils: number; depositFils: number };
    };
    expect(booking.data.priceFils).toBe(16_000);
    expect(booking.data.depositFils).toBe(8_000);
  });
});

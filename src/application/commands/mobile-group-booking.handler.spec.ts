import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConflictException, Logger } from '@nestjs/common';
import {
  MobileGroupBookingHandler,
  type MobileGroupBookingCommand,
  type MobileGroupMemberCommand,
} from './mobile-group-booking.handler';
import {
  isMobileContractError,
  type MobileContractError,
} from './mobile-booking.error';
import type { Service } from '@domain/availability/feasible';
import type { MobileGroupConfirmInput } from '@infrastructure/persistence/mobile-group-confirm.repository';
import type { CatalogueProduct } from '@application/ports/products-directory.port';

const BOOKER = '11111111-1111-4111-8111-111111111111';
const RANA = '22222222-2222-4222-8222-222222222222';
const GROUP = 'aaaaaaaa-0000-4aaa-8aaa-aaaaaaaaaaaa';
const HOLD = 'bbbbbbbb-0000-4bbb-8bbb-bbbbbbbbbbbb';
const POMADE = 'cccccccc-3333-4ccc-8ccc-cccccccccccc';
const GEL = 'dddddddd-4444-4ddd-8ddd-dddddddddddd';

/** 09:00 at the branch (+06:00). Every start below is measured from here. */
const NOW = new Date('2026-10-11T03:00:00Z');
/** 15:00 at the branch. */
const START = '2026-10-11T15:00:00+06:00';

const HAIRCUT: Service = {
  id: 'haircut-finish',
  name: 'Haircut & finish',
  skill: 'cut',
  requiredLevel: 1,
  durationMin: 45,
  resourceType: 'styling',
  claims: { preMin: 0, postMin: 0 },
  priceFils: 16_000,
};
const BLOW_DRY: Service = {
  ...HAIRCUT,
  id: 'blow-dry',
  name: 'Blow dry',
  durationMin: 30,
  resourceType: 'wash',
  priceFils: 9_000,
};
const CATALOGUE = new Map([HAIRCUT, BLOW_DRY].map((s) => [s.id, s]));

const offer = (
  variantId: string,
  priceMinor: number,
  available = 10,
): CatalogueProduct =>
  ({
    variantId,
    productName: variantId === POMADE ? 'Matte Pomade' : 'Kids Gel',
    variantName: '',
    priceMinor,
    currency: 'AED',
    tracked: true,
    available,
  }) as CatalogueProduct;

const self: MobileGroupMemberCommand = {
  ref: 0,
  kind: 'self',
  id: BOOKER,
  name: 'Sarah',
  ageGroup: 'adult',
  services: [{ id: 'haircut-finish', amount: 160 }],
  products: [],
  stylistId: 'maya',
};
const rana: MobileGroupMemberCommand = {
  ref: 1,
  kind: 'registered',
  id: RANA,
  name: 'Rana Hassan',
  ageGroup: 'adult',
  services: [{ id: 'haircut-finish', amount: 160 }],
  products: [],
  stylistId: null,
};
const liam: MobileGroupMemberCommand = {
  ref: 2,
  kind: 'guest',
  id: null,
  name: 'Liam (8 yrs)',
  ageGroup: 'child',
  services: [{ id: 'haircut-finish', amount: 80 }],
  products: [],
  stylistId: null,
};

/** 160 + 160 + 80 (the child's half) = 400 net, 20 VAT, 420, deposit 84. */
function command(
  over: Partial<MobileGroupBookingCommand> = {},
): MobileGroupBookingCommand {
  return {
    salonId: 'marina-walk',
    startTime: START,
    members: [self, rana, liam],
    amountWithoutTax: 400,
    taxAmount: 20,
    discount: 0,
    promoCode: null,
    total: 420,
    depositPercent: 20,
    advancePaidAmount: 0,
    dueAmount: 420,
    paymentStatus: 'DRAFT',
    status: 'BOOKED',
    bookingType: 'GROUP',
    customerId: BOOKER,
    heldDepositPercent: 20,
    ...over,
  };
}

const HELD = {
  groupId: GROUP,
  holdId: HOLD,
  expiresAt: '2026-10-11T03:15:00.000Z',
  expiresInSeconds: 900,
  mode: 'TOGETHER',
  lanes: [
    { label: 'Sarah', staffId: 'maya', start: '15:00', end: '15:45' },
    { label: 'Rana Hassan', staffId: 'anya', start: '15:00', end: '15:45' },
    { label: 'Liam (8 yrs)', staffId: 'lina', start: '15:00', end: '15:45' },
  ],
};

const CONFIRMED = {
  kind: 'confirmed' as const,
  groupId: GROUP,
  lanes: [0, 1, 2].map((i) => ({
    position: i,
    participantId: `part-${i}`,
    bookingId: `booking-${i}`,
    code: `GS-${1001 + i}`,
  })),
};

function harness(
  over: {
    readonly productsOn?: boolean;
    readonly offers?: CatalogueProduct[];
    readonly hold?: () => Promise<unknown>;
    readonly confirm?: () => Promise<unknown>;
    readonly afterCreate?: () => Promise<unknown>;
  } = {},
) {
  const holds = {
    execute: vi.fn(over.hold ?? (() => Promise.resolve(HELD))),
    release: vi.fn(() => Promise.resolve({ released: true })),
  };
  const confirms = {
    confirm: vi.fn(over.confirm ?? (() => Promise.resolve(CONFIRMED))),
  };
  const reads = {
    afterCreate: vi.fn(
      over.afterCreate ?? (() => Promise.resolve({ id: GROUP })),
    ),
  };
  const lifecycle = {
    transition: vi.fn(() => Promise.resolve({ kind: 'transitioned' })),
  };
  const context = {
    loadServices: vi.fn((_b: string, ids: readonly string[]) =>
      Promise.resolve(
        ids.flatMap((id) => (CATALOGUE.has(id) ? [CATALOGUE.get(id)!] : [])),
      ),
    ),
  };
  const productCatalogue = {
    enabled: () => over.productsOn ?? false,
    resolve: vi.fn(() =>
      Promise.resolve(
        new Map((over.offers ?? []).map((o) => [o.variantId, o])),
      ),
    ),
  };
  const handler = new MobileGroupBookingHandler(
    holds as never,
    confirms as never,
    reads as never,
    lifecycle as never,
    context as never,
    productCatalogue as never,
  );
  const confirmInput = (): MobileGroupConfirmInput =>
    (confirms.confirm.mock.calls[0] as unknown as [MobileGroupConfirmInput])[0];
  return {
    handler,
    holds,
    confirms,
    reads,
    lifecycle,
    context,
    productCatalogue,
    confirmInput,
  };
}

async function refusal(p: Promise<unknown>): Promise<MobileContractError> {
  try {
    await p;
  } catch (e) {
    if (isMobileContractError(e)) return e;
    throw e;
  }
  throw new Error('expected a refusal');
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('MobileGroupBookingHandler: a good party', () => {
  it('holds everyone together, the booker paying, and answers with the read', async () => {
    const h = harness();
    const out = await h.handler.execute(command());

    expect(out).toEqual({ id: GROUP });
    expect(h.holds.execute).toHaveBeenCalledWith({
      branchId: 'marina-walk',
      organiserId: BOOKER,
      tradingDay: '2026-10-11',
      targetMin: 900,
      mode: 'arrive_together',
      arrangement: 'organiser_pays_all',
      participants: [
        {
          label: 'Sarah',
          serviceIds: ['haircut-finish'],
          customerId: BOOKER,
          guestName: null,
          preferredStaffId: 'maya',
        },
        {
          label: 'Rana Hassan',
          serviceIds: ['haircut-finish'],
          customerId: RANA,
          guestName: null,
          preferredStaffId: null,
        },
        {
          label: 'Liam (8 yrs)',
          serviceIds: ['haircut-finish'],
          customerId: null,
          guestName: 'Liam (8 yrs)',
          preferredStaffId: null,
        },
      ],
    });
    expect(h.reads.afterCreate).toHaveBeenCalledWith(
      GROUP,
      new Map([
        [0, 'Sarah'],
        [1, 'Rana Hassan'],
        [2, 'Liam (8 yrs)'],
      ]),
    );
  });

  it('confirms each member on the stylist the hold gave them, at the child price', async () => {
    const h = harness();
    await h.handler.execute(command());
    const input = h.confirmInput();

    expect(
      input.lanes.map((l) => [
        l.position,
        l.clientRef,
        l.staffId,
        l.customerId,
      ]),
    ).toEqual([
      [0, 0, 'maya', BOOKER],
      [1, 1, 'anya', RANA],
      [2, 2, 'lina', null],
    ]);
    expect(input.lanes[2]).toMatchObject({
      ageGroup: 'child',
      startMin: 900,
      endMin: 945,
      resourceType: 'styling',
      servicesNetFils: 8_000,
      servicesVatFils: 400,
      depositFils: 1_680,
      totalFils: 8_400,
    });
    expect(input.lanes[2]!.items[0]).toMatchObject({
      serviceId: 'haircut-finish',
      priceFils: 8_000,
    });
    expect(input).toMatchObject({
      depositPercent: 20,
      organiserId: BOOKER,
      tradingDay: '2026-10-11',
    });
  });

  it('keeps each member services in the order picked, chair from the last one', async () => {
    const h = harness();
    await h.handler.execute(
      command({
        members: [
          {
            ...self,
            services: [
              { id: 'haircut-finish', amount: 160 },
              { id: 'blow-dry', amount: 90 },
            ],
          },
          rana,
          liam,
        ],
        amountWithoutTax: 490,
        taxAmount: 24.5,
        total: 514.5,
        dueAmount: 514.5,
      }),
    );
    const booker = h.confirmInput().lanes[0]!;
    expect(booker.items.map((i) => i.serviceId)).toEqual([
      'haircut-finish',
      'blow-dry',
    ]);
    expect(booker.endMin).toBe(900 + 75);
    expect(booker.resourceType).toBe('wash');
  });
});

describe('MobileGroupBookingHandler: refused before anything is held', () => {
  it('a party with no self', async () => {
    const h = harness();
    const e = await refusal(
      h.handler.execute(command({ members: [rana, liam] })),
    );
    expect(e.errors[0]!.code).toBe('invalid_member_kind');
    expect(h.context.loadServices).not.toHaveBeenCalled();
    expect(h.holds.execute).not.toHaveBeenCalled();
  });

  it('a start that is not an instant', async () => {
    const h = harness();
    const e = await refusal(
      h.handler.execute(command({ startTime: 'tomorrow' })),
    );
    expect(e.errors[0]).toMatchObject({
      field: 'start_time',
      code: 'invalid_window',
    });
  });

  it('a service the salon does not sell, naming the member', async () => {
    const h = harness();
    const e = await refusal(
      h.handler.execute(
        command({
          members: [
            self,
            { ...rana, services: [{ id: 'unicorn', amount: 1 }] },
            liam,
          ],
        }),
      ),
    );
    expect(e.errors[0]).toMatchObject({
      field: 'members[1].services',
      code: 'unknown_service',
    });
    expect(h.holds.execute).not.toHaveBeenCalled();
  });

  it('a party that would run past the hours taken online', async () => {
    const h = harness();
    const e = await refusal(
      h.handler.execute(command({ startTime: '2026-10-11T21:30:00+06:00' })),
    );
    expect(e.errors[0]).toMatchObject({
      field: 'start_time',
      code: 'invalid_window',
    });
  });

  it('figures that ignore the child price, carrying the right one', async () => {
    const h = harness();
    const e = await refusal(
      h.handler.execute(
        command({
          amountWithoutTax: 480,
          taxAmount: 24,
          total: 504,
          dueAmount: 504,
        }),
      ),
    );
    expect(e.errors[0]).toMatchObject({
      field: 'amount_without_tax',
      code: 'amount_mismatch',
      expected: 400,
    });
    expect(h.holds.execute).not.toHaveBeenCalled();
  });

  it("a deposit percent that is not the server's (D1)", async () => {
    const h = harness();
    const e = await refusal(h.handler.execute(command({ depositPercent: 30 })));
    expect(e.errors[0]).toMatchObject({
      field: 'deposit_percent',
      expected: 20,
    });
  });

  it('a start that has already passed', async () => {
    const h = harness();
    const e = await refusal(
      h.handler.execute(command({ startTime: '2026-10-11T08:30:00+06:00' })),
    );
    expect(e.errors[0]).toMatchObject({
      field: 'start_time',
      code: 'invalid_window',
    });
    expect(h.context.loadServices).not.toHaveBeenCalled();
  });

  it('takes a start only ninety minutes away: nothing is paid online, so no window closes', async () => {
    const h = harness();
    await h.handler.execute(
      command({ startTime: '2026-10-11T10:30:00+06:00' }),
    );
    expect(h.holds.execute).toHaveBeenCalledOnce();
  });
});

describe('MobileGroupBookingHandler: products', () => {
  const withPomade = (): MobileGroupBookingCommand =>
    command({
      members: [
        { ...self, products: [{ id: POMADE, amount: 25, quantity: 1 }] },
        rana,
        liam,
      ],
      amountWithoutTax: 425,
      taxAmount: 21.25,
      total: 446.25,
      dueAmount: 446.25,
    });

  it('are refused, never dropped, while PRODUCTS_FROM_PLATFORM is off', async () => {
    const h = harness({ productsOn: false });
    const e = await refusal(h.handler.execute(withPomade()));
    expect(e.errors[0]).toMatchObject({
      field: 'members[0].products',
      code: 'products_not_supported',
    });
    expect(h.holds.execute).not.toHaveBeenCalled();
  });

  it('are priced from platform and stored against their member', async () => {
    const h = harness({ productsOn: true, offers: [offer(POMADE, 2_500)] });
    await h.handler.execute(withPomade());
    const booker = h.confirmInput().lanes[0]!;
    expect(booker.products).toEqual([
      {
        productId: POMADE,
        productName: 'Matte Pomade',
        priceFils: 2_500,
        quantity: 1,
      },
    ]);
    // The booker's VAT share covers the pomade too; the row keeps the
    // services' part, as a single booking row does.
    expect(booker.totalFils).toBe(16_000 + 2_500 + 925);
    expect(booker.servicesVatFils).toBe(925 - 125);
  });

  it('are checked in one call, so two members cannot both buy the last one', async () => {
    const h = harness({ productsOn: true, offers: [offer(GEL, 1_500, 1)] });
    const e = await refusal(
      h.handler.execute(
        command({
          members: [
            { ...self, products: [{ id: GEL, amount: 15, quantity: 1 }] },
            rana,
            { ...liam, products: [{ id: GEL, amount: 15, quantity: 1 }] },
          ],
          amountWithoutTax: 430,
          taxAmount: 21.5,
          total: 451.5,
          dueAmount: 451.5,
        }),
      ),
    );
    expect(h.productCatalogue.resolve).toHaveBeenCalledTimes(1);
    expect(e.errors.map((x) => [x.field, x.code])).toEqual([
      ['members[0].products[0].quantity', 'out_of_stock'],
      ['members[2].products[0].quantity', 'out_of_stock'],
    ]);
  });

  it('name the member and line when a price moved', async () => {
    const h = harness({ productsOn: true, offers: [offer(POMADE, 3_000)] });
    const e = await refusal(h.handler.execute(withPomade()));
    expect(e.errors[0]).toMatchObject({
      field: 'members[0].products[0].amount',
      code: 'amount_mismatch',
      expected: 30,
    });
  });
});

describe('MobileGroupBookingHandler: after the hold', () => {
  it("a party that does not fit is slot_taken, with the planner's own sentence", async () => {
    const h = harness({
      hold: () =>
        Promise.reject(
          new ConflictException('Only 2 professionals can cover this party.'),
        ),
    });
    const e = await refusal(h.handler.execute(command()));
    expect(e.status).toBe(409);
    expect(e.errors[0]).toMatchObject({
      code: 'slot_taken',
      message: 'Only 2 professionals can cover this party.',
    });
    expect(h.confirms.confirm).not.toHaveBeenCalled();
  });

  it('a hold that lapsed before confirm gives the hold back and is slot_taken', async () => {
    const h = harness({
      confirm: () => Promise.resolve({ kind: 'hold_expired' }),
    });
    const e = await refusal(h.handler.execute(command()));
    expect(e.status).toBe(409);
    expect(h.holds.release).toHaveBeenCalledWith(HOLD);
  });

  it('a confirm that throws gives the hold back and says why', async () => {
    const h = harness({ confirm: () => Promise.reject(new Error('db down')) });
    await expect(h.handler.execute(command())).rejects.toThrow('db down');
    expect(h.holds.release).toHaveBeenCalledWith(HOLD);
  });

  it('a party booked but unreadable is expired, never left holding the time', async () => {
    const h = harness({
      afterCreate: () => Promise.reject(new Error('read failed')),
    });
    await expect(h.handler.execute(command())).rejects.toThrow('read failed');
    expect(
      h.lifecycle.transition.mock.calls.map((c) => (c as unknown[])[0]),
    ).toEqual(
      [0, 1, 2].map((i): unknown =>
        expect.objectContaining({
          bookingId: `booking-${i}`,
          to: 'expired',
          actor: 'system',
        }),
      ),
    );
  });
});

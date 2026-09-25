import { describe, expect, it, vi } from 'vitest';
import {
  MobileGroupReadHandler,
  type GroupReader,
} from './mobile-group-read.handler';
import { isMobileContractError } from '@application/commands/mobile-booking.error';
import { TenantContext } from '@infrastructure/tenancy/tenant-context';
import { toUuid } from '@infrastructure/persistence/hold.repository';

const GROUP = 'aaaaaaaa-0000-4aaa-8aaa-aaaaaaaaaaaa';
const BOOKER = '11111111-1111-4111-8111-111111111111';
const RANA = '22222222-2222-4222-8222-222222222222';
const STRANGER = '33333333-3333-4333-8333-333333333333';
const POMADE = 'cccccccc-3333-4ccc-8ccc-cccccccccccc';
const DAY = new Date('2026-10-11T00:00:00Z');

const participant = (
  position: number,
  customerId: string | null,
  extra = {},
) => ({
  id: `part-${position}`,
  groupId: GROUP,
  customerId,
  guestName: null as string | null,
  bookingId: `booking-${position}`,
  shareFils: null,
  position,
  ageGroup: 'adult',
  clientRef: position,
  createdAt: DAY,
  ...extra,
});

const lane = (i: number, over: Record<string, unknown> = {}) => ({
  id: `booking-${i}`,
  code: `GS-${1001 + i}`,
  status: 'confirmed',
  paymentStatus: 'none_required',
  tradingDay: DAY,
  startMinute: 900,
  durationMin: 45,
  netFils: 16_000,
  taxFils: 800,
  discountFils: 0,
  depositFils: 3_360,
  promoCode: null as string | null,
  linkExpiresAt: null as Date | null,
  items: [
    {
      serviceId: toUuid('haircut-finish'),
      serviceName: 'Haircut & finish',
      priceFils: 16_000,
      staffId: toUuid(['maya', 'anya', 'lina'][i]!),
    },
  ],
  products: [] as unknown[],
  ledger: [] as unknown[],
  ...over,
});

function group(over: Record<string, unknown> = {}) {
  return {
    id: GROUP,
    tenantId: null,
    branchId: toUuid('marina-walk'),
    organiserId: BOOKER,
    tradingDay: DAY,
    source: 'mobile',
    depositPercent: 20,
    createdAt: new Date('2026-10-11T03:00:00Z'),
    participants: [
      participant(0, BOOKER),
      participant(1, RANA),
      participant(2, null, {
        guestName: 'Liam (8 yrs)',
        ageGroup: 'child',
        clientRef: 7,
      }),
    ],
    ...over,
  };
}

const LANES = [
  lane(0, {
    promoCode: 'WELCOME',
    // The booker's VAT share is 9.25; the pomade's own VAT is 1.25 of it.
    depositFils: 3_885,
    products: [
      {
        productId: POMADE,
        productName: 'Matte Pomade',
        priceFils: 2_500,
        quantity: 1,
      },
    ],
  }),
  lane(1),
  lane(2, {
    netFils: 8_000,
    taxFils: 400,
    depositFils: 1_680,
    items: [
      {
        serviceId: toUuid('haircut-finish'),
        serviceName: 'Haircut & finish',
        priceFils: 8_000,
        staffId: toUuid('lina'),
      },
    ],
  }),
];

function harness(
  over: {
    group?: unknown;
    lanes?: unknown[];
    rosterFails?: boolean;
    /** The My Bookings lookup: which page rows are party lanes. */
    laneGroups?: { id: string; groupId: string }[];
  } = {},
) {
  const prisma = {
    bookingGroup: {
      findUnique: vi.fn(() =>
        Promise.resolve(over.group === undefined ? group() : over.group),
      ),
    },
    booking: {
      findMany: vi.fn((args: { where: { groupId?: unknown } }) =>
        Promise.resolve(
          args.where.groupId !== undefined
            ? (over.laneGroups ?? [])
            : (over.lanes ?? LANES),
        ),
      ),
    },
  };
  const context = {
    loadDay: vi.fn(() =>
      over.rosterFails === true
        ? Promise.reject(new Error('platform down'))
        : Promise.resolve({
            professionals: [
              { id: 'maya', name: 'Maya E.' },
              { id: 'anya', name: 'Anya' },
              { id: 'lina', name: 'Lina' },
            ],
          }),
    ),
    loadCatalogue: vi.fn(() => Promise.resolve([{ id: 'haircut-finish' }])),
  };
  const handler = new MobileGroupReadHandler(
    prisma as never,
    new TenantContext(),
    context as never,
  );
  return { handler, prisma, context };
}

const customer = (id: string): GroupReader => ({
  actorId: id,
  actorKind: 'customer',
  actorBranchId: null,
});

async function notFound(p: Promise<unknown>): Promise<void> {
  try {
    await p;
  } catch (e) {
    expect(isMobileContractError(e) && e.status).toBe(404);
    return;
  }
  throw new Error('expected a 404');
}

describe('MobileGroupReadHandler: who may read (D3)', () => {
  it('the booker', async () => {
    await expect(
      harness().handler.read(GROUP, customer(BOOKER)),
    ).resolves.toBeDefined();
  });

  it('a registered member of the party', async () => {
    await expect(
      harness().handler.read(GROUP, customer(RANA)),
    ).resolves.toBeDefined();
  });

  it('staff of the salon, and an owner scoped to every branch', async () => {
    const h = harness();
    await expect(
      h.handler.read(GROUP, {
        actorId: 'x',
        actorKind: 'staff',
        actorBranchId: 'marina-walk',
      }),
    ).resolves.toBeDefined();
    await expect(
      h.handler.read(GROUP, {
        actorId: 'x',
        actorKind: 'staff',
        actorBranchId: null,
      }),
    ).resolves.toBeDefined();
  });

  it('anyone else is 404, never 403', async () => {
    await notFound(harness().handler.read(GROUP, customer(STRANGER)));
    await notFound(
      harness().handler.read(GROUP, {
        actorId: 'x',
        actorKind: 'staff',
        actorBranchId: 'elsewhere',
      }),
    );
  });

  it('a malformed id is 404 without a query', async () => {
    const h = harness();
    await notFound(h.handler.read('not-a-uuid', customer(BOOKER)));
    expect(h.prisma.bookingGroup.findUnique).not.toHaveBeenCalled();
  });

  it('no such group is 404', async () => {
    await notFound(
      harness({ group: null }).handler.read(GROUP, customer(BOOKER)),
    );
  });

  it("a party the desk made is 404: this route answers for the app's parties only", async () => {
    await notFound(
      harness({ group: group({ source: null }) }).handler.read(
        GROUP,
        customer(BOOKER),
      ),
    );
  });
});

describe('MobileGroupReadHandler: the one booking the app sees (§6)', () => {
  it('reads as a group booking paid at the salon, with one pass and no window', async () => {
    const v = await harness().handler.read(GROUP, customer(BOOKER));
    expect(v).toMatchObject({
      id: GROUP,
      salon_id: 'marina-walk',
      booking_type: 'GROUP',
      status: 'CONFIRMED_BY_SALON',
      status_detail: 'CONFIRMED',
      payment_status: 'PAY_AFTER_CHECK_IN',
      date: '2026-10-11',
      start_time: '2026-10-11T15:00:00+06:00',
      end_time: '2026-10-11T15:45:00+06:00',
      member_count: 3,
      promo_code: 'WELCOME',
      pass_qr_code: 'GS-1001',
      expires_at: null,
      created_at: '2026-10-11T09:00:00+06:00',
    });
  });

  it('adds the members back up, products included', async () => {
    const v = await harness().handler.read(GROUP, customer(BOOKER));
    // Services 160 + 160 + 80, pomade 25: 425 net. VAT 21.25. 446.25.
    expect(v.amount_without_tax).toBe(425);
    expect(v.tax_amount).toBe(21.25);
    expect(v.discount).toBe(0);
    expect(v.total).toBe(446.25);
    expect(v.deposit_percent).toBe(20);
    expect(v.deposit_amount).toBe(89.25);
    expect(v.advance_paid_amount).toBe(0);
    expect(v.due_amount).toBe(446.25);
    expect(v.members.map((m) => m.total)).toEqual([194.25, 168, 84]);
  });

  it('gives every member their own id, kind, stylist and time', async () => {
    const v = await harness().handler.read(GROUP, customer(BOOKER));
    expect(
      v.members.map((m) => [m.ref, m.id, m.kind, m.user_id, m.age_group]),
    ).toEqual([
      [0, 'part-0', 'self', BOOKER, 'adult'],
      [1, 'part-1', 'registered', RANA, 'adult'],
      [7, 'part-2', 'guest', null, 'child'],
    ]);
    expect(v.members[0]).toMatchObject({
      booking_code: 'GS-1001',
      status: 'CONFIRMED_BY_SALON',
      services: [
        { id: 'haircut-finish', name: 'Haircut & finish', amount: 160 },
      ],
      products: [{ id: POMADE, name: 'Matte Pomade', amount: 25, quantity: 1 }],
      stylist: { id: 'maya', name: 'Maya E.' },
      start_time: '2026-10-11T15:00:00+06:00',
      end_time: '2026-10-11T15:45:00+06:00',
    });
    expect(v.members[2]!.services[0]!.amount).toBe(80);
  });

  it("names a guest from the row, and leaves an account's name to the caller", async () => {
    const v = await harness().handler.read(GROUP, customer(BOOKER));
    expect(v.members.map((m) => m.name)).toEqual([null, null, 'Liam (8 yrs)']);
  });

  it('after a create, uses the names the app sent', async () => {
    const v = await harness().handler.afterCreate(
      GROUP,
      new Map([
        [0, 'Sarah'],
        [1, 'Rana'],
      ]),
    );
    expect(v.members.map((m) => m.name)).toEqual([
      'Sarah',
      'Rana',
      'Liam (8 yrs)',
    ]);
  });

  it('counts money the desk took, across every member', async () => {
    const paid = LANES.map((l, i) => ({
      ...l,
      paymentStatus: 'deposit_paid',
      status: 'confirmed',
      linkExpiresAt: null,
      ledger: [
        {
          entryType: 'captured',
          amountFils: [3_885, 3_360, 1_680][i],
          rail: 'card',
          createdAt: DAY,
        },
      ],
    }));
    const v = await harness({ lanes: paid }).handler.read(
      GROUP,
      customer(BOOKER),
    );
    expect(v).toMatchObject({
      status: 'CONFIRMED_BY_SALON',
      payment_status: 'PARTIALLY',
      advance_paid_amount: 89.25,
      due_amount: 357,
      payment_method: 'CARD',
      expires_at: null,
    });
  });

  it('still reads when the roster cannot be reached, without stylist names', async () => {
    const v = await harness({ rosterFails: true }).handler.read(
      GROUP,
      customer(BOOKER),
    );
    expect(v.members[0]!.stylist).toEqual({ id: toUuid('maya'), name: null });
    expect(v.total).toBe(446.25);
  });
});

describe('MobileGroupReadHandler: My Bookings shows a party as one GROUP row', () => {
  const SINGLE = {
    id: 'eeeeeeee-5555-4eee-8eee-eeeeeeeeeeee',
    booking_type: 'SINGLE',
    total: 168,
  };
  const page = (rows: unknown[]) => ({
    count: rows.length,
    page: 1,
    page_size: 20,
    counts: { upcoming: rows.length, recurring: 0, archive: 0 },
    results: rows,
  });
  const LANE_ROW = {
    id: 'bbbbbbbb-0000-4bbb-8bbb-000000000000',
    booking_type: 'SINGLE',
    total: 194.25,
  };

  it("swaps the member's own row for the party, and leaves every other row alone", async () => {
    const h = harness({ laneGroups: [{ id: LANE_ROW.id, groupId: GROUP }] });
    const out = (await h.handler.decorateList(
      page([LANE_ROW, SINGLE]),
    )) as ReturnType<typeof page>;

    expect(out.results[1]).toBe(SINGLE);
    expect(out.results[0]).toEqual({
      id: GROUP,
      salon_id: 'marina-walk',
      status: 'CONFIRMED_BY_SALON',
      payment_status: 'PAY_AFTER_CHECK_IN',
      booking_type: 'GROUP',
      member_count: 3,
      date: '2026-10-11',
      start_time: '2026-10-11T15:00:00+06:00',
      end_time: '2026-10-11T15:45:00+06:00',
      services: [
        { id: 'haircut-finish', name: 'Haircut & finish' },
        { id: 'haircut-finish', name: 'Haircut & finish' },
        { id: 'haircut-finish', name: 'Haircut & finish' },
      ],
      stylists: [
        { id: 'maya', name: 'Maya E.', avatar_url: null },
        { id: 'anya', name: 'Anya', avatar_url: null },
        { id: 'lina', name: 'Lina', avatar_url: null },
      ],
      total: 446.25,
      due_amount: 446.25,
      created_at: '2026-10-11T09:00:00+06:00',
    });
  });

  it('keeps the count and the badges the list worked out', async () => {
    const h = harness({ laneGroups: [{ id: LANE_ROW.id, groupId: GROUP }] });
    const before = page([LANE_ROW, SINGLE]);
    const out = (await h.handler.decorateList(before)) as ReturnType<
      typeof page
    >;
    expect(out.count).toBe(2);
    expect(out.counts).toEqual(before.counts);
  });

  it('leaves the lane of a party the desk made exactly as it was', async () => {
    const h = harness({
      laneGroups: [{ id: LANE_ROW.id, groupId: GROUP }],
      group: group({ source: null }),
    });
    const out = (await h.handler.decorateList(page([LANE_ROW]))) as ReturnType<
      typeof page
    >;
    expect(out.results[0]).toBe(LANE_ROW);
  });

  it('returns the same page, untouched, when no row is in a party', async () => {
    const h = harness();
    const before = page([SINGLE]);
    expect(await h.handler.decorateList(before)).toBe(before);
    expect(h.prisma.bookingGroup.findUnique).not.toHaveBeenCalled();
  });

  it('passes through anything that is not a page', async () => {
    const h = harness();
    expect(await h.handler.decorateList(null)).toBeNull();
    expect(await h.handler.decorateList({ nope: 1 })).toEqual({ nope: 1 });
  });
});

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
    /** check_in_request rows, in the order they were written. */
    requests?: Req[];
  } = {},
) {
  const prisma = {
    // Honours only what was asked: the lane filter, the order (raised_at
    // then id, both descending) and the columns. Without an orderBy the rows
    // come back oldest first, as written, so a read that forgot to ask for
    // the latest gets the wrong one.
    checkInRequest: {
      findMany: vi.fn(
        (args: {
          where: { bookingId: { in: string[] } };
          orderBy?: unknown;
          select: Record<string, boolean>;
        }) => {
          const rows = (over.requests ?? []).filter((r) =>
            args.where.bookingId.in.includes(r.bookingId),
          );
          const ordered =
            args.orderBy === undefined
              ? rows
              : [...rows].sort(
                  (a, b) =>
                    b.raisedAt.getTime() - a.raisedAt.getTime() ||
                    b.id.localeCompare(a.id),
                );
          return Promise.resolve(
            ordered.map((r) =>
              Object.fromEntries(
                Object.keys(args.select).map((k) => [
                  k,
                  (r as unknown as Record<string, unknown>)[k],
                ]),
              ),
            ),
          );
        },
      ),
    },
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

/** One check_in_request row, as Prisma names its columns. */
interface Req {
  readonly id: string;
  readonly bookingId: string;
  readonly raisedAt: Date;
  readonly chairId: string | null;
  readonly chairNumber: string | null;
  readonly chairZoneName: string | null;
}

const req = (
  id: string,
  bookingId: string,
  minute: number,
  chair: { id: string; number: string | null; zone: string | null } | null,
): Req => ({
  id,
  bookingId,
  raisedAt: new Date(Date.UTC(2026, 9, 11, 8, minute)),
  chairId: chair?.id ?? null,
  chairNumber: chair?.number ?? null,
  chairZoneName: chair?.zone ?? null,
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

describe('MobileGroupReadHandler: who is looking (MOBILE_GROUP_SELF_CHECK_IN)', () => {
  it('without a viewer, the party has exactly the keys it always had', async () => {
    const v = await harness().handler.read(GROUP, customer(RANA));
    expect(Object.keys(v)).toEqual([
      'id',
      'salon_id',
      'booking_type',
      'status',
      'status_detail',
      'payment_status',
      'payment_status_detail',
      'date',
      'start_time',
      'end_time',
      'member_count',
      'members',
      'amount_without_tax',
      'tax_amount',
      'discount',
      'promo_code',
      'total',
      'deposit_percent',
      'deposit_amount',
      'advance_paid_amount',
      'due_amount',
      'payment_method',
      'pass_qr_code',
      'expires_at',
      'created_at',
    ]);
    for (const m of v.members) {
      expect(Object.keys(m)).toEqual([
        'ref',
        'id',
        'booking_code',
        'user_id',
        'name',
        'kind',
        'age_group',
        'status',
        'services',
        'products',
        'stylist',
        'start_time',
        'end_time',
        'total',
      ]);
    }
  });

  it('flag off, no viewer: no member row has an is_me or booking_id key at all', async () => {
    const h = harness();
    const read = await h.handler.read(GROUP, customer(RANA));
    const made = await h.handler.afterCreate(GROUP, new Map());
    for (const m of [...read.members, ...made.members]) {
      expect(m).not.toHaveProperty('is_me');
      expect(m).not.toHaveProperty('booking_id');
    }
  });

  it("three members, exactly one true: the viewer's own row", async () => {
    const booker = await harness().handler.read(
      GROUP,
      customer(BOOKER),
      BOOKER,
    );
    expect(booker.members.map((m) => m.is_me)).toEqual([true, false, false]);

    const rana = await harness().handler.read(GROUP, customer(RANA), RANA);
    expect(rana.members.map((m) => m.is_me)).toEqual([false, true, false]);
  });

  it("booking_id: the viewer's own lane id on their row, null on every other", async () => {
    const booker = await harness().handler.read(
      GROUP,
      customer(BOOKER),
      BOOKER,
    );
    expect(booker.members.map((m) => m.booking_id)).toEqual([
      'booking-0',
      null,
      null,
    ]);

    const rana = await harness().handler.read(GROUP, customer(RANA), RANA);
    expect(rana.members.map((m) => m.booking_id)).toEqual([
      null,
      'booking-1',
      null,
    ]);
  });

  it('booking_id is the LANE booking id, never the participant id', async () => {
    const v = await harness().handler.read(GROUP, customer(RANA), RANA);
    const mine = v.members.find((m) => m.is_me === true)!;
    expect(mine.id).toBe('part-1');
    expect(mine.booking_id).toBe('booking-1');
    expect(mine.booking_id).not.toBe(mine.id);
  });

  it('a guest row is always false, and its booking_id null', async () => {
    for (const id of [BOOKER, RANA]) {
      const v = await harness().handler.read(GROUP, customer(id), id);
      const guests = v.members.filter((m) => m.kind === 'guest');
      expect(guests).toHaveLength(1);
      expect(guests.map((m) => m.is_me)).toEqual([false]);
      expect(guests.map((m) => m.booking_id)).toEqual([null]);
    }
  });

  it("a staff viewer: every row false, even with an id equal to a member's", async () => {
    const v = await harness().handler.read(
      GROUP,
      { actorId: BOOKER, actorKind: 'staff', actorBranchId: null },
      BOOKER,
    );
    expect(v.members.map((m) => m.is_me)).toEqual([false, false, false]);
    expect(v.members.map((m) => m.booking_id)).toEqual([null, null, null]);
  });

  it('is_me then booking_id go last, after the keys the row always had', async () => {
    const without = await harness().handler.read(GROUP, customer(RANA));
    const seen = await harness().handler.read(GROUP, customer(RANA), RANA);
    seen.members.forEach((m, i) => {
      expect(Object.keys(m)).toEqual([
        ...Object.keys(without.members[i]!),
        'is_me',
        'booking_id',
      ]);
    });
  });

  it('a viewer changes nothing else: every other key and value is the same', async () => {
    for (const id of [BOOKER, RANA]) {
      const without = await harness().handler.read(GROUP, customer(id));
      const seen = await harness().handler.read(GROUP, customer(id), id);
      expect({
        ...seen,
        members: seen.members.map(({ is_me: _, booking_id: __, ...m }) => m),
      }).toStrictEqual(without);
    }
  });
});

describe("MobileGroupReadHandler: each member's chair (MOBILE_GROUP_CHAIRS)", () => {
  const CHAIR_8 = { id: 'chair-8', number: '8', zone: 'Window section' };
  const CHAIR_5 = { id: 'chair-5', number: '5', zone: null };
  const CHAIR_3 = { id: 'chair-3', number: '3', zone: 'Back' };
  // The booker scanned chair 5, then chair 8 (the latest). Rana scanned
  // chair 3, then asked again with no chair (Wait for Staff). The guest's
  // lane never raised. Written oldest first.
  const REQUESTS = [
    req('req-1', 'booking-0', 1, CHAIR_5),
    req('req-2', 'booking-1', 2, CHAIR_3),
    req('req-3', 'booking-0', 3, CHAIR_8),
    req('req-4', 'booking-1', 4, null),
  ];
  const MEMBER_KEYS = [
    'ref',
    'id',
    'booking_code',
    'user_id',
    'name',
    'kind',
    'age_group',
    'status',
    'services',
    'products',
    'stylist',
    'start_time',
    'end_time',
    'total',
  ];

  it('off: every member row is exactly what it was, key for key, and no request is read', async () => {
    const h = harness({ requests: REQUESTS });
    for (const v of [
      await h.handler.read(GROUP, customer(RANA)),
      await h.handler.read(GROUP, customer(RANA), undefined, {}),
      await h.handler.read(GROUP, customer(RANA), undefined, {
        chairs: false,
      }),
    ]) {
      for (const m of v.members) expect(Object.keys(m)).toEqual(MEMBER_KEYS);
    }
    expect(h.prisma.checkInRequest.findMany).not.toHaveBeenCalled();
  });

  it("on: every row carries its lane's chair from the LATEST request, null when that request had none or there is none", async () => {
    const h = harness({ requests: REQUESTS });
    const v = await h.handler.read(GROUP, customer(RANA), undefined, {
      chairs: true,
    });
    expect(v.members.map((m) => m.chair)).toEqual([
      { number: '8', zone_name: 'Window section' },
      null,
      null,
    ]);
  });

  it('one query for the whole party, every lane at once, newest first', async () => {
    const h = harness({ requests: REQUESTS });
    await h.handler.read(GROUP, customer(RANA), undefined, { chairs: true });
    expect(h.prisma.checkInRequest.findMany).toHaveBeenCalledTimes(1);
    expect(h.prisma.checkInRequest.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { bookingId: { in: ['booking-0', 'booking-1', 'booking-2'] } },
        orderBy: [{ raisedAt: 'desc' }, { id: 'desc' }],
      }),
    );
  });

  it('a chair with no id is no chair, as the single check-in read has it', async () => {
    const h = harness({
      requests: [
        req('req-9', 'booking-1', 9, { id: '', number: '4', zone: null }),
      ].map((r) => ({ ...r, chairId: null })),
    });
    const v = await h.handler.read(GROUP, customer(RANA), undefined, {
      chairs: true,
    });
    expect(v.members.map((m) => m.chair)).toEqual([null, null, null]);
  });

  it('anyone who may read the party sees every chair: the booker, a member, staff', async () => {
    const seen = [];
    for (const who of [
      customer(BOOKER),
      customer(RANA),
      { actorId: STRANGER, actorKind: 'staff', actorBranchId: null },
    ]) {
      const v = await harness({ requests: REQUESTS }).handler.read(
        GROUP,
        who,
        undefined,
        { chairs: true },
      );
      seen.push(v.members.map((m) => m.chair));
    }
    expect(seen[1]).toEqual(seen[0]);
    expect(seen[2]).toEqual(seen[0]);
  });

  it('chair goes last, after is_me and booking_id, and changes nothing else', async () => {
    const without = await harness({ requests: REQUESTS }).handler.read(
      GROUP,
      customer(RANA),
      RANA,
    );
    const seen = await harness({ requests: REQUESTS }).handler.read(
      GROUP,
      customer(RANA),
      RANA,
      { chairs: true },
    );
    seen.members.forEach((m, i) => {
      expect(Object.keys(m)).toEqual([
        ...Object.keys(without.members[i]!),
        'chair',
      ]);
    });
    expect({
      ...seen,
      members: seen.members.map(({ chair: _, ...m }) => m),
    }).toStrictEqual(without);
  });

  it('the create and My Bookings never read a chair (the cancel reads with no extras, as the off test)', async () => {
    const h = harness({
      requests: REQUESTS,
      laneGroups: [
        { id: 'bbbbbbbb-0000-4bbb-8bbb-000000000000', groupId: GROUP },
      ],
    });
    const made = await h.handler.afterCreate(GROUP, new Map());
    for (const m of made.members) expect(m).not.toHaveProperty('chair');
    await h.handler.decorateList({
      results: [{ id: 'bbbbbbbb-0000-4bbb-8bbb-000000000000' }],
    });
    expect(h.prisma.checkInRequest.findMany).not.toHaveBeenCalled();
  });
});

describe("MobileGroupReadHandler: the party's status (MOBILE_GROUP_LIVE_STATUS)", () => {
  // The booker is checked in; Rana and the guest are still confirmed.
  const BOOKER_IN = [
    { ...LANES[0]!, status: 'checked_in' },
    LANES[1]!,
    LANES[2]!,
  ];
  const LANE_ROW = { id: 'bbbbbbbb-0000-4bbb-8bbb-000000000000' };
  const listed = async (lanes: unknown[], liveStatus?: boolean) => {
    const h = harness({
      lanes,
      laneGroups: [{ id: LANE_ROW.id, groupId: GROUP }],
    });
    const out = (await h.handler.decorateList(
      { results: [LANE_ROW] },
      undefined,
      liveStatus === undefined ? undefined : { liveStatus },
    )) as { results: { status: string }[] };
    return out.results[0]!;
  };

  it('off: the booker checked in, the party reads checked in, as before', async () => {
    const v = await harness({ lanes: BOOKER_IN }).handler.read(
      GROUP,
      customer(BOOKER),
    );
    expect([v.status, v.status_detail]).toEqual(['CHECKED_IN', 'CHECKED_IN']);
    expect((await listed(BOOKER_IN)).status).toBe('CHECKED_IN');
    expect((await listed(BOOKER_IN, false)).status).toBe('CHECKED_IN');
  });

  it('on: while any lane is still confirmed, the party read and the GROUP row say confirmed', async () => {
    const v = await harness({ lanes: BOOKER_IN }).handler.read(
      GROUP,
      customer(BOOKER),
      undefined,
      { liveStatus: true },
    );
    expect([v.status, v.status_detail]).toEqual([
      'CONFIRMED_BY_SALON',
      'CONFIRMED',
    ]);
    expect((await listed(BOOKER_IN, true)).status).toBe('CONFIRMED_BY_SALON');
  });

  it('on: once no lane is confirmed, it is the booker again', async () => {
    const allIn = LANES.map((l) => ({ ...l, status: 'checked_in' }));
    const v = await harness({ lanes: allIn }).handler.read(
      GROUP,
      customer(BOOKER),
      undefined,
      { liveStatus: true },
    );
    expect(v.status).toBe('CHECKED_IN');
    expect((await listed(allIn, true)).status).toBe('CHECKED_IN');
  });

  it('on: only the status moves; every member, the money and the pass stay as they were', async () => {
    const off = await harness({ lanes: BOOKER_IN }).handler.read(
      GROUP,
      customer(BOOKER),
    );
    const on = await harness({ lanes: BOOKER_IN }).handler.read(
      GROUP,
      customer(BOOKER),
      undefined,
      { liveStatus: true },
    );
    expect(on.members.map((m) => m.status)).toEqual([
      'CHECKED_IN',
      'CONFIRMED_BY_SALON',
      'CONFIRMED_BY_SALON',
    ]);
    expect({
      ...on,
      status: off.status,
      status_detail: off.status_detail,
    }).toStrictEqual(off);
  });

  it('on, a party all confirmed: nothing changes', async () => {
    const off = await harness().handler.read(GROUP, customer(BOOKER));
    const on = await harness().handler.read(
      GROUP,
      customer(BOOKER),
      undefined,
      { liveStatus: true },
    );
    expect(on).toStrictEqual(off);
  });
});

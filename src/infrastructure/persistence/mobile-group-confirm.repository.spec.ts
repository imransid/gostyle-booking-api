import { describe, expect, it } from 'vitest';
import {
  MobileGroupConfirmRepository,
  type MobileGroupConfirmInput,
  type MobileGroupLaneInput,
} from './mobile-group-confirm.repository';
import { TenantContext } from '../tenancy/tenant-context';
import { toUuid } from './hold.repository';

/**
 * REPOSITORY SPEC: what is written, with a fake transaction.
 *
 * The constraints and the wiring are proven live against Postgres
 * (prisma/proof-mobile-group.sql, CLAUDE.md 5). What a fake can pin is the
 * shape of every write, which is the whole point of this repository: each
 * member must land exactly as a single mobile DRAFT booking does, or the
 * desk sees something new.
 */

const GROUP = 'aaaaaaaa-0000-4aaa-8aaa-aaaaaaaaaaaa';
const HOLD = 'bbbbbbbb-0000-4bbb-8bbb-bbbbbbbbbbbb';
const BOOKER = '11111111-1111-4111-8111-111111111111';
const RANA = '22222222-2222-4222-8222-222222222222';
const POMADE = 'cccccccc-3333-4ccc-8ccc-cccccccccccc';

interface Call {
  readonly method: string;
  readonly arg: unknown;
}

interface Fixture {
  readonly holdAlive?: boolean;
  readonly groupStatus?: string;
  readonly groupSource?: string | null;
  /** Staff reservations the hold holds. Defaults to one per lane below. */
  readonly staff?: { id: string; staffId: string; startMinute: number }[];
}

const PARTICIPANTS = [
  { id: 'part-0', position: 0, customerId: BOOKER },
  { id: 'part-1', position: 1, customerId: RANA },
  { id: 'part-2', position: 2, customerId: null },
];

function fakeTx(over: Fixture = {}) {
  const calls: Call[] = [];
  const record = <T>(method: string, arg: unknown, result: T): Promise<T> => {
    calls.push({ method, arg });
    return Promise.resolve(result);
  };
  let codes = 1000;
  let bookings = 0;
  let items = 0;

  const tx = {
    $queryRaw: (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join('?');
      if (sql.includes('FROM hold')) {
        return record(
          'hold.probe',
          values,
          over.holdAlive === false ? [] : [{ id: HOLD }],
        );
      }
      if (sql.includes('booking_code_seq')) {
        codes += 1;
        return record('code.next', values, [{ code: `GS-${codes}` }]);
      }
      throw new Error(`unexpected $queryRaw: ${sql}`);
    },
    bookingGroup: {
      findUnique: (a: unknown) =>
        record('bookingGroup.findUnique', a, {
          status: over.groupStatus ?? 'draft',
          source: over.groupSource === undefined ? null : over.groupSource,
        }),
      update: (a: unknown) => record('bookingGroup.update', a, {}),
    },
    groupParticipant: {
      findMany: (a: unknown) =>
        record('groupParticipant.findMany', a, PARTICIPANTS),
      update: (a: unknown) => record('groupParticipant.update', a, {}),
    },
    staffReservation: {
      findMany: (a: unknown) =>
        record(
          'staffReservation.findMany',
          a,
          over.staff ?? [
            { id: 'sr-maya', staffId: toUuid('maya'), startMinute: 900 },
            { id: 'sr-anya', staffId: toUuid('anya'), startMinute: 900 },
            { id: 'sr-lina', staffId: toUuid('lina'), startMinute: 900 },
          ],
        ),
      update: (a: unknown) => record('staffReservation.update', a, {}),
    },
    resourceReservation: {
      findMany: (a: unknown) =>
        record('resourceReservation.findMany', a, [
          {
            id: 'rr-1',
            resourceType: 'styling',
            startMinute: 900,
            durationMin: 45,
          },
          {
            id: 'rr-2',
            resourceType: 'styling',
            startMinute: 900,
            durationMin: 45,
          },
          {
            id: 'rr-3',
            resourceType: 'styling',
            startMinute: 900,
            durationMin: 30,
          },
        ]),
      update: (a: unknown) => record('resourceReservation.update', a, {}),
    },
    booking: {
      create: (a: { data: { code: string } }) => {
        bookings += 1;
        return record('booking.create', a, {
          id: `booking-${bookings}`,
          code: a.data.code,
        });
      },
    },
    bookingItem: {
      create: (a: unknown) => {
        items += 1;
        return record('bookingItem.create', a, { id: `item-${items}` });
      },
    },
    bookingProduct: {
      createMany: (a: unknown) =>
        record('bookingProduct.createMany', a, { count: 1 }),
    },
    bookingStatusHistory: {
      create: (a: unknown) => record('bookingStatusHistory.create', a, {}),
    },
    eventOutbox: {
      create: (a: unknown) => record('eventOutbox.create', a, {}),
    },
    hold: {
      delete: (a: unknown) => record('hold.delete', a, {}),
    },
  };
  return { tx, calls };
}

function repositoryWith(over: Fixture = {}) {
  const { tx, calls } = fakeTx(over);
  const prisma = {
    $transaction: <T>(fn: (client: typeof tx) => Promise<T>): Promise<T> =>
      fn(tx),
  };
  const repository = new MobileGroupConfirmRepository(
    prisma as never,
    new TenantContext(),
  );
  const of = (method: string) =>
    calls
      .filter((c) => c.method === method)
      .map(
        (c) =>
          c.arg as {
            data: Record<string, unknown>;
            where: Record<string, unknown>;
          },
      );
  return { repository, calls, of };
}

const HAIRCUT = {
  serviceId: 'haircut-finish',
  serviceName: 'Haircut & finish',
  resourceType: 'styling',
  requiredSkill: 'cut',
  priceFils: 16_000,
  durationMin: 45,
  source: 'fixture' as const,
};

function lane(over: Partial<MobileGroupLaneInput>): MobileGroupLaneInput {
  return {
    position: 0,
    clientRef: 0,
    ageGroup: 'adult',
    customerId: BOOKER,
    staffId: 'maya',
    startMin: 900,
    endMin: 945,
    resourceType: 'styling',
    items: [HAIRCUT],
    products: [],
    servicesNetFils: 16_000,
    servicesVatFils: 800,
    depositFils: 3_360,
    totalFils: 16_800,
    ...over,
  };
}

const INPUT: MobileGroupConfirmInput = {
  groupId: GROUP,
  holdId: HOLD,
  branchId: 'marina-walk',
  tradingDay: '2026-10-11',
  organiserId: BOOKER,
  depositPercent: 20,
  promoCode: 'WELCOME',
  lanes: [
    lane({
      products: [
        {
          productId: POMADE,
          productName: 'Matte Pomade',
          priceFils: 2_500,
          quantity: 1,
        },
      ],
      servicesVatFils: 675,
      totalFils: 19_425,
    }),
    lane({ position: 1, clientRef: 1, customerId: RANA, staffId: 'anya' }),
    lane({
      position: 2,
      clientRef: 7,
      ageGroup: 'child',
      customerId: null,
      staffId: 'lina',
      endMin: 930,
      items: [{ ...HAIRCUT, priceFils: 8_000, durationMin: 30 }],
      servicesNetFils: 8_000,
      servicesVatFils: 400,
      depositFils: 1_680,
      totalFils: 8_400,
    }),
  ],
};

describe('MobileGroupConfirmRepository: every member as a single pay-at-salon booking', () => {
  it('writes one booking per member, confirmed and paid at the salon, with no window', async () => {
    const { repository, of } = repositoryWith();
    const out = await repository.confirm(INPUT);

    expect(out.kind).toBe('confirmed');
    const rows = of('booking.create').map((c) => c.data);
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row).toMatchObject({
        status: 'confirmed',
        paymentStatus: 'none_required',
        channel: 'online',
        groupId: GROUP,
        branchId: toUuid('marina-walk'),
        // The payment link sweeper takes only rows with a window: none here.
        linkExpiresAt: null,
        discountFils: 0,
        requirementSource: 'group deposit 20%',
      });
    }
  });

  it('stores the services alone on the row, as a single does, and the share on the participant', async () => {
    const { repository, of } = repositoryWith();
    await repository.confirm(INPUT);

    const booker = of('booking.create')[0]!.data;
    expect(booker).toMatchObject({
      priceFils: 16_000,
      netFils: 16_000,
      taxFils: 675,
      depositFils: 3_360,
    });
    expect(of('groupParticipant.update')[0]).toMatchObject({
      where: { id: 'part-0' },
      data: {
        bookingId: 'booking-1',
        shareFils: 19_425,
        ageGroup: 'adult',
        clientRef: 0,
      },
    });
  });

  it('files a guest under the group and an account under itself', async () => {
    const { repository, of } = repositoryWith();
    await repository.confirm(INPUT);

    const customers = of('booking.create').map((c) => c.data.customerId);
    expect(customers).toEqual([BOOKER, RANA, toUuid(GROUP)]);
  });

  it('echoes the promo code on the booker only, and applies nothing (D2)', async () => {
    const { repository, of } = repositoryWith();
    await repository.confirm(INPUT);

    expect(of('booking.create').map((c) => c.data.promoCode)).toEqual([
      'WELCOME',
      null,
      null,
    ]);
  });

  it('writes every service as its own item, at the child price, on the member stylist', async () => {
    const { repository, of } = repositoryWith();
    await repository.confirm({
      ...INPUT,
      lanes: [
        lane({
          items: [
            HAIRCUT,
            { ...HAIRCUT, serviceId: 'blow-dry', serviceName: 'Blow dry' },
          ],
        }),
        ...INPUT.lanes.slice(1),
      ],
    });

    const items = of('bookingItem.create').map((c) => c.data);
    expect(
      items.slice(0, 2).map((i) => [i.serviceId, i.position, i.staffId]),
    ).toEqual([
      [toUuid('haircut-finish'), 0, toUuid('maya')],
      [toUuid('blow-dry'), 1, toUuid('maya')],
    ]);
    expect(items.at(-1)).toMatchObject({
      priceFils: 8_000,
      staffId: toUuid('lina'),
    });
  });

  it('stores products against their member, the variant id NOT folded', async () => {
    const { repository, of } = repositoryWith();
    await repository.confirm(INPUT);

    const products = of('bookingProduct.createMany');
    expect(products).toHaveLength(1);
    expect(products[0]!.data).toEqual([
      {
        bookingId: 'booking-1',
        productId: POMADE,
        productName: 'Matte Pomade',
        priceFils: 2_500,
        quantity: 1,
        position: 0,
      },
    ]);
  });

  it("re-points each member's OWN reservations, by id, at their first item", async () => {
    const { repository, of } = repositoryWith();
    await repository.confirm(INPUT);

    expect(
      of('staffReservation.update').map((c) => [
        c.where.id,
        c.data.bookingItemId,
      ]),
    ).toEqual([
      ['sr-maya', 'item-1'],
      ['sr-anya', 'item-2'],
      ['sr-lina', 'item-3'],
    ]);
    // One chair each, matched by length: the child's 30-minute chair goes to
    // the child, not to whoever came first.
    expect(
      of('resourceReservation.update').map((c) => [
        c.where.id,
        c.data.bookingItemId,
      ]),
    ).toEqual([
      ['rr-1', 'item-1'],
      ['rr-2', 'item-2'],
      ['rr-3', 'item-3'],
    ]);
    for (const u of [
      ...of('staffReservation.update'),
      ...of('resourceReservation.update'),
    ]) {
      expect(u.data.holdId).toBeNull();
    }
  });

  it('writes history, the single booking event, marks the group mobile, and empties the hold', async () => {
    const { repository, of } = repositoryWith();
    await repository.confirm(INPUT);

    expect(of('bookingStatusHistory.create').map((c) => c.data)).toEqual(
      Array.from({ length: 3 }, (_, i): unknown =>
        expect.objectContaining({
          bookingId: `booking-${i + 1}`,
          fromStatus: 'held',
          toStatus: 'confirmed',
          actorKind: 'customer',
        }),
      ),
    );
    expect(
      of('eventOutbox.create').map(
        (c) => (c.data.payload as { rail: unknown }).rail,
      ),
    ).toEqual([null, null, null]);
    expect(of('eventOutbox.create').map((c) => c.data.eventType)).toEqual([
      'booking.confirmed',
      'booking.confirmed',
      'booking.confirmed',
    ]);
    expect(of('bookingGroup.update')[0]).toEqual({
      where: { id: GROUP },
      data: {
        source: 'mobile',
        depositPercent: 20,
        // The shared rule's word for a party whose members are all confirmed.
        status: 'confirmed',
        activeCount: 3,
      },
    });
    expect(of('hold.delete')[0]).toEqual({ where: { id: HOLD } });
  });

  it('answers with each member: position, participant id, booking and code', async () => {
    const { repository } = repositoryWith();
    const out = await repository.confirm(INPUT);
    if (out.kind !== 'confirmed') throw new Error('not confirmed');
    expect(out.lanes).toEqual([
      {
        position: 0,
        participantId: 'part-0',
        bookingId: 'booking-1',
        code: 'GS-1001',
      },
      {
        position: 1,
        participantId: 'part-1',
        bookingId: 'booking-2',
        code: 'GS-1002',
      },
      {
        position: 2,
        participantId: 'part-2',
        bookingId: 'booking-3',
        code: 'GS-1003',
      },
    ]);
  });
});

describe('MobileGroupConfirmRepository: refusals write nothing', () => {
  it('an expired hold', async () => {
    const { repository, of } = repositoryWith({ holdAlive: false });
    expect(await repository.confirm(INPUT)).toEqual({ kind: 'hold_expired' });
    expect(of('booking.create')).toHaveLength(0);
  });

  it('a group the desk already confirmed', async () => {
    const { repository, of } = repositoryWith({ groupStatus: 'confirmed' });
    expect(await repository.confirm(INPUT)).toEqual({ kind: 'hold_expired' });
    expect(of('booking.create')).toHaveLength(0);
  });

  it('a group already made mobile, by an earlier try of the same request', async () => {
    const { repository } = repositoryWith({ groupSource: 'mobile' });
    expect(await repository.confirm(INPUT)).toEqual({ kind: 'hold_expired' });
  });

  it('a member whose stylist reservation is not in the hold', async () => {
    const { repository } = repositoryWith({
      staff: [
        { id: 'sr-maya', staffId: toUuid('maya'), startMinute: 900 },
        { id: 'sr-anya', staffId: toUuid('anya'), startMinute: 900 },
      ],
    });
    // Thrown inside the transaction, so the members already written roll back.
    expect(await repository.confirm(INPUT)).toEqual({ kind: 'hold_expired' });
  });

  it('a party whose size does not match the hold', async () => {
    const { repository } = repositoryWith();
    expect(
      await repository.confirm({ ...INPUT, lanes: INPUT.lanes.slice(0, 2) }),
    ).toEqual({
      kind: 'hold_expired',
    });
  });
});

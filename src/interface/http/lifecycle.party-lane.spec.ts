import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger, NotFoundException } from '@nestjs/common';
import { LifecycleController } from './lifecycle.controller';
import { MobileGroupBookingController } from './mobile-group-booking.controller';
import { LifecycleHandler } from '@application/commands/lifecycle.handler';
import { MobileGroupCancelHandler } from '@application/commands/mobile-group-cancel.handler';
import { LifecycleRepository } from '@infrastructure/persistence/lifecycle.repository';
import {
  isBookingError,
  type BookingError,
} from '@application/contract/errors';
import type { Actor } from '../../auth/actor';

/**
 * ONE LANE OF AN APP PARTY on the single cancel and reschedule
 * (MOBILE_GROUP_LANE_GUARD). A party is cancelled together, by the booker,
 * on its own route; a customer may not take one lane out of it.
 *
 * Everything between the routes and the database is the real code: both
 * controllers, MobileGroupCancelHandler, LifecycleHandler and the real
 * LifecycleRepository.timingFor, which runs its own SQL against the fake.
 * Only Prisma is faked, plus the repository's `transition` (the write,
 * tested on its own) and the reschedule handler (the guard refuses before
 * it). The fake answers only the columns timingFor's query asks for, so a
 * column dropped from the SELECT or the join turns this red.
 *
 * Why the chain is real: the booker's party cancel goes through
 * LifecycleHandler once per lane, as a customer, and never through
 * LifecycleController. A guard put in the handler would break it, and test
 * 5 is the one that says so.
 */

const APP_PARTY = 'aaaaaaaa-0000-4aaa-8aaa-aaaaaaaaaaaa';
const DESK_PARTY = 'dddddddd-0000-4ddd-8ddd-dddddddddddd';
const BOOKER = '11111111-1111-4111-8111-111111111111';
const RANA = '22222222-2222-4222-8222-222222222222';
const STRANGER = '33333333-3333-4333-8333-333333333333';
const STAFF = '44444444-4444-4444-8444-444444444444';

const BOOKER_LANE = 'bbbbbbbb-0000-4bbb-8bbb-000000000000';
const RANA_LANE = 'bbbbbbbb-1111-4bbb-8bbb-111111111111';
const GUEST_LANE = 'bbbbbbbb-2222-4bbb-8bbb-222222222222';
const DESK_LANE = 'cccccccc-1111-4ccc-8ccc-111111111111';
const SOLO = 'eeeeeeee-1111-4eee-8eee-111111111111';

const START = Date.UTC(2026, 10, 3, 9, 0);

interface Row {
  readonly code: string;
  readonly customerId: string;
  readonly groupId: string | null;
  status: string;
}

const customer = (id: string) =>
  ({ id, kind: 'customer', branchId: null, tenantId: null }) as Actor;
const staff = {
  id: STAFF,
  kind: 'staff',
  branchId: null,
  tenantId: null,
} as Actor;

const CANCEL = { reason: 'Cancelled by the customer in the app.' };
const MOVE = {
  holdId: '99999999-9999-4999-8999-999999999999',
  day: '2026-11-04',
  reason: 'Rescheduled by the customer in the app.',
};

function harness() {
  // An app party (booker, Rana, a guest), a desk party with Rana in it, and
  // an ordinary booking of Rana's. A guest lane's customer is the group id,
  // as mobile-group-confirm.repository.ts writes it.
  const groups = new Map<
    string,
    { source: string | null; organiserId: string }
  >([
    [APP_PARTY, { source: 'mobile', organiserId: BOOKER }],
    [DESK_PARTY, { source: null, organiserId: RANA }],
  ]);
  const table = new Map<string, Row>([
    [
      BOOKER_LANE,
      {
        code: 'GS-2001',
        customerId: BOOKER,
        groupId: APP_PARTY,
        status: 'confirmed',
      },
    ],
    [
      RANA_LANE,
      {
        code: 'GS-2002',
        customerId: RANA,
        groupId: APP_PARTY,
        status: 'confirmed',
      },
    ],
    [
      GUEST_LANE,
      {
        code: 'GS-2003',
        customerId: APP_PARTY,
        groupId: APP_PARTY,
        status: 'confirmed',
      },
    ],
    [
      DESK_LANE,
      {
        code: 'GS-3001',
        customerId: RANA,
        groupId: DESK_PARTY,
        status: 'confirmed',
      },
    ],
    [
      SOLO,
      { code: 'GS-4001', customerId: RANA, groupId: null, status: 'confirmed' },
    ],
  ]);

  const prisma = {
    // timingFor's query. Answers only the columns it names; the group's
    // source only through the LEFT JOIN on booking_group.
    $queryRaw: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join('$');
      const row = table.get(String(values[0]));
      if (row === undefined) return Promise.resolve([]);
      const out: Record<string, unknown> = {};
      if (/\bb\.start_at\b/.test(sql)) out.start_at = new Date(START);
      if (/\bb\.customer_id\b/.test(sql)) out.customer_id = row.customerId;
      if (/\bb\.group_id\b/.test(sql)) out.group_id = row.groupId;
      if (
        /LEFT JOIN booking_group g ON g\.id = b\.group_id/.test(sql) &&
        /\bg\.source AS group_source\b/.test(sql)
      ) {
        out.group_source =
          row.groupId === null
            ? null
            : (groups.get(row.groupId)?.source ?? null);
      }
      return Promise.resolve([out]);
    }),
    // MobileGroupCancelHandler's two reads.
    bookingGroup: {
      findUnique: vi.fn(({ where }: { where: { id: string } }) => {
        const g = groups.get(where.id);
        return Promise.resolve(
          g === undefined
            ? null
            : {
                organiserId: g.organiserId,
                source: g.source,
                participants: [...table.entries()]
                  .filter(([, r]) => r.groupId === where.id)
                  .map(([id]) => ({ bookingId: id })),
              },
        );
      }),
    },
    booking: {
      findMany: vi.fn(({ where }: { where: { id: { in: string[] } } }) =>
        Promise.resolve(
          where.id.in.map((id) => ({
            id,
            code: table.get(id)!.code,
            status: table.get(id)!.status,
          })),
        ),
      ),
    },
  };

  const repo = new LifecycleRepository(prisma as never);
  const transition = vi
    .spyOn(repo, 'transition')
    .mockImplementation((input) => {
      const row = table.get(input.bookingId)!;
      const from = row.status;
      row.status = input.to;
      return Promise.resolve({
        kind: 'transitioned' as const,
        booking: {
          bookingId: input.bookingId,
          code: row.code,
          from: from as never,
          to: input.to,
          paymentStatus: 'unchanged' as const,
        },
        money: null,
      });
    });

  const lifecycle = new LifecycleHandler(repo, {} as never);
  const reschedules = {
    execute: vi.fn(() => Promise.resolve({ moved: true })),
  };
  const singles = new LifecycleController(
    lifecycle,
    reschedules as never,
    repo,
  );
  const reads = {
    read: vi.fn(() => Promise.resolve({ id: APP_PARTY, status: 'CANCELLED' })),
  };
  const parties = new MobileGroupBookingController(
    {} as never,
    reads as never,
    new MobileGroupCancelHandler(prisma as never, lifecycle, reads as never),
  );

  /** Every booking the write was asked to cancel, in order. */
  const cancelled = (): string[] =>
    transition.mock.calls
      .filter(([input]) => input.to === 'cancelled')
      .map(([input]) => input.bookingId);

  return { singles, parties, reschedules, transition, cancelled, prisma };
}

async function refusal(p: Promise<unknown>): Promise<BookingError> {
  try {
    await p;
  } catch (e) {
    if (isBookingError(e)) return e;
    throw e;
  }
  throw new Error('expected a refusal');
}

const saved = process.env.MOBILE_GROUP_LANE_GUARD;
beforeEach(() => {
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  if (saved === undefined) delete process.env.MOBILE_GROUP_LANE_GUARD;
  else process.env.MOBILE_GROUP_LANE_GUARD = saved;
});

describe('MOBILE_GROUP_LANE_GUARD on', () => {
  beforeEach(() => {
    process.env.MOBILE_GROUP_LANE_GUARD = 'true';
  });

  it('1. a member cancelling their own lane: 409 BOOKING_PARTY_LANE, nothing written', async () => {
    const h = harness();
    const e = await refusal(
      h.singles.cancel(RANA_LANE, CANCEL, customer(RANA)),
    );
    expect([e.code, e.status]).toEqual(['BOOKING_PARTY_LANE', 409]);
    expect(h.transition).not.toHaveBeenCalled();
  });

  it('2. a member moving their own lane: 409 BOOKING_PARTY_LANE, nothing moved', async () => {
    const h = harness();
    const e = await refusal(
      h.singles.reschedule(RANA_LANE, MOVE, customer(RANA)),
    );
    expect([e.code, e.status]).toEqual(['BOOKING_PARTY_LANE', 409]);
    expect(h.reschedules.execute).not.toHaveBeenCalled();
  });

  it('3. an ordinary booking with no group still cancels', async () => {
    const h = harness();
    const view = await h.singles.cancel(SOLO, CANCEL, customer(RANA));
    expect(view).toMatchObject({ bookingId: SOLO, to: 'CANCELLED' });
    expect(h.cancelled()).toEqual([SOLO]);
  });

  it('4. staff cancelling a party lane still works, with no lookup', async () => {
    const h = harness();
    const view = await h.singles.cancel(RANA_LANE, CANCEL, staff);
    expect(view).toMatchObject({ bookingId: RANA_LANE, to: 'CANCELLED' });
    expect(h.cancelled()).toEqual([RANA_LANE]);
    expect(h.prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('5. the booker’s party cancel still cancels every lane, through the real handlers', async () => {
    const h = harness();
    await h.parties.cancel(APP_PARTY, customer(BOOKER));
    expect(h.cancelled()).toEqual([BOOKER_LANE, RANA_LANE, GUEST_LANE]);
    expect(
      h.transition.mock.calls.every(([input]) => input.actor === 'customer'),
    ).toBe(true);
  });

  it('6. a DESK party lane still cancels for the customer', async () => {
    const h = harness();
    const view = await h.singles.cancel(DESK_LANE, CANCEL, customer(RANA));
    expect(view).toMatchObject({ bookingId: DESK_LANE, to: 'CANCELLED' });
    expect(h.cancelled()).toEqual([DESK_LANE]);
  });

  it('7. a DESK party lane still reschedules for the customer', async () => {
    const h = harness();
    await h.singles.reschedule(DESK_LANE, MOVE, customer(RANA));
    expect(h.reschedules.execute).toHaveBeenCalledWith(
      expect.objectContaining({ bookingId: DESK_LANE, actor: 'customer' }),
    );
  });

  it('the booker’s own lane on the single route is refused too', async () => {
    const h = harness();
    const e = await refusal(
      h.singles.cancel(BOOKER_LANE, CANCEL, customer(BOOKER)),
    );
    expect(e.code).toBe('BOOKING_PARTY_LANE');
    expect(h.transition).not.toHaveBeenCalled();
  });

  it.each([
    [
      'cancel',
      (h: ReturnType<typeof harness>) =>
        h.singles.cancel(RANA_LANE, CANCEL, customer(STRANGER)),
    ],
    [
      'reschedule',
      (h: ReturnType<typeof harness>) =>
        h.singles.reschedule(RANA_LANE, MOVE, customer(STRANGER)),
    ],
  ])(
    'a stranger on a party lane (%s) gets the 404, never learning it is a party',
    async (_, call) => {
      const h = harness();
      await expect(call(h)).rejects.toBeInstanceOf(NotFoundException);
      expect(h.transition).not.toHaveBeenCalled();
      expect(h.reschedules.execute).not.toHaveBeenCalled();
    },
  );
});

describe('MOBILE_GROUP_LANE_GUARD off: none of the seven refuse', () => {
  beforeEach(() => {
    delete process.env.MOBILE_GROUP_LANE_GUARD;
  });

  type H = ReturnType<typeof harness>;
  it.each<[string, (h: H) => Promise<unknown>]>([
    [
      '1. member lane cancel',
      (h) => h.singles.cancel(RANA_LANE, CANCEL, customer(RANA)),
    ],
    [
      '2. member lane reschedule',
      (h) => h.singles.reschedule(RANA_LANE, MOVE, customer(RANA)),
    ],
    [
      '3. ordinary booking cancel',
      (h) => h.singles.cancel(SOLO, CANCEL, customer(RANA)),
    ],
    [
      '4. staff party lane cancel',
      (h) => h.singles.cancel(RANA_LANE, CANCEL, staff),
    ],
    [
      '5. booker party cancel',
      (h) => h.parties.cancel(APP_PARTY, customer(BOOKER)),
    ],
    [
      '6. desk lane cancel',
      (h) => h.singles.cancel(DESK_LANE, CANCEL, customer(RANA)),
    ],
    [
      '7. desk lane reschedule',
      (h) => h.singles.reschedule(DESK_LANE, MOVE, customer(RANA)),
    ],
  ])('%s goes through', async (_, call) => {
    const h = harness();
    await expect(call(h)).resolves.toBeDefined();
  });
});

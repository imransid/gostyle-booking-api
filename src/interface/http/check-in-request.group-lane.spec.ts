import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { CheckInRequestController } from './check-in-request.controller';
import { BookingScope } from './booking-scope';
import { BookingScopeRepository } from '@infrastructure/persistence/booking-scope.repository';
import { CheckInRequestRepository } from '@infrastructure/persistence/check-in-request.repository';
import { CheckInRequestHandler } from '@application/commands/check-in-request.handler';
import { toUuid } from '@infrastructure/persistence/hold.repository';
import type { Actor } from '../../auth/actor';

/**
 * A PARTY MEMBER CHECKS IN ON THEIR OWN LANE, through the single route
 * POST /v1/bookings/:id/check-in-request. Group self check-in rests on this:
 * the party read hands a member their own lane's id (`booking_id`) and the
 * app sends it here. Nothing new was built for it.
 *
 * So this guards two facts:
 *   - a lane is NOT refused for being in a party;
 *   - another member's lane IS refused, 404 "No such booking", as any
 *     booking that is not the caller's.
 *
 * Everything between the route and the database is the real code: the
 * controller, BookingScope and its repository, scopeVerdict and
 * customer-ownership.ts, the handler, the check-in request repository and
 * raiseVerdict. Only Prisma is faked, and the fake answers only the columns
 * each query asks for, so a group rule added at ANY of those layers (reading
 * group_id) turns this red.
 */

const GROUP = 'aaaaaaaa-0000-4aaa-8aaa-aaaaaaaaaaaa';
const BOOKER = '11111111-1111-4111-8111-111111111111';
const RANA = '22222222-2222-4222-8222-222222222222';
const BOOKER_LANE = 'bbbbbbbb-0000-4bbb-8bbb-000000000000';
const RANA_LANE = 'bbbbbbbb-1111-4bbb-8bbb-111111111111';
const GUEST_LANE = 'bbbbbbbb-2222-4bbb-8bbb-222222222222';

const MIN = 60_000;
const NOW = Date.UTC(2026, 9, 14, 12, 50);
/** Starts in 10 minutes: inside the check-in window (start - 30). */
const START = NOW + 10 * MIN;

/**
 * A party lane as mobile-group-confirm.repository.ts stores it: the
 * member's own customer id (a guest's lane is filed under the group id),
 * group_id set, an ordinary confirmed booking.
 */
const lane = (id: string, code: string, customerId: string) => ({
  id,
  code,
  customerId,
  groupId: GROUP,
  tenantId: 'tenant-a',
  branchId: 'b7e92439-8285-469a-bba4-dcaa3dd5842c',
  status: 'confirmed',
  channel: 'online',
  startAt: new Date(START),
  endAt: new Date(START + 45 * MIN),
});

const SOLO = 'eeeeeeee-1111-4eee-8eee-111111111111';

const LANES = [
  lane(BOOKER_LANE, 'GS-1417', toUuid(BOOKER)),
  lane(RANA_LANE, 'GS-1418', toUuid(RANA)),
  lane(GUEST_LANE, 'GS-1419', toUuid(GROUP)),
  // Rana's ordinary booking, in no party: the yardstick for "exactly as".
  { ...lane(SOLO, 'GS-1500', toUuid(RANA)), groupId: null },
];

/** A LIVE card on a free chair of the lanes' own salon, as platform answers. */
const CARD = 'chair-card-8';
const CHAIR = {
  cardStatus: 'LIVE',
  chairId: 'cccccccc-8888-4ccc-8ccc-888888888888',
  tenantId: 'tenant-a',
  branchId: 'b7e92439-8285-469a-bba4-dcaa3dd5842c',
  chairNumber: '8',
  zoneName: 'Window section',
  chairState: 'AVAILABLE',
  chairBookable: true,
};

/** Only the fields a Prisma `select` asked for. */
function picked(
  row: Record<string, unknown>,
  select: Record<string, boolean>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.keys(select)
      .filter((k) => select[k])
      .map((k) => [k, row[k]]),
  );
}

const SNAKE: Record<string, string> = {
  start_at: 'startAt',
  end_at: 'endAt',
  tenant_id: 'tenantId',
  branch_id: 'branchId',
  customer_id: 'customerId',
  group_id: 'groupId',
};

/** Only the columns a raw `SELECT a, b, c FROM` asked for. */
function columns(sql: string, row: Record<string, unknown>) {
  const list = /SELECT\s+([\s\S]+?)\s+FROM/i.exec(sql)?.[1] ?? '';
  return Object.fromEntries(
    list
      .split(',')
      .map((c) => c.trim())
      .map((c) => [c, row[SNAKE[c] ?? c]]),
  );
}

function route() {
  const byId = (id: unknown) =>
    LANES.find((l) => l.id === id) as Record<string, unknown> | undefined;
  const tx = {
    $queryRaw: vi.fn((sql: TemplateStringsArray, ...values: unknown[]) => {
      // occupantOf (a chair claimed): nobody is in that chair.
      if (/FROM booking me/.test(sql.join('?'))) return Promise.resolve([]);
      const row = byId(values[0]);
      return Promise.resolve(
        row === undefined ? [] : [columns(sql.join('?'), row)],
      );
    }),
    checkInRequest: {
      findFirst: vi.fn(() => Promise.resolve(null)),
      create: vi.fn(
        (args: {
          data: {
            bookingId: string;
            raisedAt: Date;
            chairId?: string;
            chairNumber?: string;
            chairZoneName?: string | null;
          };
        }) =>
          Promise.resolve({
            id: 'req-1',
            bookingId: args.data.bookingId,
            state: 'waiting',
            raisedAt: args.data.raisedAt,
            decidedAt: null,
            chairId: args.data.chairId ?? null,
            chairNumber: args.data.chairNumber ?? null,
            chairZoneName: args.data.chairZoneName ?? null,
          }),
      ),
    },
  };
  const prisma = {
    booking: {
      findUnique: vi.fn(
        (args: { where: { id: string }; select: Record<string, boolean> }) => {
          const row = byId(args.where.id);
          return Promise.resolve(
            row === undefined ? null : picked(row, args.select),
          );
        },
      ),
    },
    $transaction: vi.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  const chairs = {
    resolve: vi.fn((token: string) =>
      Promise.resolve(
        token === CARD
          ? { kind: 'found' as const, chair: CHAIR }
          : { kind: 'unknown_card' as const },
      ),
    ),
  };
  const handler = new CheckInRequestHandler(
    new CheckInRequestRepository(prisma as never),
    chairs,
    {} as never,
  );
  const raise = vi.spyOn(handler, 'raise');
  const c = new CheckInRequestController(
    new BookingScope(new BookingScopeRepository(prisma as never)),
    handler,
  );
  const res = { status: vi.fn() };
  return { c, raise, prisma, tx, res, chairs };
}

const customer = (id: string): Actor => ({
  id,
  kind: 'customer',
  branchId: null,
  tenantId: null,
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('POST /v1/bookings/:id/check-in-request on a party lane', () => {
  it('a member raises on their own lane: 201, nothing refuses it for being in a party', async () => {
    const h = route();
    await expect(
      h.c.raise(RANA_LANE, {}, customer(RANA), h.res as never),
    ).resolves.toMatchObject({
      request: { bookingId: RANA_LANE, state: 'WAITING' },
    });
    expect(h.res.status).toHaveBeenCalledWith(201);
    expect(h.tx.checkInRequest.create).toHaveBeenCalledTimes(1);
    expect(h.tx.checkInRequest.create.mock.calls[0]![0].data).toMatchObject({
      bookingId: RANA_LANE,
      raisedByKind: 'customer',
      raisedById: toUuid(RANA),
    });
  });

  it("another member's lane: 404 No such booking, the handler never runs, nothing written", async () => {
    const h = route();
    await expect(
      h.c.raise(RANA_LANE, {}, customer(BOOKER), h.res as never),
    ).rejects.toThrow(new NotFoundException('No such booking'));
    expect(h.raise).not.toHaveBeenCalled();
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
    expect(h.tx.checkInRequest.create).not.toHaveBeenCalled();
    expect(h.res.status).not.toHaveBeenCalled();
  });

  it("a guest's lane: 404 even for the booker (D2: the booker's party tap is the way)", async () => {
    const h = route();
    await expect(
      h.c.raise(GUEST_LANE, {}, customer(BOOKER), h.res as never),
    ).rejects.toThrow(new NotFoundException('No such booking'));
    expect(h.raise).not.toHaveBeenCalled();
    expect(h.tx.checkInRequest.create).not.toHaveBeenCalled();
  });
});

describe('POST /v1/bookings/:id/check-in-request with a chairToken on a party lane', () => {
  it('a member scans a chair on their own lane: 201, the request claims that chair', async () => {
    const h = route();
    await expect(
      h.c.raise(
        RANA_LANE,
        { chairToken: CARD },
        customer(RANA),
        h.res as never,
      ),
    ).resolves.toMatchObject({
      request: {
        bookingId: RANA_LANE,
        state: 'WAITING',
        chair: { number: '8', zoneName: 'Window section' },
      },
    });
    expect(h.res.status).toHaveBeenCalledWith(201);
    expect(h.chairs.resolve).toHaveBeenCalledWith(CARD, null);
    expect(h.tx.checkInRequest.create.mock.calls[0]![0].data).toMatchObject({
      bookingId: RANA_LANE,
      raisedById: toUuid(RANA),
      chairId: CHAIR.chairId,
      chairNumber: '8',
      chairZoneName: 'Window section',
    });
  });

  it('exactly as on an ordinary booking: the same answer and the same write, but the booking', async () => {
    const onLane = route();
    const lane = await onLane.c.raise(
      RANA_LANE,
      { chairToken: CARD },
      customer(RANA),
      onLane.res as never,
    );
    const onSolo = route();
    const solo = await onSolo.c.raise(
      SOLO,
      { chairToken: CARD },
      customer(RANA),
      onSolo.res as never,
    );
    expect({ ...lane.request, bookingId: SOLO }).toEqual(solo.request);
    expect(onLane.res.status.mock.calls).toEqual(onSolo.res.status.mock.calls);
    const write = (h: ReturnType<typeof route>) =>
      h.tx.checkInRequest.create.mock.calls[0]![0].data;
    expect({ ...write(onLane), bookingId: SOLO }).toEqual(write(onSolo));
  });

  it('a card that is not a chair is refused on a lane exactly as on an ordinary booking', async () => {
    const errors = [];
    for (const id of [RANA_LANE, SOLO]) {
      const h = route();
      errors.push(
        await h.c
          .raise(id, { chairToken: 'a-poster' }, customer(RANA), h.res as never)
          .catch((e: unknown) => e),
      );
      expect(h.tx.checkInRequest.create).not.toHaveBeenCalled();
    }
    expect(errors[0]).toMatchObject({
      code: 'BOOKING_CHAIR_REFUSED',
      details: { reason: 'UNKNOWN_CARD' },
    });
    expect(errors[1]).toEqual(errors[0]);
  });
});

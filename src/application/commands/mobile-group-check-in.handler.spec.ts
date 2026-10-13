import { describe, expect, it, vi } from 'vitest';
import type { RaiseOutcome } from '@infrastructure/persistence/check-in-request.repository';
import { MobileGroupCheckInHandler } from './mobile-group-check-in.handler';
import { MobileContractError } from './mobile-booking.error';

const GROUP = 'cccccccc-0000-4ccc-8ccc-cccccccccccc';
const BOOKER = 'aaaaaaaa-0000-4aaa-8aaa-aaaaaaaaaaaa';
const RANA = 'bbbbbbbb-0000-4bbb-8bbb-bbbbbbbbbbbb';
const L1 = 'dddddddd-0001-4ddd-8ddd-dddddddddddd'; // the booker's own lane
const L2 = 'dddddddd-0002-4ddd-8ddd-dddddddddddd'; // Rana, registered
const L3 = 'dddddddd-0003-4ddd-8ddd-dddddddddddd'; // a guest
const NOW = Date.UTC(2026, 9, 13, 10, 0);

const booker = { actorId: BOOKER, actorKind: 'customer', actorBranchId: null };

function row(bookingId: string) {
  return {
    id: `req-${bookingId.slice(-4)}`,
    bookingId,
    state: 'waiting',
    raisedAt: new Date(NOW),
    decidedAt: null,
    chairId: null,
    chairNumber: null,
    chairZoneName: null,
  } as never;
}
const raised = (id: string): RaiseOutcome => ({
  kind: 'raised',
  request: row(id),
});
const waiting = (id: string): RaiseOutcome => ({
  kind: 'already_waiting',
  request: row(id),
});
const refused = (
  why: 'not_confirmed' | 'too_early',
  bookingStatus: 'confirmed' | 'checked_in' | 'cancelled',
): RaiseOutcome => ({
  kind: 'refused',
  why,
  bookingStatus,
  ...(why === 'too_early' ? { opensAtMs: NOW + 3_600_000 } : {}),
});

function build(opts: {
  outcomes?: Record<string, RaiseOutcome>;
  latest?: Record<string, unknown>;
  source?: string | null;
}) {
  const prisma = {
    bookingGroup: {
      findUnique: vi.fn(() =>
        Promise.resolve({
          organiserId: BOOKER,
          source: opts.source === undefined ? 'mobile' : opts.source,
          participants: [
            { bookingId: L1, customerId: BOOKER },
            { bookingId: L2, customerId: RANA },
            { bookingId: L3, customerId: null },
          ],
        }),
      ),
    },
    booking: {
      // Backwards on purpose: the answer must follow the PARTY's order.
      findMany: vi.fn(() =>
        Promise.resolve([
          { id: L3, code: 'GS-3' },
          { id: L2, code: 'GS-2' },
          { id: L1, code: 'GS-1' },
        ]),
      ),
    },
  };
  const requests = {
    raise: vi.fn((input: { bookingId: string }) =>
      Promise.resolve(opts.outcomes?.[input.bookingId]),
    ),
    latestFor: vi.fn((id: string) =>
      Promise.resolve(opts.latest?.[id] ?? null),
    ),
  };
  const handler = new MobileGroupCheckInHandler(
    prisma as never,
    requests as never,
  );
  return { handler, prisma, requests };
}

const notFound = MobileContractError.notFoundBooking();

describe('MobileGroupCheckInHandler.raise', () => {
  it('the booker, everyone raised: 201, every lane in party order, who is who', async () => {
    const { handler } = build({
      outcomes: { [L1]: raised(L1), [L2]: raised(L2), [L3]: raised(L3) },
    });
    const out = await handler.raise(GROUP, booker, undefined, NOW);
    expect(out.status).toBe(201);
    expect(
      out.view.lanes.map((l) => [l.bookingCode, l.memberKind, l.outcome]),
    ).toStrictEqual([
      ['GS-1', 'self', 'RAISED'],
      ['GS-2', 'registered', 'RAISED'],
      ['GS-3', 'guest', 'RAISED'],
    ]);
    expect(out.view.lanes[0]!.request).toMatchObject({
      requestId: 'req-dddd',
      state: 'WAITING',
    });
  });

  it('one clock for the whole party, raised as the booker', async () => {
    const { handler, requests } = build({
      outcomes: { [L1]: raised(L1), [L2]: raised(L2), [L3]: raised(L3) },
    });
    await handler.raise(GROUP, booker, undefined, NOW);
    expect(requests.raise).toHaveBeenCalledTimes(3);
    for (const [input] of requests.raise.mock.calls) {
      expect(input).toStrictEqual(
        expect.objectContaining({
          actor: 'customer',
          actorId: BOOKER,
          nowMs: NOW,
        }),
      );
    }
  });

  it('sent again: 200, every lane WAITING', async () => {
    const { handler } = build({
      outcomes: { [L1]: waiting(L1), [L2]: waiting(L2), [L3]: waiting(L3) },
    });
    const out = await handler.raise(GROUP, booker, undefined, NOW);
    expect(out.status).toBe(200);
    expect(out.view.lanes.every((l) => l.outcome === 'WAITING')).toBe(true);
  });

  it('a friend too early does not stop the others: 201, their own error on their lane', async () => {
    const { handler } = build({
      outcomes: {
        [L1]: raised(L1),
        [L2]: refused('too_early', 'confirmed'),
        [L3]: raised(L3),
      },
    });
    const out = await handler.raise(GROUP, booker, undefined, NOW);
    expect(out.status).toBe(201);
    expect(out.view.lanes[1]).toMatchObject({
      outcome: 'REFUSED',
      request: null,
      error: { code: 'BOOKING_CHECKIN_WINDOW' },
    });
  });

  it("everyone too early: the single route's own refusal", async () => {
    const early = refused('too_early', 'confirmed');
    const { handler } = build({
      outcomes: { [L1]: early, [L2]: early, [L3]: early },
    });
    await expect(
      handler.raise(GROUP, booker, undefined, NOW),
    ).rejects.toMatchObject({
      code: 'BOOKING_CHECKIN_WINDOW',
    });
  });

  it('nothing to do, mixed reasons: BOOKING_GROUP_CHECKIN_NONE with every lane', async () => {
    const { handler } = build({
      outcomes: {
        [L1]: refused('not_confirmed', 'checked_in'),
        [L2]: refused('not_confirmed', 'cancelled'),
        [L3]: refused('too_early', 'confirmed'),
      },
    });
    const err = (await handler
      .raise(GROUP, booker, undefined, NOW)
      .catch((e: unknown) => e)) as {
      code: string;
      details: { lanes: unknown[] };
    };
    expect(err.code).toBe('BOOKING_GROUP_CHECKIN_NONE');
    expect(
      err.details.lanes.map((l) => (l as { outcome: string }).outcome),
    ).toStrictEqual(['CHECKED_IN', 'LEFT', 'REFUSED']);
  });

  it('only the lanes the booker named', async () => {
    const { handler, requests } = build({ outcomes: { [L3]: raised(L3) } });
    const out = await handler.raise(GROUP, booker, [L3.toUpperCase()], NOW);
    expect(out.view.lanes.map((l) => l.bookingId)).toStrictEqual([L3]);
    expect(requests.raise).toHaveBeenCalledTimes(1);
  });

  it('a named id not in this party: 422, and NOTHING raised', async () => {
    const stranger = 'eeeeeeee-0000-4eee-8eee-eeeeeeeeeeee';
    const { handler, requests } = build({ outcomes: { [L1]: raised(L1) } });
    await expect(
      handler.raise(GROUP, booker, [L1, stranger], NOW),
    ).rejects.toEqual(
      new MobileContractError(
        [
          {
            field: 'bookingIds',
            code: 'not_found',
            message: `Not a booking of this party: ${stranger}`,
          },
        ],
        422,
      ),
    );
    expect(requests.raise).not.toHaveBeenCalled();
  });

  it.each([
    [
      'a registered member',
      { actorId: RANA, actorKind: 'customer', actorBranchId: null },
    ],
    [
      'a stranger',
      {
        actorId: 'ffffffff-0000-4fff-8fff-ffffffffffff',
        actorKind: 'customer',
        actorBranchId: null,
      },
    ],
    [
      "staff, even with the booker's id",
      { actorId: BOOKER, actorKind: 'staff', actorBranchId: null },
    ],
  ])('%s: 404, and nothing raised', async (_who, who) => {
    const { handler, requests } = build({});
    await expect(handler.raise(GROUP, who, undefined, NOW)).rejects.toEqual(
      notFound,
    );
    expect(requests.raise).not.toHaveBeenCalled();
  });

  it('a party made at the desk: 404', async () => {
    const { handler } = build({ source: null });
    await expect(handler.raise(GROUP, booker, undefined, NOW)).rejects.toEqual(
      notFound,
    );
  });

  it('not a uuid: 404 without asking the database', async () => {
    const { handler, prisma } = build({});
    await expect(handler.raise('nope', booker, undefined, NOW)).rejects.toEqual(
      notFound,
    );
    expect(prisma.bookingGroup.findUnique).not.toHaveBeenCalled();
  });
});

describe('MobileGroupCheckInHandler.read', () => {
  it("each lane's latest request, null for a lane that never said it", async () => {
    const { handler } = build({ latest: { [L2]: row(L2) } });
    const out = await handler.read(GROUP, booker);
    expect(
      out.lanes.map((l) => [l.bookingCode, l.request?.state ?? null]),
    ).toStrictEqual([
      ['GS-1', null],
      ['GS-2', 'WAITING'],
      ['GS-3', null],
    ]);
  });

  it('anyone but the booker: 404', async () => {
    const { handler } = build({});
    await expect(
      handler.read(GROUP, {
        actorId: RANA,
        actorKind: 'customer',
        actorBranchId: null,
      }),
    ).rejects.toEqual(notFound);
  });
});

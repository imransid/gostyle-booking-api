import { afterEach, describe, expect, it, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { GUARDS_METADATA, HTTP_CODE_METADATA } from '@nestjs/common/constants';
import { CheckInRequestController } from './check-in-request.controller';
import { SelfCheckInEnabledGuard } from './self-check-in.flag';
import { BookingScope } from './booking-scope';
import { BookingError } from '@application/contract/errors';
import type { Actor } from '../../auth/actor';
import { toUuid } from '@infrastructure/persistence/hold.repository';

/**
 * The customer's self check-in routes. The scope check is the real
 * BookingScope; only its database lookup is faked.
 */

const BOOKING = 'eeeeeeee-5555-4eee-8eee-eeeeeeeeeeee';
const VIEW = {
  requestId: 'req-1',
  bookingId: BOOKING,
  state: 'WAITING',
  raisedAt: '2026-10-11T03:50:00.000Z',
  decidedAt: null,
};

const customer = (id: string): Actor => ({
  id,
  kind: 'customer',
  branchId: null,
  tenantId: null,
});
const staff: Actor = {
  id: 'desk-1',
  kind: 'staff',
  branchId: null,
  tenantId: 'tenant-a',
};

function controller(owner: string | null = 'sara', created = true) {
  const row =
    owner === null
      ? null
      : {
          id: BOOKING,
          code: 'GS-1',
          customerId: toUuid(owner),
          tenantId: 'tenant-a',
          branchId: 'b7e92439-8285-469a-bba4-dcaa3dd5842c',
        };
  const lookup = {
    byId: vi.fn((id: string) => Promise.resolve(id === BOOKING ? row : null)),
    byCode: vi.fn(() => Promise.resolve(null)),
  };
  const handler = {
    raise: vi.fn(() => Promise.resolve({ created, request: VIEW })),
    withdraw: vi.fn(() =>
      Promise.resolve({ request: { ...VIEW, state: 'WITHDRAWN' } }),
    ),
    read: vi.fn(() => Promise.resolve({ request: null, checkIn: null })),
  };
  const res = { status: vi.fn() };
  const c = new CheckInRequestController(
    new BookingScope(lookup as never),
    handler as never,
  );
  return { c, lookup, handler, res };
}

describe('CheckInRequestController', () => {
  const saved = process.env.STAFF_SCOPE_V1;
  afterEach(() => {
    if (saved === undefined) delete process.env.STAFF_SCOPE_V1;
    else process.env.STAFF_SCOPE_V1 = saved;
  });

  it('every route is behind SELF_CHECK_IN_V1 (off: 404)', () => {
    const guards = Reflect.getMetadata(
      GUARDS_METADATA,
      CheckInRequestController,
    ) as unknown[];
    expect(guards).toContain(SelfCheckInEnabledGuard);
  });

  it('raise: 201 with the new request, for the customer’s own booking', async () => {
    const h = controller('sara', true);
    await expect(
      h.c.raise(BOOKING, {}, customer('sara'), h.res as never),
    ).resolves.toEqual({ request: VIEW });
    expect(h.res.status).toHaveBeenCalledWith(201);
    expect(h.handler.raise).toHaveBeenCalledWith({
      bookingId: BOOKING,
      actor: 'customer',
      actorId: 'sara',
    });
  });

  it('raise at a chair: the token and the app’s user agent go on as sent', async () => {
    const h = controller('sara', true);
    await h.c.raise(
      BOOKING,
      { chairToken: ' q7Xk2mP9 ', userAgent: 'GoStyle/1.4 (iPhone)' },
      customer('sara'),
      h.res as never,
    );
    expect(h.handler.raise).toHaveBeenCalledWith({
      bookingId: BOOKING,
      actor: 'customer',
      actorId: 'sara',
      chairToken: ' q7Xk2mP9 ',
      userAgent: 'GoStyle/1.4 (iPhone)',
    });
  });

  it('raise: 200 when one was already waiting', async () => {
    const h = controller('sara', false);
    await h.c.raise(BOOKING, {}, customer('sara'), h.res as never);
    expect(h.res.status).toHaveBeenCalledWith(200);
  });

  it('withdraw: 200 with the request, for the customer’s own booking, on the server’s clock', async () => {
    const h = controller('sara');
    await expect(h.c.withdraw(BOOKING, customer('sara'))).resolves.toEqual({
      request: { ...VIEW, state: 'WITHDRAWN' },
    });
    expect(h.handler.withdraw).toHaveBeenCalledWith({
      bookingId: BOOKING,
      actorId: 'sara',
    });
    // @HttpCode(200), not Nest's 201 for a POST: nothing is created.
    const route: unknown = Object.getOwnPropertyDescriptor(
      CheckInRequestController.prototype,
      'withdraw',
    )?.value;
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, route as object)).toBe(200);
  });

  it.each([
    [
      'raise',
      (h: ReturnType<typeof controller>, a: Actor) =>
        h.c.raise(BOOKING, {}, a, h.res as never),
    ],
    [
      'withdraw',
      (h: ReturnType<typeof controller>, a: Actor) => h.c.withdraw(BOOKING, a),
    ],
    [
      'read',
      (h: ReturnType<typeof controller>, a: Actor) => h.c.read(BOOKING, a),
    ],
  ] as const)(
    '%s: someone else’s booking is 404 "No such booking", and nothing runs',
    async (_, call) => {
      const h = controller('sara');
      await expect(call(h, customer('omar'))).rejects.toThrow(
        new NotFoundException('No such booking'),
      );
      expect(h.handler.raise).not.toHaveBeenCalled();
      expect(h.handler.withdraw).not.toHaveBeenCalled();
      expect(h.handler.read).not.toHaveBeenCalled();
    },
  );

  it('withdraw: a booking that is not there, or a malformed id, is the same 404', async () => {
    for (const [owner, id] of [
      [null, BOOKING],
      ['sara', 'not-a-uuid'],
    ] as const) {
      const h = controller(owner);
      await expect(h.c.withdraw(id, customer('sara'))).rejects.toThrow(
        new NotFoundException('No such booking'),
      );
      expect(h.handler.withdraw).not.toHaveBeenCalled();
    }
  });

  it('raise: a booking that is not there is the same 404', async () => {
    const h = controller(null);
    await expect(
      h.c.raise(BOOKING, {}, customer('sara'), h.res as never),
    ).rejects.toThrow(new NotFoundException('No such booking'));
    expect(h.handler.raise).not.toHaveBeenCalled();
  });

  it('raise: a malformed id is the same 404', async () => {
    const h = controller('sara');
    await expect(
      h.c.raise('not-a-uuid', {}, customer('sara'), h.res as never),
    ).rejects.toThrow(new NotFoundException('No such booking'));
    expect(h.handler.raise).not.toHaveBeenCalled();
  });

  it('the customer check never reads STAFF_SCOPE_V1: off, it still refuses', async () => {
    process.env.STAFF_SCOPE_V1 = 'off';
    const h = controller('sara');
    await expect(h.c.read(BOOKING, customer('omar'))).rejects.toThrow(
      NotFoundException,
    );
  });

  it.each(['staff', 'manager', 'system'] as const)(
    'a %s token is FORBIDDEN_ROLE before anything is looked up',
    async (kind) => {
      const h = controller('sara');
      const actor = { ...staff, kind };
      for (const call of [
        () => h.c.raise(BOOKING, {}, actor, h.res as never),
        () => h.c.withdraw(BOOKING, actor),
        () => h.c.read(BOOKING, actor),
      ]) {
        const err: unknown = await call().catch((e: unknown) => e);
        expect(err).toBeInstanceOf(BookingError);
        expect((err as BookingError).code).toBe('FORBIDDEN_ROLE');
      }
      expect(h.lookup.byId).not.toHaveBeenCalled();
      expect(h.handler.raise).not.toHaveBeenCalled();
      expect(h.handler.withdraw).not.toHaveBeenCalled();
      expect(h.handler.read).not.toHaveBeenCalled();
    },
  );

  it('read: { request, checkIn } as the handler has them, for the customer’s own booking', async () => {
    const h = controller('sara');
    await expect(h.c.read(BOOKING, customer('sara'))).resolves.toEqual({
      request: null,
      checkIn: null,
    });
    expect(h.handler.read).toHaveBeenCalledWith(BOOKING);
  });
});

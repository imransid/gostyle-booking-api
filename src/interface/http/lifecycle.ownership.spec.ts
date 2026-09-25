import { describe, expect, it, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { LifecycleController } from './lifecycle.controller';
import type { Actor } from '../../auth/actor';
import { toUuid } from '@infrastructure/persistence/hold.repository';

/**
 * The lifecycle routes and a CUSTOMER token.
 *
 * Staff: exactly as before, for any booking, with the clock they send.
 * Customer: their own booking only (404 otherwise, never 403), and never
 * their own clock.
 */

const BOOKING = 'eeeeeeee-5555-4eee-8eee-eeeeeeeeeeee';
const ME = '11111111-1111-4111-8111-111111111111';
const YOU = '22222222-2222-4222-8222-222222222222';

const customer = (id: string) =>
  ({ id, kind: 'customer', branchId: null, tenantId: null }) as Actor;
const staff = {
  id: YOU,
  kind: 'staff',
  branchId: null,
  tenantId: null,
} as Actor;

function controller(owner: string | null = ME) {
  const handler = { execute: vi.fn(() => Promise.resolve({ ok: true })) };
  const reschedules = {
    execute: vi.fn(() => Promise.resolve({ moved: true })),
  };
  const repo = {
    timingFor: vi.fn(() =>
      Promise.resolve(
        owner === null ? null : { startAtMs: 0, customerId: toUuid(owner) },
      ),
    ),
  };
  const c = new LifecycleController(
    handler as never,
    reschedules as never,
    repo as never,
  );
  const handed = (): Record<string, unknown> =>
    (handler.execute.mock.calls[0] as unknown as [Record<string, unknown>])[0];
  const moved = (): Record<string, unknown> =>
    (
      reschedules.execute.mock.calls[0] as unknown as [Record<string, unknown>]
    )[0];
  return { c, handler, reschedules, repo, handed, moved };
}

describe('cancel and the rest: staff are unchanged', () => {
  it('staff cancel any booking, with no ownership lookup', async () => {
    const h = controller(ME);
    await h.c.cancel(BOOKING, { reason: 'late', nowMs: 5 }, staff);
    expect(h.repo.timingFor).not.toHaveBeenCalled();
    expect(h.handed()).toMatchObject({
      bookingId: BOOKING,
      to: 'cancelled',
      actor: 'staff',
      nowMs: 5,
    });
  });
});

describe('cancel and the rest: a customer token', () => {
  it('cancels their own booking', async () => {
    const h = controller(ME);
    await h.c.cancel(BOOKING, {}, customer(ME));
    expect(h.handed()).toMatchObject({
      bookingId: BOOKING,
      to: 'cancelled',
      actor: 'customer',
    });
  });

  it("is 404 on someone else's booking, and nothing runs", async () => {
    const h = controller(YOU);
    await expect(h.c.cancel(BOOKING, {}, customer(ME))).rejects.toThrow(
      NotFoundException,
    );
    await expect(h.c.cancel(BOOKING, {}, customer(ME))).rejects.toThrow(
      'No such booking',
    );
    expect(h.handler.execute).not.toHaveBeenCalled();
  });

  it('is 404 on a booking that does not exist', async () => {
    const h = controller(null);
    await expect(h.c.cancel(BOOKING, {}, customer(ME))).rejects.toThrow(
      NotFoundException,
    );
  });

  it('is 404 on a malformed id, without asking the database', async () => {
    const h = controller(ME);
    await expect(h.c.cancel('not-a-uuid', {}, customer(ME))).rejects.toThrow(
      NotFoundException,
    );
    expect(h.repo.timingFor).not.toHaveBeenCalled();
  });

  it('cannot choose the clock its refund is measured by', async () => {
    const h = controller(ME);
    await h.c.cancel(BOOKING, { nowMs: 1 }, customer(ME));
    expect(h.handed()).not.toHaveProperty('nowMs');
  });

  it.each(['checkIn', 'start', 'complete', 'settle', 'noShow'] as const)(
    '%s is refused the same way',
    async (route) => {
      const h = controller(YOU);
      await expect(
        (
          h.c[route] as (id: string, dto: never, a: Actor) => Promise<unknown>
        ).call(h.c, BOOKING, {} as never, customer(ME)),
      ).rejects.toThrow(NotFoundException);
      expect(h.handler.execute).not.toHaveBeenCalled();
    },
  );
});

describe('reschedule', () => {
  const DTO = {
    holdId: 'h',
    day: '2026-10-11',
    reason: 'r',
    nowMs: 9,
  } as never;

  it('staff: unchanged, clock and all', async () => {
    const h = controller(ME);
    await h.c.reschedule(BOOKING, DTO, staff);
    expect(h.moved()).toMatchObject({
      bookingId: BOOKING,
      actor: 'staff',
      nowMs: 9,
    });
  });

  it("a customer: 404 on someone else's", async () => {
    const h = controller(YOU);
    await expect(h.c.reschedule(BOOKING, DTO, customer(ME))).rejects.toThrow(
      NotFoundException,
    );
    expect(h.reschedules.execute).not.toHaveBeenCalled();
  });

  it('a customer: their own, on the server clock', async () => {
    const h = controller(ME);
    await h.c.reschedule(BOOKING, DTO, customer(ME));
    expect(h.moved()).not.toHaveProperty('nowMs');
  });
});

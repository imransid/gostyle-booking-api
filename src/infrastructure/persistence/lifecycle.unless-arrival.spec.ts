import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '../../generated/prisma/client';
import { LifecycleRepository } from './lifecycle.repository';

/**
 * transition()'s one self check-in question, unlessArrivalClaimed, with the
 * database faked. The race it exists for (a raise committing after the
 * sweeper picked the booking) is run for real in self-check-in.live.spec.ts.
 */

const BOOKING = 'eeeeeeee-5555-4eee-8eee-eeeeeeeeeeee';

function repo(answers: unknown[][]) {
  const queue = [...answers];
  const tx = {
    $queryRaw: vi.fn(() => Promise.resolve(queue.shift() ?? [])),
    booking: { update: vi.fn(() => Promise.resolve({})) },
    bookingItem: { findMany: vi.fn(() => Promise.resolve([])) },
    bookingStatusHistory: { create: vi.fn(() => Promise.resolve({})) },
    eventOutbox: { create: vi.fn(() => Promise.resolve({})) },
    depositLedger: { create: vi.fn(() => Promise.resolve({})) },
  };
  const prisma = {
    $transaction: vi.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  return { r: new LifecycleRepository(prisma as never), tx };
}

const lockedRow = (status: string) => ({
  id: BOOKING,
  code: 'GS-1',
  status,
  start_at: new Date(Date.UTC(2026, 9, 11, 10, 0)),
  branch_id: '11111111-1111-1111-1111-111111111111',
  trading_day: new Date(Date.UTC(2026, 9, 11)),
  start_minute: 600,
  duration_min: 60,
});

const sqlOf = (call: unknown): Prisma.Sql =>
  Prisma.sql(...(call as [TemplateStringsArray, ...unknown[]]));

const sweep = {
  bookingId: BOOKING,
  to: 'no_show' as const,
  actor: 'system' as const,
  actorId: null,
  reason: 'Nobody arrived within 30 minutes of the start.',
  unlessArrivalClaimed: true,
};

describe('transition({ unlessArrivalClaimed })', () => {
  it('refuses as illegal, and writes nothing, when the customer said they arrived', async () => {
    const h = repo([[lockedRow('confirmed')], [{ claimed: true }]]);
    await expect(h.r.transition(sweep)).resolves.toEqual({
      kind: 'illegal',
      message: 'GS-1: the customer said they arrived, so the desk decides.',
    });
    expect(h.tx.booking.update).not.toHaveBeenCalled();
    expect(h.tx.bookingStatusHistory.create).not.toHaveBeenCalled();
    expect(h.tx.eventOutbox.create).not.toHaveBeenCalled();
  });

  it('asks AFTER the row lock, about this booking, from the shared SQL', async () => {
    const h = repo([[lockedRow('confirmed')], [{ claimed: true }]]);
    await h.r.transition(sweep);
    const [lock, claim] = h.tx.$queryRaw.mock.calls.map(sqlOf);
    expect(lock?.text).toMatch(/FOR UPDATE/);
    expect(claim?.text).toMatch(/check_in_request[\s\S]*<> 'rejected'/);
    expect(claim?.values).toEqual([BOOKING]);
  });

  it('carries on as before when nobody claimed arrival', async () => {
    const h = repo([
      [lockedRow('confirmed')],
      [{ claimed: false }],
      [{ balance: 0n }],
    ]);
    await expect(h.r.transition(sweep)).resolves.toMatchObject({
      kind: 'transitioned',
      booking: { from: 'confirmed', to: 'no_show' },
    });
    expect(h.tx.booking.update).toHaveBeenCalled();
  });

  it('is never asked when the caller does not set it', async () => {
    // Every other caller: the desk's no-show by hand, cancels, check-ins.
    const h = repo([[lockedRow('confirmed')]]);
    await expect(
      h.r.transition({
        bookingId: BOOKING,
        to: 'checked_in',
        actor: 'staff',
        actorId: 'desk',
        reason: null,
      }),
    ).resolves.toMatchObject({ kind: 'transitioned' });
    expect(h.tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(
      h.tx.$queryRaw.mock.calls
        .map(sqlOf)
        .some((s) => s.text.includes('check_in_request')),
    ).toBe(false);
  });
});

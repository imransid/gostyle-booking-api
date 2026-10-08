import { describe, expect, it, vi } from 'vitest';
import { CheckInDeskHandler } from './check-in-desk.handler';
import { BookingError } from '@application/contract/errors';

const RAISED = new Date('2026-10-11T03:50:00.000Z');
const DECIDED = new Date('2026-10-11T03:55:00.000Z');
const row = (over: Record<string, unknown> = {}) => ({
  id: 'req-1',
  bookingId: 'booking-1',
  state: 'approved',
  raisedAt: RAISED,
  raisedByKind: 'customer',
  decidedAt: DECIDED,
  decidedByKind: 'staff',
  decidedById: 'desk-uuid',
  reason: null,
  ...over,
});
const CHECKED_IN = { code: 'GS-1', from: 'CONFIRMED', to: 'CHECKED_IN' };

function handler(repo: Record<string, unknown>) {
  const lifecycle = { execute: vi.fn(() => Promise.resolve(CHECKED_IN)) };
  return {
    h: new CheckInDeskHandler(repo as never, lifecycle as never),
    lifecycle,
  };
}

const caught = async (p: Promise<unknown>): Promise<BookingError> => {
  const e: unknown = await p.catch((err: unknown) => err);
  expect(e).toBeInstanceOf(BookingError);
  return e as BookingError;
};

describe('approve', () => {
  it('runs the EXISTING check-in, as this desk, inside approveWith', async () => {
    const approveWith = vi.fn(
      async (_input: unknown, checkIn: () => Promise<unknown>) => ({
        kind: 'approved',
        request: row(),
        checkIn: await checkIn(),
      }),
    );
    const { h, lifecycle } = handler({ approveWith });
    const out = await h.approve({
      bookingId: 'booking-1',
      actor: 'staff',
      actorId: 'desk-1',
    });
    expect(lifecycle.execute).toHaveBeenCalledWith({
      bookingId: 'booking-1',
      to: 'checked_in',
      actor: 'staff',
      actorId: 'desk-1',
    });
    expect(approveWith).toHaveBeenCalledWith(
      { bookingId: 'booking-1', deciderKind: 'staff', deciderId: 'desk-1' },
      expect.any(Function),
    );
    expect(out).toEqual({
      request: {
        requestId: 'req-1',
        bookingId: 'booking-1',
        state: 'APPROVED',
        raisedAt: RAISED.toISOString(),
        decidedAt: DECIDED.toISOString(),
        decidedByKind: 'STAFF',
        decidedById: 'desk-uuid',
        reason: null,
      },
      checkIn: CHECKED_IN,
    });
  });

  it('nothing waiting: BOOKING_STATE_INVALID with the latest state', async () => {
    const { h } = handler({
      approveWith: () =>
        Promise.resolve({ kind: 'nothing_waiting', latest: 'expired' }),
    });
    const e = await caught(
      h.approve({ bookingId: 'b', actor: 'staff', actorId: 'd' }),
    );
    expect([e.code, e.status]).toEqual(['BOOKING_STATE_INVALID', 409]);
    expect(e.details).toEqual({ request: 'EXPIRED' });
  });

  it('never raised: details.request is null', async () => {
    const { h } = handler({
      approveWith: () =>
        Promise.resolve({ kind: 'nothing_waiting', latest: null }),
    });
    const e = await caught(
      h.approve({ bookingId: 'b', actor: 'staff', actorId: 'd' }),
    );
    expect(e.details).toEqual({ request: null });
  });

  it('no booking: BOOKING_NOT_FOUND', async () => {
    const { h } = handler({
      approveWith: () => Promise.resolve({ kind: 'not_found' }),
    });
    const e = await caught(
      h.approve({ bookingId: 'b', actor: 'staff', actorId: 'd' }),
    );
    expect([e.code, e.status]).toEqual(['BOOKING_NOT_FOUND', 404]);
  });
});

describe('reject', () => {
  it('trims the reason and hands it down; the desk sees it back', async () => {
    const reject = vi.fn(() =>
      Promise.resolve({
        kind: 'rejected',
        request: row({ state: 'rejected', reason: 'Not at the salon' }),
      }),
    );
    const { h, lifecycle } = handler({ reject });
    const out = await h.reject({
      bookingId: 'booking-1',
      actor: 'manager',
      actorId: 'desk-2',
      reason: '  Not at the salon  ',
    });
    expect(reject).toHaveBeenCalledWith({
      bookingId: 'booking-1',
      deciderKind: 'manager',
      deciderId: 'desk-2',
      reason: 'Not at the salon',
    });
    expect(out.request).toMatchObject({
      state: 'REJECTED',
      reason: 'Not at the salon',
    });
    expect(lifecycle.execute).not.toHaveBeenCalled();
  });

  it.each([undefined, '', '   '])(
    'reason %j: BOOKING_REASON_REQUIRED, and nothing is written',
    async (reason) => {
      const reject = vi.fn();
      const { h } = handler({ reject });
      const e = await caught(
        h.reject({ bookingId: 'b', actor: 'staff', actorId: 'd', reason }),
      );
      expect([e.code, e.status, e.message]).toEqual([
        'BOOKING_REASON_REQUIRED',
        422,
        'Choose a reason',
      ]);
      expect(reject).not.toHaveBeenCalled();
    },
  );

  it('nothing waiting: BOOKING_STATE_INVALID', async () => {
    const { h } = handler({
      reject: () =>
        Promise.resolve({ kind: 'nothing_waiting', latest: 'approved' }),
    });
    const e = await caught(
      h.reject({ bookingId: 'b', actor: 'staff', actorId: 'd', reason: 'x' }),
    );
    expect(e.details).toEqual({ request: 'APPROVED' });
  });
});

describe('reception', () => {
  it('each line carries its booking for the scope check, apart from what is shown', async () => {
    const booking = {
      id: 'booking-1',
      code: 'GS-1',
      status: 'confirmed',
      startAt: new Date('2026-10-11T04:00:00.000Z'),
      endAt: new Date('2026-10-11T05:00:00.000Z'),
      customerId: 'cust-1',
      tenantId: 'tenant-a',
      branchId: 'branch-a',
    };
    const listForBranch = vi.fn(() =>
      Promise.resolve({
        waiting: [{ request: row({ state: 'waiting' }), booking }],
        needsDecision: [],
      }),
    );
    const { h } = handler({ listForBranch });
    const out = await h.reception('marina-walk');
    expect(listForBranch).toHaveBeenCalledWith(
      'marina-walk',
      expect.any(Number),
    );
    expect(out.needsDecision).toEqual([]);
    expect(out.waiting[0]?.scope).toEqual({
      customerId: 'cust-1',
      tenantId: 'tenant-a',
      branchId: 'branch-a',
    });
    expect(out.waiting[0]?.item.booking).toEqual({
      bookingId: 'booking-1',
      code: 'GS-1',
      status: 'CONFIRMED',
      startAt: '2026-10-11T04:00:00.000Z',
      endAt: '2026-10-11T05:00:00.000Z',
      customerId: 'cust-1',
    });
    expect(JSON.stringify(out.waiting[0]?.item)).not.toContain('tenant-a');
  });
});

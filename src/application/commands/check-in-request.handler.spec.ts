import { describe, expect, it, vi } from 'vitest';
import { CheckInRequestHandler } from './check-in-request.handler';
import { BookingError } from '@application/contract/errors';

const RAISED_AT = new Date('2026-10-11T03:50:00.000Z');
const ROW = {
  id: 'req-1',
  bookingId: 'booking-1',
  state: 'waiting' as const,
  raisedAt: RAISED_AT,
  raisedByKind: 'customer' as const,
  decidedAt: null,
  decidedByKind: null,
  reason: null,
};
const VIEW = {
  requestId: 'req-1',
  bookingId: 'booking-1',
  state: 'WAITING',
  raisedAt: '2026-10-11T03:50:00.000Z',
  decidedAt: null,
};

function handler(raise: unknown, latest: unknown = null) {
  const repo = {
    raise: vi.fn(() => Promise.resolve(raise)),
    latestFor: vi.fn(() => Promise.resolve(latest)),
  };
  return { h: new CheckInRequestHandler(repo as never), repo };
}

const cmd = {
  bookingId: 'booking-1',
  actor: 'customer' as const,
  actorId: 'sara',
};

async function refusal(raise: unknown): Promise<BookingError> {
  const err: unknown = await handler(raise)
    .h.raise(cmd)
    .catch((e: unknown) => e);
  expect(err).toBeInstanceOf(BookingError);
  return err as BookingError;
}

describe('CheckInRequestHandler.raise', () => {
  it('a new request: created, in the customer’s view', async () => {
    await expect(
      handler({ kind: 'raised', request: ROW }).h.raise(cmd),
    ).resolves.toEqual({ created: true, request: VIEW });
  });

  it('one already waiting: the same request, not created', async () => {
    await expect(
      handler({ kind: 'already_waiting', request: ROW }).h.raise(cmd),
    ).resolves.toEqual({ created: false, request: VIEW });
  });

  it('never passes a clock unless a test hands one in', async () => {
    const { h, repo } = handler({ kind: 'raised', request: ROW });
    await h.raise(cmd);
    expect(repo.raise).toHaveBeenCalledWith({
      bookingId: 'booking-1',
      actor: 'customer',
      actorId: 'sara',
    });
  });

  it('not found: BOOKING_NOT_FOUND, 404', async () => {
    const e = await refusal({ kind: 'not_found' });
    expect([e.code, e.status, e.message]).toEqual([
      'BOOKING_NOT_FOUND',
      404,
      'No such booking',
    ]);
  });

  it('not confirmed: BOOKING_STATE_INVALID, with the status shouted', async () => {
    const e = await refusal({
      kind: 'refused',
      why: 'not_confirmed',
      bookingStatus: 'checked_in',
    });
    expect([e.code, e.status]).toEqual(['BOOKING_STATE_INVALID', 409]);
    expect(e.message).toBe('A checked_in booking cannot be checked in.');
    expect(e.details).toEqual({ status: 'CHECKED_IN' });
  });

  it('rejected before: its own code, so the app can send them to the desk', async () => {
    const e = await refusal({
      kind: 'refused',
      why: 'rejected_before',
      bookingStatus: 'confirmed',
    });
    expect([e.code, e.status]).toEqual(['BOOKING_CHECKIN_REJECTED', 409]);
    expect(e.details).toBeUndefined();
  });

  it('too early: the desk check-in’s own code, sentence and detail', async () => {
    const opensAtMs = Date.parse('2026-10-11T03:30:00.000Z');
    const e = await refusal({
      kind: 'refused',
      why: 'too_early',
      bookingStatus: 'confirmed',
      opensAtMs,
    });
    expect([e.code, e.status]).toEqual(['BOOKING_CHECKIN_WINDOW', 409]);
    expect(e.message).toBe('Check-in opens at 2026-10-11T03:30:00.000Z.');
    expect(e.details).toEqual({ windowOpensAt: '2026-10-11T03:30:00.000Z' });
  });

  it('too late: the same code, saying it has closed', async () => {
    const e = await refusal({
      kind: 'refused',
      why: 'too_late',
      bookingStatus: 'confirmed',
    });
    expect([e.code, e.status]).toEqual(['BOOKING_CHECKIN_WINDOW', 409]);
    expect(e.details).toEqual({ windowClosed: true });
  });
});

describe('CheckInRequestHandler.latest', () => {
  it('the latest request, without the desk’s reason', async () => {
    const rejected = {
      ...ROW,
      state: 'rejected' as const,
      decidedAt: new Date('2026-10-11T03:55:00.000Z'),
      decidedByKind: 'staff' as const,
      reason: 'Not at the salon',
    };
    const view = await handler(null, rejected).h.latest('booking-1');
    expect(view).toEqual({
      ...VIEW,
      state: 'REJECTED',
      decidedAt: '2026-10-11T03:55:00.000Z',
    });
    expect(JSON.stringify(view)).not.toContain('Not at the salon');
  });

  it('null when none was ever raised', async () => {
    await expect(handler(null, null).h.latest('booking-1')).resolves.toBeNull();
  });
});

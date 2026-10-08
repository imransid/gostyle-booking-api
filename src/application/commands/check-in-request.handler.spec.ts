import { afterEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { CheckInRequestHandler } from './check-in-request.handler';
import { BookingError } from '@application/contract/errors';
import type { ChairLookup } from '@application/ports/chair-directory.port';
import type { ScannedChair } from '@domain/booking/chair-check-in';

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
  chairId: null,
  chairNumber: null,
  chairZoneName: null,
};
const VIEW = {
  requestId: 'req-1',
  bookingId: 'booking-1',
  state: 'WAITING',
  raisedAt: '2026-10-11T03:50:00.000Z',
  decidedAt: null,
  chair: null,
};

function handler(
  raise: unknown,
  latest: unknown = null,
  lookup: ChairLookup = { kind: 'unknown_card' },
) {
  const order: string[] = [];
  const repo = {
    raise: vi.fn(() => {
      order.push('raise');
      return Promise.resolve(raise);
    }),
    latestFor: vi.fn(() => Promise.resolve(latest)),
  };
  const chairs = {
    resolve: vi.fn(() => {
      order.push('platform');
      return Promise.resolve(lookup);
    }),
  };
  return {
    h: new CheckInRequestHandler(repo as never, chairs),
    repo,
    chairs,
    order,
  };
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

describe('CheckInRequestHandler.raise at a chair', () => {
  afterEach(() => vi.restoreAllMocks());

  const SCANNED: ScannedChair = {
    cardStatus: 'LIVE',
    chairId: '0192a3b4-0000-7000-8000-000000000007',
    tenantId: 'f2a9882b-c822-4107-b650-29af2e303c24',
    branchId: 'b7e92439-8285-469a-bba4-dcaa3dd5842c',
    chairNumber: '7',
    zoneName: 'Window section',
    chairState: 'ACTIVE',
    chairBookable: true,
  };
  const atChair = { ...cmd, chairToken: 'q7Xk', userAgent: 'GoStyle/1.4' };
  const found: ChairLookup = { kind: 'found', chair: SCANNED };

  async function caught(p: Promise<unknown>): Promise<BookingError> {
    const err: unknown = await p.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BookingError);
    return err as BookingError;
  }

  it('no chairToken: platform is never asked', async () => {
    const t = handler({ kind: 'raised', request: ROW });
    await t.h.raise(cmd);
    expect(t.chairs.resolve).not.toHaveBeenCalled();
  });

  it('platform first, then the raise, with the chair it answered', async () => {
    const t = handler({ kind: 'raised', request: ROW }, null, found);
    await t.h.raise(atChair);
    expect(t.order).toEqual(['platform', 'raise']);
    expect(t.chairs.resolve).toHaveBeenCalledWith('q7Xk', 'GoStyle/1.4');
    expect(t.repo.raise).toHaveBeenCalledWith({
      bookingId: 'booking-1',
      actor: 'customer',
      actorId: 'sara',
      chair: SCANNED,
    });
  });

  it('an unknown user agent goes to platform as null', async () => {
    const t = handler({ kind: 'raised', request: ROW }, null, found);
    await t.h.raise({ ...cmd, chairToken: 'q7Xk' });
    expect(t.chairs.resolve).toHaveBeenCalledWith('q7Xk', null);
  });

  it('the view carries the chair as it was scanned', async () => {
    const row = {
      ...ROW,
      chairId: SCANNED.chairId,
      chairNumber: '7',
      chairZoneName: 'Window section',
    };
    const t = handler({ kind: 'raised', request: row }, null, found);
    await expect(t.h.raise(atChair)).resolves.toMatchObject({
      request: { chair: { number: '7', zoneName: 'Window section' } },
    });
  });

  it('a code platform never printed: BOOKING_CHAIR_REFUSED, UNKNOWN_CARD, and no raise', async () => {
    const t = handler(null, null, { kind: 'unknown_card' });
    const e = await caught(t.h.raise(atChair));
    expect([e.code, e.status]).toEqual(['BOOKING_CHAIR_REFUSED', 409]);
    expect(e.details).toEqual({ reason: 'UNKNOWN_CARD' });
    expect(t.repo.raise).not.toHaveBeenCalled();
  });

  it('platform did not answer: 503 that points at Wait for Staff, and no raise without the chair', async () => {
    const error = vi.spyOn(Logger.prototype, 'error');
    const warn = vi.spyOn(Logger.prototype, 'warn');
    const t = handler(null, null, { kind: 'unavailable', error: 'x' });
    const e = await caught(t.h.raise(atChair));
    expect([e.code, e.status]).toEqual(['DEPENDENCY_UNAVAILABLE', 503]);
    expect(e.message).toContain('Wait for Staff');
    expect(e.details).toEqual({
      reason: 'CHAIR_CHECK_UNAVAILABLE',
      fallback: 'WAIT_FOR_STAFF',
    });
    expect(t.repo.raise).not.toHaveBeenCalled();
    // The adapter has logged it; a second line here would be one per scan.
    expect(error).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('refused by the rule: one sentence and a reason of ours; platform’s words go to the log only', async () => {
    const log = vi
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);
    const t = handler(
      {
        kind: 'chair_refused',
        refusal: { why: 'chair_not_bookable', chairState: 'FROZEN' },
      },
      null,
      found,
    );
    const e = await caught(t.h.raise(atChair));
    expect([e.code, e.status]).toEqual(['BOOKING_CHAIR_REFUSED', 409]);
    expect(e.message).toBe(
      'That chair is not available. Please take another or see the desk.',
    );
    expect(e.details).toEqual({ reason: 'CHAIR_NOT_AVAILABLE' });
    expect(JSON.stringify(e.toBody())).not.toContain('FROZEN');
    expect(String(log.mock.calls[0]?.[0])).toContain('FROZEN');
  });

  it('occupied: the same sentence and reason, and never the other customer’s booking', async () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const t = handler(
      {
        kind: 'chair_refused',
        refusal: { why: 'chair_occupied', occupant: 'GS-1402' },
      },
      null,
      found,
    );
    const e = await caught(t.h.raise(atChair));
    expect(e.details).toEqual({ reason: 'CHAIR_NOT_AVAILABLE' });
    expect(JSON.stringify(e.toBody())).not.toContain('GS-1402');
  });
});

import { describe, expect, it } from 'vitest';
import {
  lapseOf,
  raiseVerdict,
  rejectionReason,
  withdrawVerdict,
} from './check-in-request';
import { CHECK_IN_OPENS_MIN, type BookingStatus } from './lifecycle';

const MIN = 60_000;
// A booking from 10:00 to 11:00 (UTC, any day).
const START = Date.UTC(2026, 9, 11, 10, 0);
const END = START + 60 * MIN;

function raise(
  over: Partial<Parameters<typeof raiseVerdict>[0]> = {},
): ReturnType<typeof raiseVerdict> {
  return raiseVerdict({
    bookingStatus: 'confirmed',
    startAtMs: START,
    endAtMs: END,
    nowMs: START - 10 * MIN,
    latest: null,
    ...over,
  });
}

describe('raiseVerdict: when a customer may say "I am here"', () => {
  it('raises on a confirmed booking inside the window', () => {
    expect(raise()).toEqual({ kind: 'raise' });
  });

  it('opens exactly when the desk check-in opens, and not a minute before', () => {
    const opens = START - CHECK_IN_OPENS_MIN * MIN;
    expect(raise({ nowMs: opens })).toEqual({ kind: 'raise' });
    expect(raise({ nowMs: opens - 1 })).toEqual({
      kind: 'refused',
      why: 'too_early',
      opensAtMs: opens,
    });
  });

  it('is still open after the start and after the auto no-show time', () => {
    // Late is not absent. Whether the visit still fits is the desk's call.
    expect(raise({ nowMs: START + 45 * MIN })).toEqual({ kind: 'raise' });
  });

  it('closes at the end time', () => {
    expect(raise({ nowMs: END - 1 })).toEqual({ kind: 'raise' });
    expect(raise({ nowMs: END })).toEqual({
      kind: 'refused',
      why: 'too_late',
    });
  });

  it.each<BookingStatus>([
    'checked_in',
    'in_service',
    'completed',
    'settled',
    'cancelled',
    'no_show',
    'rescheduled',
    'expired',
    'pending_payment',
    'held',
  ])('refuses a %s booking', (bookingStatus) => {
    expect(raise({ bookingStatus })).toEqual({
      kind: 'refused',
      why: 'not_confirmed',
    });
  });

  it('answers a second tap with the request already waiting', () => {
    expect(raise({ latest: 'waiting' })).toEqual({ kind: 'already_waiting' });
  });

  it('answers a second tap that way even outside the window', () => {
    // The claim stands until the lapse job ends it; a tap a second past the
    // end time is told it is waiting, not that it is too late.
    expect(raise({ latest: 'waiting', nowMs: END + 1 })).toEqual({
      kind: 'already_waiting',
    });
  });

  it('never raises again after the desk said no', () => {
    expect(raise({ latest: 'rejected' })).toEqual({
      kind: 'refused',
      why: 'rejected_before',
    });
  });

  it('says not confirmed before anything about an earlier request', () => {
    expect(raise({ bookingStatus: 'checked_in', latest: 'waiting' })).toEqual({
      kind: 'refused',
      why: 'not_confirmed',
    });
    expect(raise({ bookingStatus: 'no_show', latest: 'rejected' })).toEqual({
      kind: 'refused',
      why: 'not_confirmed',
    });
  });

  it.each(['approved', 'expired', 'closed'] as const)(
    'raises again after a request that was %s, if the booking is confirmed again',
    (latest) => {
      // approved or closed, then the check-in was undone: the customer is
      // still there and may say so again.
      expect(raise({ latest })).toEqual({ kind: 'raise' });
    },
  );

  it('raises again after the customer withdrew, unlike after a rejection', () => {
    // The two sides of one line: taking it back is not the desk saying no.
    expect(raise({ latest: 'withdrawn' })).toEqual({ kind: 'raise' });
    expect(raise({ latest: 'rejected' })).toMatchObject({
      why: 'rejected_before',
    });
  });

  it('still holds a raise after a withdrawal to the window', () => {
    expect(raise({ latest: 'withdrawn', nowMs: END })).toEqual({
      kind: 'refused',
      why: 'too_late',
    });
  });
});

describe('withdrawVerdict: when a customer may take their request back', () => {
  function withdraw(
    over: Partial<Parameters<typeof withdrawVerdict>[0]> = {},
  ): ReturnType<typeof withdrawVerdict> {
    return withdrawVerdict({
      latest: 'waiting',
      bookingStatus: 'confirmed',
      endAtMs: END,
      nowMs: START + 5 * MIN,
      ...over,
    });
  }

  it('withdraws a waiting request on a confirmed booking', () => {
    expect(withdraw()).toEqual({ kind: 'withdraw' });
  });

  it('withdraws past the auto no-show time: late is still here', () => {
    expect(withdraw({ nowMs: START + 45 * MIN })).toEqual({
      kind: 'withdraw',
    });
  });

  it('answers a second tap with the request already withdrawn', () => {
    expect(withdraw({ latest: 'withdrawn' })).toEqual({
      kind: 'already_withdrawn',
    });
  });

  it('answers a second tap that way even after the booking moved on', () => {
    // Withdrawn, then the desk checked them in: the tap was still a withdraw.
    expect(
      withdraw({
        latest: 'withdrawn',
        bookingStatus: 'checked_in',
        nowMs: END,
      }),
    ).toEqual({ kind: 'already_withdrawn' });
  });

  it.each([null, 'approved', 'rejected', 'expired', 'closed'] as const)(
    'has nothing to withdraw when the latest is %s',
    (latest) => {
      expect(withdraw({ latest })).toEqual({
        kind: 'refused',
        why: 'nothing_waiting',
      });
    },
  );

  it('leaves a request on a booking that moved on to the lapse job', () => {
    // Checked in with the desk's own button; the job closes it within the
    // minute, and closed is what happened.
    expect(withdraw({ bookingStatus: 'checked_in' })).toEqual({
      kind: 'refused',
      why: 'lapsed',
      lapse: {
        to: 'closed',
        reason: 'The booking became checked_in before the desk answered.',
      },
    });
  });

  it('leaves a request nobody answered by the end time to the lapse job', () => {
    // Expired, not withdrawn: the desk is shown how often it did not answer.
    expect(withdraw({ nowMs: END })).toMatchObject({
      kind: 'refused',
      why: 'lapsed',
      lapse: { to: 'expired' },
    });
    expect(withdraw({ nowMs: END - 1 })).toEqual({ kind: 'withdraw' });
  });

  it('decides lapsed exactly as the lapse job does', () => {
    // One rule, not two: whatever lapseOf says, withdraw says the same.
    const cases = [
      { bookingStatus: 'confirmed', nowMs: END - 1 },
      { bookingStatus: 'confirmed', nowMs: END },
      { bookingStatus: 'cancelled', nowMs: START },
      { bookingStatus: 'in_service', nowMs: END + MIN },
    ] as const;
    for (const c of cases) {
      const lapse = lapseOf({ ...c, endAtMs: END });
      expect(withdraw(c)).toEqual(
        lapse === null
          ? { kind: 'withdraw' }
          : { kind: 'refused', why: 'lapsed', lapse },
      );
    }
  });
});

describe('lapseOf: how a waiting request ends on its own', () => {
  it('keeps waiting while the booking is confirmed and not over', () => {
    expect(
      lapseOf({ bookingStatus: 'confirmed', endAtMs: END, nowMs: END - 1 }),
    ).toBeNull();
  });

  it('expires at the end time when nobody answered', () => {
    expect(
      lapseOf({ bookingStatus: 'confirmed', endAtMs: END, nowMs: END }),
    ).toEqual({
      to: 'expired',
      reason: 'Nobody answered before the booking ended.',
    });
  });

  it('closes when the booking moved on, naming what it became', () => {
    expect(
      lapseOf({ bookingStatus: 'checked_in', endAtMs: END, nowMs: START }),
    ).toEqual({
      to: 'closed',
      reason: 'The booking became checked_in before the desk answered.',
    });
  });

  it('closes rather than expires a booking that moved on and has ended', () => {
    // Checked in at the desk at 10:58, job runs at 11:01: not ignored.
    expect(
      lapseOf({ bookingStatus: 'in_service', endAtMs: END, nowMs: END + MIN }),
    ).toMatchObject({ to: 'closed' });
  });
});

describe('rejectionReason: a rejection always says why', () => {
  it('keeps the words, trimmed', () => {
    expect(rejectionReason('  Not at the salon ')).toBe('Not at the salon');
  });

  it.each([undefined, null, '', '   ', '\n\t'])('%j is no reason', (raw) => {
    expect(rejectionReason(raw)).toBeNull();
  });
});

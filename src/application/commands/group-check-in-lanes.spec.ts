import { describe, expect, it } from 'vitest';
import type { BookingError } from '@application/contract/errors';
import type { RaiseOutcome } from '@infrastructure/persistence/check-in-request.repository';
import { laneOutcome, type LaneOutcome } from './group-check-in-lanes';
import { raiseRefusalError, type RaiseRefused } from './check-in-refusal';

/** Any request row: laneOutcome passes it on and never reads it. */
const REQUEST = { id: 'req-1', state: 'waiting' } as never;

function refused(
  why: RaiseRefused['why'],
  bookingStatus: RaiseRefused['bookingStatus'],
  opensAtMs?: number,
): RaiseRefused {
  return {
    kind: 'refused',
    why,
    bookingStatus,
    ...(opensAtMs === undefined ? {} : { opensAtMs }),
  };
}

/**
 * The lane's error, or a failed test. Never `if (...) return`: a test that
 * returns early on the wrong outcome passes without checking anything.
 */
function errorOf(lane: LaneOutcome): BookingError {
  if (lane.outcome !== 'REFUSED') {
    throw new Error(`expected REFUSED, got ${lane.outcome}`);
  }
  return lane.error;
}

describe('laneOutcome', () => {
  it('raised: RAISED, with the very request raise made', () => {
    expect(laneOutcome({ kind: 'raised', request: REQUEST })).toStrictEqual({
      outcome: 'RAISED',
      request: REQUEST,
    });
  });

  it('already_waiting: WAITING, with the waiting request', () => {
    expect(
      laneOutcome({ kind: 'already_waiting', request: REQUEST }),
    ).toStrictEqual({ outcome: 'WAITING', request: REQUEST });
  });

  it.each(['checked_in', 'in_service', 'completed', 'settled'] as const)(
    'not_confirmed and %s: CHECKED_IN, the person already came',
    (status) => {
      expect(laneOutcome(refused('not_confirmed', status))).toStrictEqual({
        outcome: 'CHECKED_IN',
      });
    },
  );

  it.each([
    'cancelled',
    'no_show',
    'rescheduled',
    'expired',
    'skipped',
  ] as const)('not_confirmed and %s: LEFT', (status) => {
    expect(laneOutcome(refused('not_confirmed', status))).toStrictEqual({
      outcome: 'LEFT',
    });
  });

  it.each([
    'draft',
    'held',
    'pending_payment',
    'pending_confirmation',
  ] as const)(
    'not_confirmed and %s: REFUSED, BOOKING_STATE_INVALID',
    (status) => {
      expect(errorOf(laneOutcome(refused('not_confirmed', status))).code).toBe(
        'BOOKING_STATE_INVALID',
      );
    },
  );

  it.each([
    ['rejected_before', 'BOOKING_CHECKIN_REJECTED'],
    ['too_early', 'BOOKING_CHECKIN_WINDOW'],
    ['too_late', 'BOOKING_CHECKIN_WINDOW'],
  ] as const)('%s: REFUSED with %s', (why, code) => {
    expect(errorOf(laneOutcome(refused(why, 'confirmed', 0))).code).toBe(code);
  });

  it.each([
    refused('not_confirmed', 'draft'),
    refused('rejected_before', 'confirmed'),
    refused('too_early', 'confirmed', Date.UTC(2026, 9, 13, 9, 30)),
    refused('too_late', 'confirmed'),
  ])(
    'a REFUSED lane is told exactly what a single booking is told ($why)',
    (out) => {
      expect(errorOf(laneOutcome(out)).toBody()).toStrictEqual(
        raiseRefusalError(out).toBody(),
      );
    },
  );

  it('too_early keeps when check-in opens', () => {
    const opens = Date.UTC(2026, 9, 13, 9, 30);
    expect(
      errorOf(laneOutcome(refused('too_early', 'confirmed', opens))).details,
    ).toStrictEqual({ windowOpensAt: '2026-10-13T09:30:00.000Z' });
  });

  it.each<RaiseOutcome>([
    { kind: 'not_found' },
    { kind: 'chair_refused', refusal: {} as never },
  ])('$kind cannot happen for a lane: thrown, never hidden', (out) => {
    expect(() => laneOutcome(out)).toThrow(/cannot happen/);
  });
});

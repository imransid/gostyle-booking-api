import { describe, expect, it } from 'vitest';
import { bookingError, type ErrorCode } from '@application/contract/errors';
import type { LaneOutcome } from './group-check-in-lanes';
import { partyAnswer } from './group-check-in-party';

const RAISED: LaneOutcome = { outcome: 'RAISED', request: {} as never };
const WAITING: LaneOutcome = { outcome: 'WAITING', request: {} as never };
const IN: LaneOutcome = { outcome: 'CHECKED_IN' };
const LEFT: LaneOutcome = { outcome: 'LEFT' };
const refusedLane = (code: ErrorCode): LaneOutcome => ({
  outcome: 'REFUSED',
  error: bookingError(code, code),
});

describe('partyAnswer', () => {
  it('one lane raised among refusals: created', () => {
    expect(
      partyAnswer([refusedLane('BOOKING_CHECKIN_WINDOW'), RAISED, LEFT]),
    ).toStrictEqual({ kind: 'created' });
  });

  it('raised beats waiting: created', () => {
    expect(partyAnswer([WAITING, RAISED])).toStrictEqual({ kind: 'created' });
  });

  it('nothing raised, one waiting: waiting', () => {
    expect(partyAnswer([IN, WAITING, LEFT])).toStrictEqual({
      kind: 'waiting',
    });
  });

  it('every lane refused for one same reason: that refusal, the first lane', () => {
    const first = refusedLane('BOOKING_CHECKIN_WINDOW');
    const answer = partyAnswer([first, refusedLane('BOOKING_CHECKIN_WINDOW')]);
    expect(answer.kind).toBe('refused');
    expect(answer).toStrictEqual({
      kind: 'refused',
      error: (first as Extract<LaneOutcome, { outcome: 'REFUSED' }>).error,
    });
  });

  it.each<[string, LaneOutcome[]]>([
    [
      'refused for two reasons',
      [
        refusedLane('BOOKING_CHECKIN_WINDOW'),
        refusedLane('BOOKING_CHECKIN_REJECTED'),
      ],
    ],
    [
      'refused, and one already in',
      [refusedLane('BOOKING_CHECKIN_WINDOW'), IN],
    ],
    ['everyone already in', [IN, IN]],
    ['everyone gone', [LEFT, LEFT]],
    ['in and gone', [IN, LEFT]],
  ])('%s: none', (_name, lanes) => {
    expect(partyAnswer(lanes)).toStrictEqual({ kind: 'none' });
  });
});

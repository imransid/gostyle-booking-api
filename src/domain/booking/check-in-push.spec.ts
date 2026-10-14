import { describe, expect, it } from 'vitest';
import {
  CHECK_IN_ANSWER_EVENTS,
  answerOfEvent,
  checkInPushCopy,
  checkInPushEventId,
} from './check-in-push';

describe('check-in push: which answers are told', () => {
  it('maps each told answer to its event and back', () => {
    for (const [answer, type] of Object.entries(CHECK_IN_ANSWER_EVENTS)) {
      expect(answerOfEvent(type)).toBe(answer);
    }
  });

  it('tells nothing for any other event, closed and withdrawn included', () => {
    for (const type of [
      'booking.confirmed',
      'booking.checked_in',
      'check_in_request.closed',
      'check_in_request.withdrawn',
      '',
    ]) {
      expect(answerOfEvent(type)).toBeNull();
    }
  });

  it('one id per request and answer, so a re-delivery never buzzes twice', () => {
    expect(checkInPushEventId('req-1', 'approved')).toBe(
      'check-in:req-1:approved',
    );
    expect(checkInPushEventId('req-1', 'approved')).toBe(
      checkInPushEventId('req-1', 'approved'),
    );
    expect(checkInPushEventId('req-1', 'rejected')).not.toBe(
      checkInPushEventId('req-1', 'approved'),
    );
  });
});

describe('check-in push: what the phone reads', () => {
  const self = { kind: 'self' } as const;
  const rana = { kind: 'member', name: '  Rana Saleh ' } as const;
  const nobody = { kind: 'member', name: null } as const;
  const blank = { kind: 'member', name: '   ' } as const;

  it('your own check-in', () => {
    expect(
      checkInPushCopy({ answer: 'approved', code: 'GS-1417', subject: self }),
    ).toEqual({
      title: 'You are checked in',
      body: 'Welcome! Booking GS-1417.',
    });
    expect(
      checkInPushCopy({ answer: 'rejected', code: 'GS-1417', subject: self }),
    ).toEqual({
      title: 'Please speak to the desk',
      body: 'The salon could not confirm your arrival. Booking GS-1417.',
    });
    expect(
      checkInPushCopy({ answer: 'expired', code: 'GS-1417', subject: self }),
    ).toEqual({
      title: 'Please speak to the desk',
      body: 'The salon did not answer your check-in in time. Booking GS-1417.',
    });
  });

  it("a party member's, by name (trimmed)", () => {
    expect(
      checkInPushCopy({ answer: 'approved', code: 'GS-1418', subject: rana }),
    ).toEqual({
      title: 'Rana Saleh is checked in',
      body: 'Booking GS-1418.',
    });
    expect(
      checkInPushCopy({ answer: 'rejected', code: 'GS-1418', subject: rana })
        .body,
    ).toBe(
      "The salon could not confirm Rana Saleh's arrival. Booking GS-1418.",
    );
    expect(
      checkInPushCopy({ answer: 'expired', code: 'GS-1418', subject: rana })
        .body,
    ).toBe(
      "The salon did not answer Rana Saleh's check-in in time. Booking GS-1418.",
    );
  });

  it('a party member with no name, or a blank one', () => {
    for (const subject of [nobody, blank]) {
      expect(
        checkInPushCopy({ answer: 'approved', code: 'GS-1418', subject }).title,
      ).toBe('A member of your party is checked in');
      expect(
        checkInPushCopy({ answer: 'rejected', code: 'GS-1418', subject }).body,
      ).toBe(
        'The salon could not confirm the arrival of a member of your party. Booking GS-1418.',
      );
      expect(
        checkInPushCopy({ answer: 'expired', code: 'GS-1418', subject }).body,
      ).toBe(
        "The salon did not answer a party member's check-in in time. Booking GS-1418.",
      );
    }
  });
});

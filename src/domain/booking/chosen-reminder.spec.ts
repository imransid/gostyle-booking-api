import { describe, it, expect } from 'vitest';
import {
  TOO_LATE_MS,
  chosenVerdict,
  type ReminderChoice,
} from './chosen-reminder';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const START = Date.parse('2026-11-02T07:30:00Z');
const BOOKED = START - 3 * DAY;

const verdict = (
  nowMs: number,
  choice: ReminderChoice | null,
  touchedAtMs: number = BOOKED,
) => chosenVerdict({ startAtMs: START, touchedAtMs, nowMs, choice });

const lead = (leadMinutes: number, enabled = true): ReminderChoice => ({
  enabled,
  leadMinutes,
});

describe('chosenVerdict', () => {
  it.each([30, 60, 120, 1440])(
    'a %i minute lead goes at its time, not before',
    (m) => {
      expect(verdict(START - m * MIN - 1, lead(m))).toEqual({ kind: 'wait' });
      expect(verdict(START - m * MIN, lead(m))).toEqual({
        kind: 'send',
        leadMinutes: m,
        late: false,
      });
    },
  );

  it('a tick or two after its time is not late; an outage later is', () => {
    expect(verdict(START - HOUR + 2 * MIN, lead(60))).toMatchObject({
      late: false,
    });
    expect(verdict(START - HOUR + 20 * MIN, lead(60))).toMatchObject({
      kind: 'send',
      late: true,
    });
  });

  it('reminders off, or no such customer: nothing yet, asked again next tick', () => {
    expect(verdict(START - HOUR, lead(60, false))).toEqual({ kind: 'wait' });
    expect(verdict(START - HOUR, null)).toEqual({ kind: 'wait' });
  });

  it('a lead that is not one of the four is not acted on', () => {
    expect(verdict(START - HOUR, lead(45))).toEqual({ kind: 'wait' });
  });

  it('booked after the reminder time: passed over, the confirmation told them', () => {
    const bookedAt = START - 30 * MIN;
    expect(verdict(bookedAt + MIN, lead(60), bookedAt)).toEqual({
      kind: 'skip',
      leadMinutes: 60,
      reason: 'booked_late',
    });
  });

  it('moved after the reminder time: passed over, the move told them', () => {
    const movedAt = START - 10 * HOUR;
    expect(verdict(movedAt + MIN, lead(1440), movedAt)).toMatchObject({
      kind: 'skip',
      reason: 'booked_late',
    });
  });

  it('the time chosen earlier after it passed: sent at once', () => {
    // Booked 3 days ahead with "1 hour"; 10 hours before, changed to "1 day".
    expect(verdict(START - 10 * HOUR, lead(1440))).toEqual({
      kind: 'send',
      leadMinutes: 1440,
      late: true,
    });
  });

  it('within 15 minutes of the start it is too late', () => {
    expect(verdict(START - TOO_LATE_MS + 1, lead(30))).toEqual({
      kind: 'skip',
      leadMinutes: 30,
      reason: 'too_late',
    });
    // 30 minutes before is still in time for the 30 minute lead.
    expect(verdict(START - 30 * MIN, lead(30)).kind).toBe('send');
  });
});

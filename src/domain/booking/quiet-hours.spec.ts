import { describe, expect, it } from 'vitest';
import {
  QUIET_END_MIN,
  QUIET_START_MIN,
  whenToSend,
  withinQuietHours,
} from './quiet-hours';

describe('withinQuietHours', () => {
  it('is open across the trading day', () => {
    for (const m of [9 * 60, 12 * 60, 20 * 60 + 59]) {
      expect(withinQuietHours(m), `${m}`).toBe(false);
    }
  });

  it('is quiet late and early', () => {
    for (const m of [21 * 60, 23 * 60, 0, 8 * 60 + 59]) {
      expect(withinQuietHours(m), `${m}`).toBe(true);
    }
  });

  it('treats 09:00 as already open and 21:00 as already quiet', () => {
    // The boundaries are where an off-by-one wakes somebody up.
    expect(withinQuietHours(QUIET_END_MIN)).toBe(false);
    expect(withinQuietHours(QUIET_END_MIN - 1)).toBe(true);
    expect(withinQuietHours(QUIET_START_MIN)).toBe(true);
    expect(withinQuietHours(QUIET_START_MIN - 1)).toBe(false);
  });
});

describe('whenToSend', () => {
  it('sends during open hours', () => {
    expect(whenToSend(14 * 60)).toEqual({ kind: 'send' });
  });

  it('queues an early-morning send for 09:00 the same day', () => {
    const v = whenToSend(7 * 60);
    expect(v.kind).toBe('queued');
    if (v.kind !== 'queued') throw new Error('unreachable');
    expect(v.untilMin).toBe(QUIET_END_MIN);
    expect(v.dayOffset).toBe(0);
    expect(v.explanation).toContain('this morning');
  });

  it('queues a late-evening send for 09:00 TOMORROW', () => {
    // The one that is easy to get wrong: 22:30 must not queue for 09:00
    // today, which is thirteen hours in the past.
    const v = whenToSend(22 * 60 + 30);
    expect(v.kind).toBe('queued');
    if (v.kind !== 'queued') throw new Error('unreachable');
    expect(v.dayOffset).toBe(1);
    expect(v.explanation).toContain('tomorrow');
  });

  it('queues midnight for the same calendar day, not the next', () => {
    const v = whenToSend(0);
    expect(v.kind).toBe('queued');
    if (v.kind !== 'queued') throw new Error('unreachable');
    expect(v.dayOffset).toBe(0);
  });

  it('never queues to a time that is already past', () => {
    for (let m = 0; m < 24 * 60; m += 7) {
      const v = whenToSend(m);
      if (v.kind !== 'queued') continue;
      const target = v.dayOffset * 24 * 60 + v.untilMin;
      expect(target, `from ${m}`).toBeGreaterThan(m);
    }
  });
});

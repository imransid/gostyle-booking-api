import { describe, expect, it } from 'vitest';
import {
  cancelTiming,
  groupReasons,
  isEventKind,
  policyWindow,
  summarise,
} from './cancellation-feed';
import {
  cancellationOutcome,
  FREE_CANCEL_WINDOW_HOURS,
  LATE_CANCEL_WINDOW_HOURS,
} from './lifecycle';

const START = Date.parse('2026-09-18T12:00:00.000Z');
const hours = (n: number): number => START - n * 60 * 60 * 1000;

describe('cancelTiming', () => {
  it('bands a cancellation more than 24h out', () => {
    const t = cancelTiming({ occurredAtMs: hours(30), startAtMs: START });
    expect(t.band).toBe('more_than_24h');
    expect(t.lateCancel).toBe(false);
    expect(t.hoursBeforeStart).toBeCloseTo(30);
  });

  it('bands the middle window', () => {
    expect(
      cancelTiming({ occurredAtMs: hours(6), startAtMs: START }).band,
    ).toBe('24h_to_2h');
  });

  it('calls exactly T-2h the middle band, not a late cancel', () => {
    const t = cancelTiming({
      occurredAtMs: hours(LATE_CANCEL_WINDOW_HOURS),
      startAtMs: START,
    });
    expect(t.band).toBe('24h_to_2h');
    expect(t.lateCancel).toBe(false);
  });

  it('flags a late cancel inside the two-hour window', () => {
    const t = cancelTiming({ occurredAtMs: hours(1), startAtMs: START });
    expect(t.band).toBe('under_2h');
    expect(t.lateCancel).toBe(true);
  });

  it('handles a cancellation taken after the start', () => {
    const t = cancelTiming({ occurredAtMs: hours(-0.5), startAtMs: START });
    expect(t.hoursBeforeStart).toBeCloseTo(-0.5);
    expect(t.lateCancel).toBe(true);
  });

  it('agrees with the money rule on every boundary, so screen and refund cannot differ', () => {
    for (const h of [48, 24.1, 24, 12, 2.1, 2, 1.9, 0.5, 0, -1]) {
      const timing = cancelTiming({ occurredAtMs: hours(h), startAtMs: START });
      const money = cancellationOutcome({
        nowMs: hours(h),
        startAtMs: START,
        capturedFils: 5000,
        paidInFull: false,
        initiatedBy: 'customer',
      });
      expect(timing.lateCancel, `${h}h`).toBe(money.lateCancel);
      expect(timing.band, `${h}h`).toBe(money.band);
    }
  });
});

describe('policyWindow', () => {
  it('describes the window, never the free-text reason', () => {
    // GS-1264 rendered "Policy window: qa backfill test".
    const text = policyWindow({
      kind: 'CANCELLED',
      timing: cancelTiming({ occurredAtMs: hours(30), startAtMs: START }),
    });
    expect(text).toContain(`more than ${FREE_CANCEL_WINDOW_HOURS}h`);
    expect(text).not.toContain('qa backfill');
  });

  it('keeps the no-show wording, which was already right', () => {
    expect(
      policyWindow({
        kind: 'NO_SHOW',
        timing: cancelTiming({ occurredAtMs: hours(-1), startAtMs: START }),
      }),
    ).toBe('start + grace passed');
  });

  it('says minutes under an hour and hours above it', () => {
    expect(
      policyWindow({
        kind: 'CANCELLED',
        timing: cancelTiming({ occurredAtMs: hours(0.5), startAtMs: START }),
      }),
    ).toContain('30m before start');
    expect(
      policyWindow({
        kind: 'CANCELLED',
        timing: cancelTiming({ occurredAtMs: hours(3.5), startAtMs: START }),
      }),
    ).toContain('3.5h before start');
  });

  it('says so when the cancellation came after the start', () => {
    expect(
      policyWindow({
        kind: 'CANCELLED',
        timing: cancelTiming({ occurredAtMs: hours(-2), startAtMs: START }),
      }),
    ).toContain('after the start');
  });
});

describe('summarise', () => {
  it('counts lost value as the service value the salon did not get', () => {
    const s = summarise({
      events: 132,
      noShows: 27,
      serviceValueFils: 1_392_000,
      depositsKeptFils: 57_200,
      recovered: 4,
    });
    expect(s.lostValueFils).toBe(1_392_000 - 57_200);
    expect(s.events).toBe(132);
    expect(s.recovered).toBe(4);
  });

  it('never reports a negative loss', () => {
    expect(
      summarise({
        events: 1,
        noShows: 0,
        serviceValueFils: 1000,
        depositsKeptFils: 4000,
        recovered: 0,
      }).lostValueFils,
    ).toBe(0);
  });
});

describe('groupReasons', () => {
  it('groups, counts and totals, biggest first', () => {
    const rows = groupReasons([
      { reason: 'customer called', priceFils: 10_000 },
      { reason: 'Customer called', priceFils: 5_000 },
      { reason: 'stylist off sick', priceFils: 30_000 },
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      reason: 'customer called',
      count: 2,
      valueFils: 15_000,
    });
    expect(rows[1]?.reason).toBe('stylist off sick');
  });

  it('names an empty reason rather than dropping the row', () => {
    const rows = groupReasons([{ reason: null, priceFils: 100 }]);
    expect(rows[0]?.reason).toBe('No reason given');
  });
});

describe('isEventKind', () => {
  it('accepts the four the feed supports', () => {
    for (const k of ['ALL', 'CANCELLED', 'LATE_CANCEL', 'NO_SHOW']) {
      expect(isEventKind(k)).toBe(true);
    }
  });

  it('refuses a kind the feed cannot answer, instead of coercing it', () => {
    // `kind=BANANA` answered 200 with the CANCELLED rows.
    expect(isEventKind('BANANA')).toBe(false);
  });
});

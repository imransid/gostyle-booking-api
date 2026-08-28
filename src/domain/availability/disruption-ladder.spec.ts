import { describe, it, expect } from 'vitest';
import {
  repairDisruption,
  GOODWILL_PERCENT,
  DISRUPTION_SHIFT_STEPS_MIN,
  type DisruptedBooking,
  type DisruptionRequest,
} from './disruption-ladder';
import { partOfDay, samePartOfDay, PART_OF_DAY_MIN } from './grid';
import type { RepairCandidate } from './repair';

const AT = 900; // 15:00, an afternoon booking

const booking = (over: Partial<DisruptedBooking> = {}): DisruptedBooking => ({
  bookingId: 'b1',
  code: 'GS-1042',
  startMin: AT,
  durationMin: 45,
  staffId: 'maya',
  priceFils: 48_000,
  capturedFils: 24_000,
  ...over,
});

const cand = (startMin: number, staffId: string): RepairCandidate => ({
  startMin,
  staffId,
  durationMin: 45,
});

const req = (
  candidates: RepairCandidate[],
  over: Partial<DisruptedBooking> = {},
): DisruptionRequest => ({ booking: booking(over), candidates });

describe('parts of the day', () => {
  it('cuts the trading day into three four-hour blocks', () => {
    expect(PART_OF_DAY_MIN).toBe(240);
    expect(partOfDay(600)).toBe('morning'); // 10:00
    expect(partOfDay(839)).toBe('morning');
    expect(partOfDay(840)).toBe('afternoon'); // 14:00
    expect(partOfDay(1079)).toBe('afternoon');
    expect(partOfDay(1080)).toBe('evening'); // 18:00
    expect(partOfDay(1319)).toBe('evening');
  });

  it('agrees with itself', () => {
    expect(samePartOfDay(900, 1000)).toBe(true);
    expect(samePartOfDay(900, 1100)).toBe(false);
  });
});

describe('rung 1: the same minute, somebody else', () => {
  it('reassigns without moving the time', () => {
    const got = repairDisruption(req([cand(AT, 'anya')]));
    expect(got.kind).toBe('repaired');
    if (got.kind !== 'repaired') return;
    expect(got.rung).toBe('same_minute_other_professional');
    expect(got.offer.distanceMin).toBe(0);
    expect(got.customerImpact).toMatch(/None/);
  });

  it('NEVER hands the booking back to the professional going off', () => {
    // The whole point of the repair is that maya is unavailable.
    const got = repairDisruption(req([cand(AT, 'maya')]));
    expect(got.kind).toBe('propose_cancellation');
  });

  it('beats a shift', () => {
    const got = repairDisruption(
      req([cand(AT - 15, 'anya'), cand(AT, 'zara')]),
    );
    if (got.kind !== 'repaired') throw new Error('expected a repair');
    expect(got.offer.startMin).toBe(AT);
  });

  it('is deterministic when several are free', () => {
    const a = repairDisruption(req([cand(AT, 'zara'), cand(AT, 'anya')]));
    const b = repairDisruption(req([cand(AT, 'anya'), cand(AT, 'zara')]));
    if (a.kind !== 'repaired' || b.kind !== 'repaired') throw new Error('nope');
    expect(a.offer.staffId).toBe(b.offer.staffId);
  });
});

describe('rung 2: a small shift', () => {
  it('accepts 15, 30 and 45 minutes', () => {
    expect(DISRUPTION_SHIFT_STEPS_MIN).toEqual([15, 30, 45]);
    for (const step of [15, 30, 45]) {
      const got = repairDisruption(req([cand(AT + step, 'anya')]));
      if (got.kind !== 'repaired')
        throw new Error(`expected repair at ${step}`);
      expect(got.rung).toBe('small_shift');
    }
  });

  it('takes 45 where the series ladder would not', () => {
    // The series ladder stops at 30: there is a standing arrangement to
    // protect. Here there is only a day.
    const got = repairDisruption(req([cand(AT + 45, 'anya')]));
    expect(got.kind).toBe('repaired');
  });

  it('tries the nearest step first', () => {
    const got = repairDisruption(
      req([cand(AT + 45, 'anya'), cand(AT - 15, 'zara')]),
    );
    if (got.kind !== 'repaired') throw new Error('expected a repair');
    expect(got.offer.distanceMin).toBe(15);
  });

  it('says which way it moved', () => {
    const later = repairDisruption(req([cand(AT + 30, 'anya')]));
    const earlier = repairDisruption(req([cand(AT - 30, 'anya')]));
    if (later.kind !== 'repaired' || earlier.kind !== 'repaired')
      throw new Error('x');
    expect(later.explanation).toMatch(/30 minutes later/);
    expect(earlier.explanation).toMatch(/30 minutes earlier/);
  });
});

describe('rung 3: the same part of the day', () => {
  it('takes a start well away from the original, inside the block', () => {
    // 900 and 1020 are both afternoon; 120 minutes is past every shift step.
    const got = repairDisruption(req([cand(1020, 'anya')]));
    if (got.kind !== 'repaired') throw new Error('expected a repair');
    expect(got.rung).toBe('same_part_of_day');
    expect(got.explanation).toMatch(/still their afternoon/);
    expect(got.customerImpact).toMatch(/keeps their day/);
  });

  it('refuses a start in a different part of the day', () => {
    // 900 is afternoon, 1200 is evening.
    const got = repairDisruption(req([cand(1200, 'anya')]));
    expect(got.kind).toBe('propose_cancellation');
  });

  it('prefers the nearest inside the block', () => {
    const got = repairDisruption(req([cand(1040, 'far'), cand(1000, 'near')]));
    if (got.kind !== 'repaired') throw new Error('expected a repair');
    expect(got.offer.staffId).toBe('near');
  });
});

describe('rung 4: proposed, never applied', () => {
  it('proposes rather than repairing when nothing fits', () => {
    const got = repairDisruption(req([]));
    expect(got.kind).toBe('propose_cancellation');
  });

  it('refunds everything captured, unconditionally', () => {
    const got = repairDisruption(req([], { capturedFils: 24_000 }));
    if (got.kind !== 'propose_cancellation')
      throw new Error('expected proposal');
    expect(got.refundFils).toBe(24_000);
  });

  it('refunds nothing when nothing was captured', () => {
    const got = repairDisruption(req([], { capturedFils: 0 }));
    if (got.kind !== 'propose_cancellation')
      throw new Error('expected proposal');
    expect(got.refundFils).toBe(0);
  });

  it('adds a goodwill credit in whole dirhams', () => {
    const got = repairDisruption(req([], { priceFils: 48_000 }));
    if (got.kind !== 'propose_cancellation')
      throw new Error('expected proposal');
    // 10% of AED 480 is AED 48.
    expect(got.goodwillFils).toBe(4_800);
    expect(got.goodwillFils % 100).toBe(0);
    expect(GOODWILL_PERCENT).toBe(10);
  });

  it('rounds the goodwill to whole dirhams, never a stray fil', () => {
    const got = repairDisruption(req([], { priceFils: 47_777 }));
    if (got.kind !== 'propose_cancellation')
      throw new Error('expected proposal');
    expect(got.goodwillFils % 100).toBe(0);
  });

  it('puts the customer at the front of the queue for the window they wanted', () => {
    const got = repairDisruption(req([], { startMin: AT, durationMin: 45 }));
    if (got.kind !== 'propose_cancellation')
      throw new Error('expected proposal');
    expect(got.waitlistWindow).toEqual({ fromMin: AT, toMin: AT + 45 });
  });

  it('is honest about the impact', () => {
    const got = repairDisruption(req([]));
    expect(got.customerImpact).toMatch(/Significant/);
  });
});

describe('the ladder as a whole', () => {
  it('always explains itself', () => {
    const cases = [
      [cand(AT, 'a')],
      [cand(AT + 15, 'a')],
      [cand(1020, 'a')],
      [],
    ];
    for (const c of cases) {
      expect(repairDisruption(req(c)).explanation.length).toBeGreaterThan(15);
    }
  });

  it('prefers each rung over the one below it', () => {
    const all = [cand(AT, 'r1'), cand(AT + 15, 'r2'), cand(1020, 'r3')];
    const got = repairDisruption(req(all));
    if (got.kind !== 'repaired') throw new Error('expected a repair');
    expect(got.offer.staffId).toBe('r1');

    const withoutR1 = repairDisruption(req([all[1]!, all[2]!]));
    if (withoutR1.kind !== 'repaired') throw new Error('expected a repair');
    expect(withoutR1.offer.staffId).toBe('r2');
  });
});

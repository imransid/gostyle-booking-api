import { describe, it, expect } from 'vitest';
import {
  repairOccurrence,
  nearestAlternatives,
  MAX_ALTERNATIVES,
  type RepairRequest,
  type RepairCandidate,
} from './series-ladder';

const AT = 1080; // 18:00

const cand = (startMin: number, staffId: string): RepairCandidate => ({
  startMin,
  staffId,
  durationMin: 45,
});

const req = (over: Partial<RepairRequest> = {}): RepairRequest => ({
  originalStartMin: AT,
  incumbentStaffId: 'maya',
  candidates: [],
  daysAhead: 14,
  bookingHorizonDays: 90,
  ...over,
});

describe('rung 1: the same time with the incumbent', () => {
  it('takes it and considers nothing else', () => {
    const got = repairOccurrence(
      req({ candidates: [cand(AT, 'anya'), cand(AT, 'maya')] }),
    );
    expect(got.kind).toBe('repaired');
    if (got.kind !== 'repaired') return;
    expect(got.rung).toBe('same_time_same_professional');
    expect(got.offer.staffId).toBe('maya');
    expect(got.offer.distanceMin).toBe(0);
  });

  it('prefers it over a better-looking shift', () => {
    const got = repairOccurrence(
      req({ candidates: [cand(AT - 15, 'maya'), cand(AT, 'maya')] }),
    );
    if (got.kind !== 'repaired') throw new Error('expected a repair');
    expect(got.offer.startMin).toBe(AT);
  });
});

describe('rung 2: the same time with anyone else', () => {
  it('yields the professional to keep the hour', () => {
    const got = repairOccurrence(req({ candidates: [cand(AT, 'anya')] }));
    if (got.kind !== 'repaired') throw new Error('expected a repair');
    expect(got.rung).toBe('same_time_any_professional');
    expect(got.offer.keepsTime).toBe(true);
    expect(got.offer.keepsProfessional).toBe(false);
  });

  it('beats a shift that keeps the incumbent', () => {
    // The hour outranks the person. This is the line that separates the
    // series ladder from the disruption ladder.
    const got = repairOccurrence(
      req({ candidates: [cand(AT - 15, 'maya'), cand(AT, 'anya')] }),
    );
    if (got.kind !== 'repaired') throw new Error('expected a repair');
    expect(got.offer.startMin).toBe(AT);
    expect(got.offer.staffId).toBe('anya');
  });

  it('is deterministic when several professionals are free at the hour', () => {
    const a = repairOccurrence(
      req({ candidates: [cand(AT, 'zara'), cand(AT, 'anya')] }),
    );
    const b = repairOccurrence(
      req({ candidates: [cand(AT, 'anya'), cand(AT, 'zara')] }),
    );
    if (a.kind !== 'repaired' || b.kind !== 'repaired') throw new Error('nope');
    expect(a.offer.staffId).toBe(b.offer.staffId);
  });
});

describe('rung 3: a small shift', () => {
  it('accepts 15 minutes before the hour', () => {
    const got = repairOccurrence(req({ candidates: [cand(AT - 15, 'anya')] }));
    if (got.kind !== 'repaired') throw new Error('expected a repair');
    expect(got.rung).toBe('small_shift');
    expect(got.explanation).toMatch(/15 minutes earlier/);
  });

  it('accepts 15 minutes after the hour', () => {
    const got = repairOccurrence(req({ candidates: [cand(AT + 15, 'anya')] }));
    if (got.kind !== 'repaired') throw new Error('expected a repair');
    expect(got.explanation).toMatch(/15 minutes later/);
  });

  it('tries 15 before 30', () => {
    const got = repairOccurrence(
      req({ candidates: [cand(AT + 30, 'maya'), cand(AT - 15, 'anya')] }),
    );
    if (got.kind !== 'repaired') throw new Error('expected a repair');
    expect(got.offer.distanceMin).toBe(15);
  });

  it('prefers the incumbent within the same shift', () => {
    const got = repairOccurrence(
      req({ candidates: [cand(AT - 15, 'anya'), cand(AT + 15, 'maya')] }),
    );
    if (got.kind !== 'repaired') throw new Error('expected a repair');
    expect(got.offer.staffId).toBe('maya');
  });

  it('does not accept 45 minutes: that is not a small shift', () => {
    const got = repairOccurrence(req({ candidates: [cand(AT + 45, 'maya')] }));
    expect(got.kind).toBe('needs_attention');
  });
});

describe('rung 4: needs attention', () => {
  it('attaches up to three alternatives', () => {
    const got = repairOccurrence(
      req({
        candidates: [
          cand(AT + 45, 'maya'),
          cand(AT + 90, 'anya'),
          cand(AT - 120, 'dana'),
          cand(AT + 200, 'zara'),
        ],
      }),
    );
    expect(got.kind).toBe('needs_attention');
    if (got.kind !== 'needs_attention') return;
    expect(got.alternatives.length).toBe(MAX_ALTERNATIVES);
  });

  it('orders the alternatives by time for display', () => {
    const got = repairOccurrence(
      req({
        candidates: [
          cand(AT + 90, 'anya'),
          cand(AT - 120, 'dana'),
          cand(AT + 45, 'maya'),
        ],
      }),
    );
    if (got.kind !== 'needs_attention') throw new Error('expected attention');
    const starts = got.alternatives.map((a) => a.startMin);
    expect([...starts].sort((x, y) => x - y)).toEqual(starts);
  });

  it('says so plainly when the day has nothing at all', () => {
    const got = repairOccurrence(req({ candidates: [] }));
    if (got.kind !== 'needs_attention') throw new Error('expected attention');
    expect(got.alternatives).toEqual([]);
    expect(got.explanation).toMatch(/at risk/);
  });
});

describe('the alternatives are genuinely different choices', () => {
  it('spaces them apart rather than offering one half hour three times', () => {
    const offers = repairOccurrence(
      req({
        candidates: [
          cand(AT + 45, 'a'),
          cand(AT + 50, 'b'),
          cand(AT + 55, 'c'),
          cand(AT + 180, 'd'),
        ],
      }),
    );
    if (offers.kind !== 'needs_attention')
      throw new Error('expected attention');
    const starts = offers.alternatives.map((a) => a.startMin);
    for (let i = 1; i < starts.length; i += 1) {
      expect((starts[i] ?? 0) - (starts[i - 1] ?? 0)).toBeGreaterThanOrEqual(
        25,
      );
    }
  });

  it('picks the nearest first when spacing allows', () => {
    const chosen = nearestAlternatives([
      {
        startMin: AT + 200,
        staffId: 'd',
        rung: 'nearest_in_day',
        distanceMin: 200,
        keepsTime: false,
        keepsProfessional: false,
      },
      {
        startMin: AT + 45,
        staffId: 'a',
        rung: 'nearest_in_day',
        distanceMin: 45,
        keepsTime: false,
        keepsProfessional: false,
      },
    ]);
    expect(chosen[0]?.startMin).toBe(AT + 45);
  });
});

describe('beyond the booking horizon', () => {
  it('defers rather than guessing', () => {
    const got = repairOccurrence(
      req({ daysAhead: 120, candidates: [cand(AT, 'maya')] }),
    );
    expect(got.kind).toBe('deferred');
    if (got.kind !== 'deferred') return;
    expect(got.explanation).toMatch(/nightly materialiser/);
  });

  it('repairs normally right up to the horizon', () => {
    const got = repairOccurrence(
      req({ daysAhead: 90, candidates: [cand(AT, 'maya')] }),
    );
    expect(got.kind).toBe('repaired');
  });
});

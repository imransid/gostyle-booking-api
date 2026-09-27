import { describe, it, expect } from 'vitest';
import {
  keepPlan,
  movableSessions,
  pauseFrom,
  resumeFrom,
  stayingDays,
} from './mobile-series-move';
import type { SessionFacts } from './mobile-series';

const NOW = Date.parse('2026-10-01T09:00:00+06:00');
const HOUR = 3_600_000;

const fact = (
  id: string,
  index: number,
  day: string,
  startAtMs: number,
  bookingStatus: string | null,
  state: string,
): SessionFacts =>
  ({
    id,
    index,
    day,
    startAtMs,
    state,
    bookingStatus,
    noShowBy: null,
  }) as unknown as SessionFacts;

const FACTS = [
  fact('done', 0, '2026-09-22', NOW - 200 * HOUR, 'completed', 'materialised'),
  fact('soon', 1, '2026-10-01', NOW + 2 * HOUR, 'confirmed', 'materialised'),
  fact('later', 3, '2026-10-20', NOW + 460 * HOUR, 'confirmed', 'materialised'),
  fact('skipped', 2, '2026-10-13', NOW + 290 * HOUR, null, 'skipped'),
  fact('far', 4, '2027-01-05', NOW + 2300 * HOUR, null, 'planned'),
];

describe('movableSessions: what a PAUSE or RESUME moves (step 7)', () => {
  it('takes the sessions still to come past the 24 hour lock, booked or not, in order', () => {
    expect(movableSessions(FACTS, NOW).map((f) => f.id)).toEqual([
      'later',
      'far',
    ]);
  });

  it('leaves the ones inside the lock where they are', () => {
    expect(stayingDays(FACTS, new Set(['later', 'far']))).toEqual([
      '2026-10-01',
    ]);
  });
});

describe('where a move starts (step 7)', () => {
  it('a pause restarts on the resume date', () => {
    expect(pauseFrom('2026-11-10', '2026-10-20', [])).toBe('2026-11-10');
  });

  it('a pause never brings a visit closer', () => {
    expect(pauseFrom('2026-10-05', '2026-10-20', [])).toBe('2026-10-20');
  });

  it('a pause lands after the sessions that stay', () => {
    expect(pauseFrom('2026-10-02', null, ['2026-10-02'])).toBe('2026-10-03');
  });

  it('a resume restarts tomorrow, after the sessions that stay', () => {
    expect(resumeFrom('2026-10-01', [])).toBe('2026-10-02');
    expect(resumeFrom('2026-10-01', ['2026-10-02'])).toBe('2026-10-03');
  });
});

describe('keepPlan: which bookings a move keeps (step 7)', () => {
  const at = (
    bookingId: string | null,
    day: string,
    startMin = 660,
    staffId: string | null = 'ethan',
  ) => ({ bookingId, day, startMin, staffId });
  const to = (day: string, startMin = 660, staffId = 'ethan') => ({
    day,
    startMin,
    staffId,
  });

  it('keeps a booking already on a new slot, and releases the others', () => {
    const plan = keepPlan(
      [
        at('B17', '2026-11-17'),
        at('B24', '2026-11-24'),
        at('B01', '2026-12-01'),
        at('B08', '2026-12-08'),
      ],
      [to('2026-12-01'), to('2026-12-08'), to('2026-12-15'), to('2026-12-22')],
    );
    expect([...plan.keep.entries()]).toEqual([
      [0, 'B01'],
      [1, 'B08'],
    ]);
    expect(plan.release).toEqual(['B17', 'B24']);
  });

  it('keeps nothing when the time or the stylist changes', () => {
    const plan = keepPlan([at('B01', '2026-12-01')], [to('2026-12-01', 900)]);
    expect(plan.keep.size).toBe(0);
    expect(plan.release).toEqual(['B01']);
    const other = keepPlan(
      [at('B01', '2026-12-01')],
      [to('2026-12-01', 660, 'maya')],
    );
    expect(other.keep.size).toBe(0);
  });

  it('a session with nothing booked yet has nothing to keep or release', () => {
    const plan = keepPlan(
      [at(null, '2027-01-05', 660, null)],
      [to('2027-01-05')],
    );
    expect(plan.keep.size).toBe(0);
    expect(plan.release).toEqual([]);
  });

  it('keeps one booking once, even for two slots on its day', () => {
    const plan = keepPlan(
      [at('B01', '2026-12-01')],
      [to('2026-12-01'), to('2026-12-01')],
    );
    expect([...plan.keep.entries()]).toEqual([[0, 'B01']]);
  });
});

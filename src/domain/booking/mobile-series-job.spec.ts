import { describe, it, expect } from 'vitest';
import {
  allClosed,
  reminderDue,
  reminderEventId,
  resumeDue,
} from './mobile-series-job';
import type { SessionFacts } from './mobile-series';

const NOW = Date.parse('2026-10-01T09:00:00+06:00');
const HOUR = 3_600_000;

const visit = (
  startAtMs: number,
  bookingStatus: string | null = 'confirmed',
  state = bookingStatus === null ? 'planned' : 'materialised',
): SessionFacts =>
  ({
    id: 'occ',
    index: 0,
    day: '2026-10-02',
    startAtMs,
    state,
    bookingStatus,
    noShowBy: null,
  }) as unknown as SessionFacts;

describe('reminderDue: the 48 hour reminder (step 8, R10)', () => {
  it('is due for a booked visit starting within 48 hours', () => {
    expect(reminderDue(visit(NOW + 47 * HOUR), NOW)).toBe(true);
    expect(reminderDue(visit(NOW + 48 * HOUR), NOW)).toBe(true);
  });

  it('is not due further ahead, nor for a visit that already started', () => {
    expect(reminderDue(visit(NOW + 49 * HOUR), NOW)).toBe(false);
    expect(reminderDue(visit(NOW - HOUR), NOW)).toBe(false);
  });

  it('is never due for a visit with nothing booked, or a closed one', () => {
    expect(reminderDue(visit(NOW + 10 * HOUR, null), NOW)).toBe(false);
    expect(reminderDue(visit(NOW + 10 * HOUR, 'cancelled'), NOW)).toBe(false);
    expect(
      reminderDue(visit(NOW + 10 * HOUR, 'confirmed', 'skipped'), NOW),
    ).toBe(false);
  });
});

describe('reminderEventId: one reminder per visit, whoever writes it', () => {
  it('is the same for the same visit and start, and shaped like a UUID', () => {
    const a = reminderEventId('occ-1', NOW);
    expect(reminderEventId('occ-1', NOW)).toBe(a);
    expect(a).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('changes when the visit moves, or for another visit', () => {
    const a = reminderEventId('occ-1', NOW);
    expect(reminderEventId('occ-1', NOW + HOUR)).not.toBe(a);
    expect(reminderEventId('occ-2', NOW)).not.toBe(a);
  });
});

describe('allClosed: when a routine is completed (step 8)', () => {
  it('is true when every visit is done, skipped or cancelled', () => {
    expect(
      allClosed([
        visit(NOW - 200 * HOUR, 'completed'),
        visit(NOW + 100 * HOUR, 'confirmed', 'skipped'),
        visit(NOW + 200 * HOUR, 'cancelled'),
      ]),
    ).toBe(true);
  });

  it('is false while one visit is still to come, or with no visits', () => {
    expect(
      allClosed([visit(NOW - 200 * HOUR, 'completed'), visit(NOW + HOUR)]),
    ).toBe(false);
    expect(allClosed([])).toBe(false);
  });
});

describe('resumeDue: a pause ends by itself on its date (step 8)', () => {
  it('ends on or after the date, never before', () => {
    expect(resumeDue('2026-10-01', '2026-10-01')).toBe(true);
    expect(resumeDue('2026-09-30', '2026-10-01')).toBe(true);
    expect(resumeDue('2026-10-02', '2026-10-01')).toBe(false);
  });

  it('never ends a pause with no date (two misses)', () => {
    expect(resumeDue(null, '2026-10-01')).toBe(false);
  });
});

import { describe, it, expect } from 'vitest';
import {
  horizonDue,
  needsActionEventId,
  reminderEventId,
} from './mobile-series-job';
import type { SessionFacts } from './mobile-series';

const NOW = Date.parse('2026-10-01T09:00:00+06:00');

const visit = (
  day: string,
  state = 'planned',
  bookingStatus: string | null = null,
): SessionFacts =>
  ({
    id: 'occ',
    index: 3,
    day,
    startAtMs: Date.parse(`${day}T11:00:00+06:00`),
    state,
    bookingStatus,
    noShowBy: null,
  }) as unknown as SessionFacts;

describe('horizonDue: a far-off visit the diary now reaches (step 8c)', () => {
  it('is due once within 90 days, while nothing is booked', () => {
    expect(horizonDue(visit('2026-12-20'), NOW, '2026-10-01')).toBe(true);
  });

  it('is not due while still past the 90 days', () => {
    expect(horizonDue(visit('2027-01-15'), NOW, '2026-10-01')).toBe(false);
  });

  it('is never due for a booked visit, a "needs action" one, or a past one', () => {
    expect(
      horizonDue(
        visit('2026-12-20', 'materialised', 'confirmed'),
        NOW,
        '2026-10-01',
      ),
    ).toBe(false);
    expect(
      horizonDue(visit('2026-12-20', 'needs_attention'), NOW, '2026-10-01'),
    ).toBe(false);
    expect(horizonDue(visit('2026-09-30'), NOW, '2026-10-01')).toBe(false);
  });
});

describe('needsActionEventId: one "needs action" event per visit and day', () => {
  it('is the same for the same visit and day, and not a reminder id', () => {
    const a = needsActionEventId('occ-1', '2026-12-20');
    expect(needsActionEventId('occ-1', '2026-12-20')).toBe(a);
    expect(needsActionEventId('occ-1', '2026-12-27')).not.toBe(a);
    expect(a).not.toBe(reminderEventId('occ-1', NOW));
    expect(a).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});

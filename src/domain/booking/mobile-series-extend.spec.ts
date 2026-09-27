import { describe, it, expect } from 'vitest';
import {
  customExtendRefusal,
  lastDay,
  nextIndex,
} from './mobile-series-manage';

describe('EXTEND helpers (step 6)', () => {
  it('numbers the new sessions after the last one', () => {
    expect(nextIndex([0, 1, 3, 2])).toBe(4);
    expect(nextIndex([])).toBe(0);
  });

  it('counts on from the latest day, wherever it sits in the list', () => {
    expect(lastDay(['2026-11-10', '2026-11-17', '2026-11-03'])).toBe(
      '2026-11-17',
    );
    expect(lastDay([])).toBeNull();
  });

  it('refuses a CUSTOM day that is not after today', () => {
    const why = customExtendRefusal(
      ['2026-12-01', '2026-10-01'],
      '2026-10-01',
      new Set(),
    );
    expect(why).toEqual(
      expect.objectContaining({ field: 'dates[1]', code: 'date_out_of_range' }),
    );
  });

  it('refuses a CUSTOM day the routine already has', () => {
    const why = customExtendRefusal(
      ['2026-11-10'],
      '2026-10-01',
      new Set(['2026-11-10']),
    );
    expect(why).toEqual(
      expect.objectContaining({ field: 'dates[0]', code: 'session_day_taken' }),
    );
  });

  it('accepts days still to come and free of the routine', () => {
    expect(
      customExtendRefusal(
        ['2026-12-01'],
        '2026-10-01',
        new Set(['2026-11-10']),
      ),
    ).toBeNull();
  });
});

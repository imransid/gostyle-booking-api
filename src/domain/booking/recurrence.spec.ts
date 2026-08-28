import { describe, it, expect } from 'vitest';
import {
  expandSeries,
  addDays,
  weekdayOf,
  daysBetween,
  daysInMonth,
  SERIES_HORIZON_DAYS,
  type SeriesDefinition,
} from './recurrence';

// 2026-09-01 is a Tuesday. Every date below is anchored off that.
const TUE = '2026-09-01';

const series = (over: Partial<SeriesDefinition> = {}): SeriesDefinition => ({
  anchor: TUE,
  startMin: 1080, // 18:00
  pattern: { kind: 'weekly', weekdays: [2, 4] },
  end: { kind: 'never' },
  ...over,
});

const dates = (d: SeriesDefinition, from = TUE, horizonDays?: number) =>
  expandSeries(d, { from, horizonDays }).occurrences.map((o) => o.date);

describe('the calendar', () => {
  it('knows the anchor is a Tuesday', () => {
    expect(weekdayOf(TUE)).toBe(2);
  });

  it('adds and subtracts days across a month boundary', () => {
    expect(addDays('2026-09-30', 1)).toBe('2026-10-01');
    expect(addDays('2026-10-01', -1)).toBe('2026-09-30');
  });

  it('crosses a year boundary', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });

  it('measures the distance between two days', () => {
    expect(daysBetween('2026-09-01', '2026-09-11')).toBe(10);
    expect(daysBetween('2026-09-11', '2026-09-01')).toBe(-10);
  });

  it('knows how long each month is, February included', () => {
    expect(daysInMonth(2026, 2)).toBe(28);
    expect(daysInMonth(2028, 2)).toBe(29); // a leap year
    expect(daysInMonth(2026, 9)).toBe(30);
    expect(daysInMonth(2026, 12)).toBe(31);
  });

  it('rejects a string that is not a trading day', () => {
    expect(() => addDays('1 September', 1)).toThrow(/Not a trading day/);
  });
});

describe('every week on selected days', () => {
  it('lands on each selected weekday, in order', () => {
    // Tue 1st, Thu 3rd, Tue 8th, Thu 10th...
    expect(dates(series(), TUE, 14)).toEqual([
      '2026-09-01',
      '2026-09-03',
      '2026-09-08',
      '2026-09-10',
      '2026-09-15',
    ]);
  });

  it('never emits a date before the anchor', () => {
    // The anchor is a Tuesday but Monday is also selected: the Monday of the
    // anchor's own week is in the past and must not appear.
    const d = series({ pattern: { kind: 'weekly', weekdays: [1, 2] } });
    expect(dates(d, TUE, 8)[0]).toBe('2026-09-01');
  });

  it('deduplicates and sorts the selected days', () => {
    const d = series({ pattern: { kind: 'weekly', weekdays: [4, 2, 4] } });
    expect(dates(d, TUE, 7)).toEqual([
      '2026-09-01',
      '2026-09-03',
      '2026-09-08',
    ]);
  });

  it('produces nothing when no day is selected', () => {
    const d = series({ pattern: { kind: 'weekly', weekdays: [] } });
    expect(dates(d)).toEqual([]);
  });
});

describe('every N weeks', () => {
  it('steps N weeks from the anchor, keeping its weekday', () => {
    const d = series({
      anchor: '2026-09-05', // a Saturday
      pattern: { kind: 'every_n_weeks', weeks: 6 },
    });
    const got = dates(d, '2026-09-05', 90);
    expect(got).toEqual(['2026-09-05', '2026-10-17', '2026-11-28']);
    expect(got.every((x) => weekdayOf(x) === 6)).toBe(true);
  });

  it('treats every_n_weeks with weeks = 1 as plain weekly', () => {
    const d = series({ pattern: { kind: 'every_n_weeks', weeks: 1 } });
    expect(dates(d, TUE, 21)).toEqual([
      '2026-09-01',
      '2026-09-08',
      '2026-09-15',
      '2026-09-22',
    ]);
  });

  it('produces nothing for a zero or negative step', () => {
    const d = series({ pattern: { kind: 'every_n_weeks', weeks: 0 } });
    expect(dates(d)).toEqual([]);
  });
});

describe('every month on a date', () => {
  it('lands on the same date each month', () => {
    const d = series({
      anchor: '2026-09-15',
      pattern: { kind: 'monthly_on_date', dayOfMonth: 15 },
    });
    expect(dates(d, '2026-09-15', 70)).toEqual([
      '2026-09-15',
      '2026-10-15',
      '2026-11-15',
    ]);
  });

  it('falls back to the last day of a shorter month', () => {
    // The 31st: September has 30 days, November has 30, February has 28.
    const d = series({
      anchor: '2026-08-31',
      pattern: { kind: 'monthly_on_date', dayOfMonth: 31 },
    });
    expect(dates(d, '2026-08-31', 100)).toEqual([
      '2026-08-31',
      '2026-09-30',
      '2026-10-31',
      '2026-11-30',
    ]);
  });

  it('marks the moved occurrences and leaves the others unmarked', () => {
    const d = series({
      anchor: '2026-08-31',
      pattern: { kind: 'monthly_on_date', dayOfMonth: 31 },
    });
    const got = expandSeries(d, { from: '2026-08-31', horizonDays: 100 });
    expect(got.occurrences.map((o) => [o.date, o.movedFromDayOfMonth])).toEqual(
      [
        ['2026-08-31', null],
        ['2026-09-30', 31],
        ['2026-10-31', null],
        ['2026-11-30', 31],
      ],
    );
  });

  it('says so in the explanation when occurrences were moved', () => {
    const d = series({
      anchor: '2026-08-31',
      pattern: { kind: 'monthly_on_date', dayOfMonth: 31 },
    });
    const got = expandSeries(d, { from: '2026-08-31', horizonDays: 100 });
    expect(got.explanation).toMatch(/moved to the last day of a shorter month/);
  });

  it('crosses into the next year', () => {
    const d = series({
      anchor: '2026-11-15',
      pattern: { kind: 'monthly_on_date', dayOfMonth: 15 },
    });
    expect(dates(d, '2026-11-15', 70)).toEqual([
      '2026-11-15',
      '2026-12-15',
      '2027-01-15',
    ]);
  });

  it('produces nothing for a day of month outside 1..31', () => {
    const d = series({ pattern: { kind: 'monthly_on_date', dayOfMonth: 32 } });
    expect(dates(d)).toEqual([]);
  });
});

describe('custom dates', () => {
  it('takes the hand-picked list, sorted and deduplicated', () => {
    const d = series({
      pattern: {
        kind: 'custom',
        dates: ['2026-09-20', '2026-09-04', '2026-09-20'],
      },
    });
    expect(dates(d, TUE, 60)).toEqual(['2026-09-04', '2026-09-20']);
  });

  it('drops dates before the anchor', () => {
    const d = series({
      pattern: { kind: 'custom', dates: ['2026-08-01', '2026-09-04'] },
    });
    expect(dates(d, TUE, 60)).toEqual(['2026-09-04']);
  });

  it('is complete once the list is exhausted', () => {
    const d = series({
      pattern: { kind: 'custom', dates: ['2026-09-04', '2026-09-20'] },
    });
    expect(expandSeries(d, { from: TUE, horizonDays: 60 }).complete).toBe(true);
  });
});

describe('end conditions', () => {
  it('ends after a count, and counts from the anchor not the window', () => {
    const d = series({ end: { kind: 'after_count', count: 3 } });
    expect(dates(d, TUE, 70)).toEqual([
      '2026-09-01',
      '2026-09-03',
      '2026-09-08',
    ]);
  });

  it('keeps the ordinal honest when the window opens mid-series', () => {
    // Topping up months later must not restart the count at zero.
    const d = series({ end: { kind: 'after_count', count: 5 } });
    const got = expandSeries(d, { from: '2026-09-08', horizonDays: 70 });
    expect(got.occurrences.map((o) => [o.date, o.index])).toEqual([
      ['2026-09-08', 2],
      ['2026-09-10', 3],
      ['2026-09-15', 4],
    ]);
    expect(got.complete).toBe(true);
  });

  it('ends on a date, inclusive of that date', () => {
    const d = series({ end: { kind: 'on_date', date: '2026-09-08' } });
    expect(dates(d, TUE, 70)).toEqual([
      '2026-09-01',
      '2026-09-03',
      '2026-09-08',
    ]);
  });

  it('reports an ended series as complete', () => {
    const d = series({ end: { kind: 'on_date', date: '2026-09-08' } });
    expect(expandSeries(d, { from: TUE, horizonDays: 70 }).complete).toBe(true);
  });

  it('reports an open-ended series as incomplete, never infinite', () => {
    const got = expandSeries(series(), { from: TUE });
    expect(got.complete).toBe(false);
    // Ten whole weeks of Tue+Thu, plus the Tuesday that lands exactly on the
    // horizon line. The line is inclusive, which is why it is 21 and not 20.
    expect(got.occurrences.length).toBe(21);
    expect(got.occurrences.at(-1)?.date).toBe('2026-11-10');
    expect(got.horizonEnd).toBe('2026-11-10');
  });
});

describe('the horizon', () => {
  it('defaults to seventy days and reports the line', () => {
    const got = expandSeries(series(), { from: TUE });
    expect(got.horizonEnd).toBe(addDays(TUE, SERIES_HORIZON_DAYS));
  });

  it('never returns anything beyond the horizon', () => {
    const got = expandSeries(series(), { from: TUE });
    for (const o of got.occurrences) {
      expect(o.date <= got.horizonEnd).toBe(true);
    }
  });

  it('counts but does not return occurrences before the window', () => {
    // The nightly top-up asks for the tail only; the ordinals must not shift.
    const got = expandSeries(series(), { from: '2026-10-01' });
    // 2026-10-01 is a Thursday, the tenth occurrence of the series.
    expect(got.occurrences[0]?.date).toBe('2026-10-01');
    expect(got.occurrences[0]?.index).toBe(9);
  });

  it('carries the start minute onto every occurrence', () => {
    const got = expandSeries(series({ startMin: 900 }), { from: TUE });
    expect(got.occurrences.every((o) => o.startMin === 900)).toBe(true);
  });

  it('returns an empty, incomplete expansion when the window is far past the tail', () => {
    const d = series({ end: { kind: 'on_date', date: '2026-09-08' } });
    const got = expandSeries(d, { from: '2027-01-01' });
    expect(got.occurrences).toEqual([]);
    expect(got.complete).toBe(true);
  });
});

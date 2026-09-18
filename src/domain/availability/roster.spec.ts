import { describe, expect, it } from 'vitest';
import {
  clockToMinute,
  parseOffDays,
  toProfessional,
  weekdayOf,
  type RosterCandidate,
} from './roster';
import { DAY_END_MIN, DAY_START_MIN } from './grid';

const BRANCH = { startMin: DAY_START_MIN, endMin: DAY_END_MIN };

function stylist(over: Partial<RosterCandidate> = {}): RosterCandidate {
  return {
    id: '50dcbb8f-c863-47a0-9f29-6dd5fb41da1c',
    name: 'Rima A.',
    active: true,
    openingTime: '10:00:00',
    closingTime: '20:00:00',
    offday: null,
    ...over,
  };
}

describe('clockToMinute', () => {
  it('reads both spellings platform sends', () => {
    expect(clockToMinute('09:30')).toBe(570);
    expect(clockToMinute('09:30:00')).toBe(570);
  });

  it('accepts 24:00 as the far end of a day, and nothing past it', () => {
    expect(clockToMinute('24:00')).toBe(1440);
    expect(clockToMinute('24:30')).toBeNull();
    expect(clockToMinute('25:00')).toBeNull();
  });

  it('refuses what is not a time rather than coercing it', () => {
    for (const bad of ['', '  ', '9', 'morning', '09:60', '09-30', null]) {
      expect(clockToMinute(bad)).toBeNull();
    }
  });
});

describe('weekdayOf', () => {
  it('reads the trading day as a date, not an instant', () => {
    // 2026-09-21 is a Monday. Anywhere west of Greenwich, a Date built from
    // this string and read with getDay() would answer Sunday.
    expect(weekdayOf('2026-09-21')).toBe('monday');
    expect(weekdayOf('2026-09-18')).toBe('friday');
  });

  it('refuses a date that does not exist', () => {
    expect(weekdayOf('2026-02-30')).toBeNull();
    expect(weekdayOf('2026-13-01')).toBeNull();
    expect(weekdayOf('21-09-2026')).toBeNull();
    expect(weekdayOf('')).toBeNull();
  });
});

describe('parseOffDays', () => {
  it('reads every spelling that has actually arrived', () => {
    expect(parseOffDays('SUNDAY').days).toEqual(['sunday']);
    expect(parseOffDays('Sun').days).toEqual(['sunday']);
    expect(parseOffDays('Friday, Saturday').days).toEqual([
      'friday',
      'saturday',
    ]);
  });

  it('will not guess from one letter', () => {
    // "s" is Sunday and Saturday equally. A prefix match would pick one.
    const { days, unparsed } = parseOffDays('S');
    expect(days).toEqual([]);
    expect(unparsed).toEqual(['S']);
  });

  it('hands back what it could not read instead of calling it none', () => {
    const { days, unparsed } = parseOffDays('Sunday, holidays');
    expect(days).toEqual(['sunday']);
    expect(unparsed).toEqual(['holidays']);
  });

  it('is empty, not wrong, for nothing at all', () => {
    expect(parseOffDays(null)).toEqual({ days: [], unparsed: [] });
    expect(parseOffDays('')).toEqual({ days: [], unparsed: [] });
  });

  it('does not list a day twice', () => {
    expect(parseOffDays('Sunday Sun SUNDAY').days).toEqual(['sunday']);
  });
});

describe('toProfessional', () => {
  it('rosters an active stylist on their published hours', () => {
    const v = toProfessional(stylist(), BRANCH, '2026-09-21');

    expect(v.kind).toBe('rostered');
    if (v.kind !== 'rostered') return;
    expect(v.shiftFrom).toBe('stylist');
    expect(v.professional.shift).toEqual({ startMin: 600, endMin: 1200 });
    expect(v.professional.id).toBe(stylist().id);
  });

  it('keeps the platform id exactly as it arrived', () => {
    // The whole bug this file exists for: the id the app sends must be the
    // id the engine matches on (CLAUDE.md 8).
    const v = toProfessional(stylist({ id: 'ABC-123' }), BRANCH, '2026-09-21');
    if (v.kind !== 'rostered') throw new Error('expected rostered');
    expect(v.professional.id).toBe('ABC-123');
  });

  it('drops an inactive stylist', () => {
    expect(
      toProfessional(stylist({ active: false }), BRANCH, '2026-09-21'),
    ).toEqual({ kind: 'inactive' });
  });

  it('drops a stylist on their day off', () => {
    const v = toProfessional(
      stylist({ offday: 'Monday' }),
      BRANCH,
      '2026-09-21',
    );
    expect(v).toEqual({ kind: 'off_today', weekday: 'monday' });
  });

  it('rosters them on every other day', () => {
    const v = toProfessional(
      stylist({ offday: 'Monday' }),
      BRANCH,
      '2026-09-22',
    );
    expect(v.kind).toBe('rostered');
  });

  it('falls back to the branch window when hours are missing', () => {
    const v = toProfessional(
      stylist({ openingTime: null, closingTime: null }),
      BRANCH,
      '2026-09-21',
    );
    if (v.kind !== 'rostered') throw new Error('expected rostered');
    expect(v.shiftFrom).toBe('branch');
    expect(v.professional.shift).toEqual(BRANCH);
  });

  it('will not pair one real boundary with one invented one', () => {
    const v = toProfessional(
      stylist({ closingTime: null }),
      BRANCH,
      '2026-09-21',
    );
    if (v.kind !== 'rostered') throw new Error('expected rostered');
    expect(v.shiftFrom).toBe('branch');
    expect(v.professional.shift).toEqual(BRANCH);
  });

  it('refuses a shift that ends before it starts', () => {
    const v = toProfessional(
      stylist({ openingTime: '20:00', closingTime: '10:00' }),
      BRANCH,
      '2026-09-21',
    );
    if (v.kind !== 'rostered') throw new Error('expected rostered');
    expect(v.shiftFrom).toBe('branch');
  });

  it('holds no skills, so a fixture service refuses them by name', () => {
    const v = toProfessional(stylist(), BRANCH, '2026-09-21');
    if (v.kind !== 'rostered') throw new Error('expected rostered');
    expect(v.professional.skills.size).toBe(0);
  });

  it('never grants overlap to somebody we know nothing about', () => {
    const v = toProfessional(stylist(), BRANCH, '2026-09-21');
    if (v.kind !== 'rostered') throw new Error('expected rostered');
    expect(v.professional.overlapAllowed).toBe(false);
    expect(v.professional.bookingsToday).toBe(0);
  });

  it('falls back to the id when platform sent no name', () => {
    const v = toProfessional(stylist({ name: '  ' }), BRANCH, '2026-09-21');
    if (v.kind !== 'rostered') throw new Error('expected rostered');
    expect(v.professional.name).toBe(stylist().id);
  });
});

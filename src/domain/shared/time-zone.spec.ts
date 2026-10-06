import { describe, it, expect } from 'vitest';
import {
  fixedUtcOffsetMinutes,
  offsetLabel,
  utcOffsetMinutes,
} from './time-zone';

describe('a zone without daylight saving has one offset', () => {
  it.each([
    ['Asia/Dhaka', 360],
    ['Asia/Dubai', 240],
    ['Asia/Kolkata', 330],
    ['UTC', 0],
  ])('%s is %i minutes east of UTC', (zone, offset) => {
    expect(fixedUtcOffsetMinutes(zone)).toBe(offset);
  });

  it('agrees with itself at any instant, milliseconds included', () => {
    expect(
      utcOffsetMinutes('Asia/Dubai', Date.UTC(2026, 9, 11, 6, 0, 0, 999)),
    ).toBe(240);
  });
});

describe('refused, loudly', () => {
  it('a zone with daylight saving', () => {
    expect(() => fixedUtcOffsetMinutes('Europe/London')).toThrow(
      /daylight saving/,
    );
  });

  it('a zone that does not exist', () => {
    expect(() => fixedUtcOffsetMinutes('Asia/Atlantis')).toThrow(RangeError);
  });
});

describe('offsetLabel', () => {
  it.each([
    [360, 'UTC+06:00'],
    [330, 'UTC+05:30'],
    [0, 'UTC+00:00'],
    [-210, 'UTC-03:30'],
  ])('%i reads %s', (min, label) => {
    expect(offsetLabel(min)).toBe(label);
  });
});

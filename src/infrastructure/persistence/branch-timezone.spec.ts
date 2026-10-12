import { describe, it, expect } from 'vitest';
import {
  DEFAULT_BRANCH_TIMEZONE,
  branchTimezone,
  fixedOffsetMinutes,
} from './branch-timezone';

describe('branchTimezone', () => {
  it('is Asia/Dubai when nothing is set', () => {
    expect(DEFAULT_BRANCH_TIMEZONE).toBe('Asia/Dubai');
    expect(branchTimezone(undefined)).toBe('Asia/Dubai');
    expect(branchTimezone('  ')).toBe('Asia/Dubai');
  });

  it('takes the configured zone, trimmed', () => {
    expect(branchTimezone(' Asia/Dhaka ')).toBe('Asia/Dhaka');
  });

  it('refuses a name the runtime does not know, rather than guessing', () => {
    expect(() => branchTimezone('Asia/Atlantis')).toThrow(/not a timezone/);
  });
});

describe('fixedOffsetMinutes', () => {
  it('Asia/Dubai is UTC+4 all year', () => {
    expect(fixedOffsetMinutes('Asia/Dubai', 2026)).toBe(240);
  });

  it('Asia/Dhaka is UTC+6 all year', () => {
    expect(fixedOffsetMinutes('Asia/Dhaka', 2026)).toBe(360);
  });

  it('handles half-hour offsets and UTC itself', () => {
    expect(fixedOffsetMinutes('Asia/Kolkata', 2026)).toBe(330);
    expect(fixedOffsetMinutes('UTC', 2026)).toBe(0);
  });

  it('refuses a zone with daylight saving: the arithmetic here is fixed-offset', () => {
    expect(() => fixedOffsetMinutes('Europe/London', 2026)).toThrow(
      /daylight saving/,
    );
  });
});

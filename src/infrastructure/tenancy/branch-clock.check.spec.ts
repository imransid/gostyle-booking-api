import { afterEach, describe, it, expect, vi } from 'vitest';
import { BranchClockCheck } from './branch-clock.check';
import {
  branchInstant,
  branchTimeZone,
  branchToday,
  branchUtcOffsetMin,
} from '../persistence/hold.repository';

const original = process.env.BRANCH_TIMEZONE;
afterEach(() => {
  if (original === undefined) delete process.env.BRANCH_TIMEZONE;
  else process.env.BRANCH_TIMEZONE = original;
});

const checkWith = (recorded: { offset_min: number; bookings: number }[]) =>
  new BranchClockCheck({
    $queryRawUnsafe: vi.fn().mockResolvedValue(recorded),
  } as never);

describe('the branch clock is configured, not hard-coded', () => {
  it('defaults to Asia/Dhaka, what every booking since 2026-09-18 was written at', () => {
    delete process.env.BRANCH_TIMEZONE;
    expect(branchTimeZone()).toBe('Asia/Dhaka');
    expect(branchUtcOffsetMin()).toBe(360);
  });

  it('follows BRANCH_TIMEZONE, read on every call', () => {
    process.env.BRANCH_TIMEZONE = 'Asia/Dubai';
    expect(branchUtcOffsetMin()).toBe(240);
    // 10:00 in Dubai is 06:00 UTC.
    expect(branchInstant('2026-10-11', 600).toISOString()).toBe(
      '2026-10-11T06:00:00.000Z',
    );

    process.env.BRANCH_TIMEZONE = 'Asia/Dhaka';
    // 10:00 in Dhaka is 04:00 UTC.
    expect(branchInstant('2026-10-11', 600).toISOString()).toBe(
      '2026-10-11T04:00:00.000Z',
    );
  });

  it("today is the branch's today: 22:30 UTC is already tomorrow in Dhaka", () => {
    process.env.BRANCH_TIMEZONE = 'Asia/Dhaka';
    expect(branchToday(Date.parse('2026-10-10T22:30:00Z'))).toBe('2026-10-11');
    process.env.BRANCH_TIMEZONE = 'Asia/Dubai';
    expect(branchToday(Date.parse('2026-10-10T19:30:00Z'))).toBe('2026-10-10');
  });

  it('refuses a zone with daylight saving rather than drifting twice a year', () => {
    process.env.BRANCH_TIMEZONE = 'Europe/London';
    expect(() => branchUtcOffsetMin()).toThrow(/daylight saving/);
  });
});

describe('the boot check compares the clock with the bookings already stored', () => {
  it('agrees when upcoming bookings were written at the configured offset', async () => {
    process.env.BRANCH_TIMEZONE = 'Asia/Dhaka';
    expect(
      await checkWith([{ offset_min: 360, bookings: 42 }]).check(),
    ).toEqual({
      kind: 'agrees',
      bookings: 42,
    });
  });

  it('disagrees when BRANCH_TIMEZONE moved and the data did not', async () => {
    process.env.BRANCH_TIMEZONE = 'Asia/Dubai';
    const got = await checkWith([{ offset_min: 360, bookings: 42 }]).check();
    expect(got).toEqual({
      kind: 'disagrees',
      recorded: [{ offset_min: 360, bookings: 42 }],
    });
  });

  it('has nothing to compare on an empty diary', async () => {
    expect(await checkWith([]).check()).toEqual({
      kind: 'no_upcoming_bookings',
    });
  });

  it('stops the boot for a zone nothing correct can run on', async () => {
    process.env.BRANCH_TIMEZONE = 'Asia/Atlantis';
    await expect(checkWith([]).onApplicationBootstrap()).rejects.toThrow(
      RangeError,
    );
  });
});

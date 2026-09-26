import { afterEach, describe, expect, it } from 'vitest';
import { NotFoundException, type ExecutionContext } from '@nestjs/common';
import {
  DEFAULT_SERIES_DEPOSIT_PERCENT,
  MOBILE_SERIES_BOOKING,
  MobileSeriesEnabledGuard,
  ROUTINE_COUNT_AUTO_NO_SHOWS,
  seriesDepositPercent,
} from './mobile-series.flag';

const contextFor = (method: string, path: string) =>
  ({
    switchToHttp: () => ({
      getRequest: () => ({ method, path, url: path }),
    }),
  }) as unknown as ExecutionContext;

afterEach(() => {
  delete process.env.MOBILE_SERIES_BOOKING;
  delete process.env.ROUTINE_COUNT_AUTO_NO_SHOWS;
});

describe('MOBILE_SERIES_BOOKING', () => {
  it('is OFF when unset', () => {
    expect(MOBILE_SERIES_BOOKING()).toBe(false);
  });

  it.each(['false', '1', 'yes', ''])('is OFF for %j', (v) => {
    process.env.MOBILE_SERIES_BOOKING = v;
    expect(MOBILE_SERIES_BOOKING()).toBe(false);
  });

  it.each(['true', ' TRUE '])('is ON for %j', (v) => {
    process.env.MOBILE_SERIES_BOOKING = v;
    expect(MOBILE_SERIES_BOOKING()).toBe(true);
  });

  it('does not follow the group flag', () => {
    process.env.MOBILE_GROUP_BOOKING = 'true';
    try {
      expect(MOBILE_SERIES_BOOKING()).toBe(false);
    } finally {
      delete process.env.MOBILE_GROUP_BOOKING;
    }
  });
});

describe('ROUTINE_COUNT_AUTO_NO_SHOWS (D9)', () => {
  it('is OFF when unset: only staff no-shows count', () => {
    expect(ROUTINE_COUNT_AUTO_NO_SHOWS()).toBe(false);
  });

  it.each(['false', '1', ''])('is OFF for %j', (v) => {
    process.env.ROUTINE_COUNT_AUTO_NO_SHOWS = v;
    expect(ROUTINE_COUNT_AUTO_NO_SHOWS()).toBe(false);
  });

  it('is ON for "true"', () => {
    process.env.ROUTINE_COUNT_AUTO_NO_SHOWS = 'true';
    expect(ROUTINE_COUNT_AUTO_NO_SHOWS()).toBe(true);
  });
});

describe('MobileSeriesEnabledGuard', () => {
  it.each([
    ['POST', '/v1/mobile-booking/series'],
    ['GET', '/v1/mobile-booking/series/abc'],
    ['PATCH', '/v1/mobile-booking/series/abc'],
    ['POST', '/v1/mobile-booking/series/abc/cancel'],
  ])(
    'answers 404 for %s %s with the flag off, as if the route did not exist',
    (method, path) => {
      const guard = new MobileSeriesEnabledGuard();
      expect(() => guard.canActivate(contextFor(method, path))).toThrow(
        NotFoundException,
      );
      expect(() => guard.canActivate(contextFor(method, path))).toThrow(
        `Cannot ${method} ${path}`,
      );
    },
  );

  it('lets the request through with the flag on', () => {
    process.env.MOBILE_SERIES_BOOKING = 'true';
    expect(
      new MobileSeriesEnabledGuard().canActivate(
        contextFor('POST', '/v1/mobile-booking/series'),
      ),
    ).toBe(true);
  });
});

describe('seriesDepositPercent', () => {
  it('is 20 unless configured', () => {
    expect(DEFAULT_SERIES_DEPOSIT_PERCENT).toBe(20);
    expect(seriesDepositPercent(undefined)).toBe(20);
    expect(seriesDepositPercent('  ')).toBe(20);
  });

  it.each([
    ['0', 0],
    ['35', 35],
    ['100', 100],
  ])('reads %j as %d', (raw, want) => {
    expect(seriesDepositPercent(raw)).toBe(want);
  });

  it.each(['-5', '101', '12.5', 'twenty'])(
    'falls back to the default for %j rather than showing nonsense',
    (raw) => {
      expect(seriesDepositPercent(raw)).toBe(20);
    },
  );
});

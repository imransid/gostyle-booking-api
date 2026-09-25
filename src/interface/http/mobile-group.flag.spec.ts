import { afterEach, describe, expect, it } from 'vitest';
import { NotFoundException, type ExecutionContext } from '@nestjs/common';
import {
  DEFAULT_GROUP_DEPOSIT_PERCENT,
  MOBILE_GROUP_BOOKING,
  MobileGroupEnabledGuard,
  groupDepositPercent,
} from './mobile-group.flag';

const context = {
  switchToHttp: () => ({
    getRequest: () => ({
      method: 'POST',
      path: '/v1/mobile-booking/group',
      url: '/v1/mobile-booking/group',
    }),
  }),
} as unknown as ExecutionContext;

afterEach(() => {
  delete process.env.MOBILE_GROUP_BOOKING;
});

describe('MOBILE_GROUP_BOOKING', () => {
  it('is OFF when unset', () => {
    expect(MOBILE_GROUP_BOOKING()).toBe(false);
  });

  it.each(['false', '1', 'yes', ''])('is OFF for %j', (v) => {
    process.env.MOBILE_GROUP_BOOKING = v;
    expect(MOBILE_GROUP_BOOKING()).toBe(false);
  });

  it.each(['true', ' TRUE '])('is ON for %j', (v) => {
    process.env.MOBILE_GROUP_BOOKING = v;
    expect(MOBILE_GROUP_BOOKING()).toBe(true);
  });
});

describe('MobileGroupEnabledGuard', () => {
  it('answers 404 with the flag off, as if the route did not exist', () => {
    expect(() => new MobileGroupEnabledGuard().canActivate(context)).toThrow(
      NotFoundException,
    );
    expect(() => new MobileGroupEnabledGuard().canActivate(context)).toThrow(
      'Cannot POST /v1/mobile-booking/group',
    );
  });

  it('lets the request through with the flag on', () => {
    process.env.MOBILE_GROUP_BOOKING = 'true';
    expect(new MobileGroupEnabledGuard().canActivate(context)).toBe(true);
  });
});

describe('groupDepositPercent', () => {
  it('is 20 unless configured (D1)', () => {
    expect(DEFAULT_GROUP_DEPOSIT_PERCENT).toBe(20);
    expect(groupDepositPercent(undefined)).toBe(20);
    expect(groupDepositPercent('  ')).toBe(20);
  });

  it.each([
    ['0', 0],
    ['35', 35],
    ['100', 100],
  ])('reads %j as %d', (raw, want) => {
    expect(groupDepositPercent(raw)).toBe(want);
  });

  it.each(['-5', '101', '12.5', 'twenty'])(
    'falls back to the default for %j rather than holding nonsense',
    (raw) => {
      expect(groupDepositPercent(raw)).toBe(20);
    },
  );
});

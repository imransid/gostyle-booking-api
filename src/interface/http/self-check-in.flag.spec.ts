import { afterEach, describe, expect, it } from 'vitest';
import { NotFoundException, type ExecutionContext } from '@nestjs/common';
import {
  SELF_CHECK_IN_V1,
  SelfCheckInEnabledGuard,
} from './self-check-in.flag';

const context = {
  switchToHttp: () => ({
    getRequest: () => ({
      method: 'POST',
      path: '/v1/bookings/x/check-in-request',
      url: '/v1/bookings/x/check-in-request',
    }),
  }),
} as unknown as ExecutionContext;

describe('SELF_CHECK_IN_V1', () => {
  const saved = process.env.SELF_CHECK_IN_V1;
  afterEach(() => {
    if (saved === undefined) delete process.env.SELF_CHECK_IN_V1;
    else process.env.SELF_CHECK_IN_V1 = saved;
  });

  it('is off when unset', () => {
    delete process.env.SELF_CHECK_IN_V1;
    expect(SELF_CHECK_IN_V1()).toBe(false);
  });

  it.each(['true', 'TRUE', ' True '])('is on for %j', (value) => {
    process.env.SELF_CHECK_IN_V1 = value;
    expect(SELF_CHECK_IN_V1()).toBe(true);
  });

  it.each(['', 'false', '1', 'yes', 'on', 'ture'])(
    'is off for %j, a typo included',
    (value) => {
      process.env.SELF_CHECK_IN_V1 = value;
      expect(SELF_CHECK_IN_V1()).toBe(false);
    },
  );

  it('off: the guard answers 404, as for a path that does not exist', () => {
    delete process.env.SELF_CHECK_IN_V1;
    expect(() => new SelfCheckInEnabledGuard().canActivate(context)).toThrow(
      new NotFoundException('Cannot POST /v1/bookings/x/check-in-request'),
    );
  });

  it('on: the guard lets the request through', () => {
    process.env.SELF_CHECK_IN_V1 = 'true';
    expect(new SelfCheckInEnabledGuard().canActivate(context)).toBe(true);
  });
});

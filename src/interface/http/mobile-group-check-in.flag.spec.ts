import { afterEach, describe, expect, it } from 'vitest';
import { NotFoundException, type ExecutionContext } from '@nestjs/common';
import {
  MOBILE_GROUP_CHECK_IN,
  MobileGroupCheckInEnabledGuard,
} from './mobile-group-check-in.flag';

const context = {
  switchToHttp: () => ({
    getRequest: () => ({
      method: 'POST',
      path: '/v1/mobile-booking/group/x/check-in',
      url: '/v1/mobile-booking/group/x/check-in',
    }),
  }),
} as unknown as ExecutionContext;

describe('MOBILE_GROUP_CHECK_IN', () => {
  const saved = process.env.MOBILE_GROUP_CHECK_IN;
  afterEach(() => {
    if (saved === undefined) delete process.env.MOBILE_GROUP_CHECK_IN;
    else process.env.MOBILE_GROUP_CHECK_IN = saved;
  });

  it('is off when unset', () => {
    delete process.env.MOBILE_GROUP_CHECK_IN;
    expect(MOBILE_GROUP_CHECK_IN()).toBe(false);
  });

  it.each(['true', 'TRUE', ' True '])('is on for %j', (value) => {
    process.env.MOBILE_GROUP_CHECK_IN = value;
    expect(MOBILE_GROUP_CHECK_IN()).toBe(true);
  });

  it.each(['', 'false', '1', 'yes', 'on', 'ture'])(
    'is off for %j, a typo included',
    (value) => {
      process.env.MOBILE_GROUP_CHECK_IN = value;
      expect(MOBILE_GROUP_CHECK_IN()).toBe(false);
    },
  );

  it('off: the guard answers 404, as for a path that does not exist', () => {
    delete process.env.MOBILE_GROUP_CHECK_IN;
    expect(() =>
      new MobileGroupCheckInEnabledGuard().canActivate(context),
    ).toThrow(
      new NotFoundException('Cannot POST /v1/mobile-booking/group/x/check-in'),
    );
  });

  it('on: the guard lets the request through', () => {
    process.env.MOBILE_GROUP_CHECK_IN = 'true';
    expect(new MobileGroupCheckInEnabledGuard().canActivate(context)).toBe(
      true,
    );
  });
});

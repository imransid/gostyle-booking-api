import { afterEach, describe, expect, it } from 'vitest';
import { MOBILE_GROUP_CHAIRS } from './mobile-group-chairs.flag';

describe('MOBILE_GROUP_CHAIRS', () => {
  const saved = process.env.MOBILE_GROUP_CHAIRS;
  afterEach(() => {
    if (saved === undefined) delete process.env.MOBILE_GROUP_CHAIRS;
    else process.env.MOBILE_GROUP_CHAIRS = saved;
  });

  it('is off when unset', () => {
    delete process.env.MOBILE_GROUP_CHAIRS;
    expect(MOBILE_GROUP_CHAIRS()).toBe(false);
  });

  it.each(['true', 'TRUE', ' True '])('is on for %j', (value) => {
    process.env.MOBILE_GROUP_CHAIRS = value;
    expect(MOBILE_GROUP_CHAIRS()).toBe(true);
  });

  it.each(['', 'false', '1', 'yes', 'on', 'ture'])(
    'is off for %j, a typo included',
    (value) => {
      process.env.MOBILE_GROUP_CHAIRS = value;
      expect(MOBILE_GROUP_CHAIRS()).toBe(false);
    },
  );

  it('does not follow MOBILE_GROUP_BOOKING: each switch is its own', () => {
    const party = process.env.MOBILE_GROUP_BOOKING;
    try {
      delete process.env.MOBILE_GROUP_CHAIRS;
      process.env.MOBILE_GROUP_BOOKING = 'true';
      expect(MOBILE_GROUP_CHAIRS()).toBe(false);
    } finally {
      if (party === undefined) delete process.env.MOBILE_GROUP_BOOKING;
      else process.env.MOBILE_GROUP_BOOKING = party;
    }
  });
});

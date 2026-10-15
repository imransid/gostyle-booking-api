import { afterEach, describe, expect, it } from 'vitest';
import { MOBILE_GROUP_LANE_GUARD } from './mobile-group-lane-guard.flag';

describe('MOBILE_GROUP_LANE_GUARD', () => {
  const saved = process.env.MOBILE_GROUP_LANE_GUARD;
  afterEach(() => {
    if (saved === undefined) delete process.env.MOBILE_GROUP_LANE_GUARD;
    else process.env.MOBILE_GROUP_LANE_GUARD = saved;
  });

  it('is off when unset', () => {
    delete process.env.MOBILE_GROUP_LANE_GUARD;
    expect(MOBILE_GROUP_LANE_GUARD()).toBe(false);
  });

  it.each(['true', 'TRUE', ' True '])('is on for %j', (value) => {
    process.env.MOBILE_GROUP_LANE_GUARD = value;
    expect(MOBILE_GROUP_LANE_GUARD()).toBe(true);
  });

  it.each(['', 'false', '1', 'yes', 'on', 'ture'])(
    'is off for %j, a typo included',
    (value) => {
      process.env.MOBILE_GROUP_LANE_GUARD = value;
      expect(MOBILE_GROUP_LANE_GUARD()).toBe(false);
    },
  );

  it('does not follow MOBILE_GROUP_BOOKING: each switch is its own', () => {
    const party = process.env.MOBILE_GROUP_BOOKING;
    try {
      delete process.env.MOBILE_GROUP_LANE_GUARD;
      process.env.MOBILE_GROUP_BOOKING = 'true';
      expect(MOBILE_GROUP_LANE_GUARD()).toBe(false);
    } finally {
      if (party === undefined) delete process.env.MOBILE_GROUP_BOOKING;
      else process.env.MOBILE_GROUP_BOOKING = party;
    }
  });
});

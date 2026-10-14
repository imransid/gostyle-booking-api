import { afterEach, describe, expect, it } from 'vitest';
import { MOBILE_GROUP_SELF_CHECK_IN } from './mobile-group-self-check-in.flag';

describe('MOBILE_GROUP_SELF_CHECK_IN', () => {
  const saved = process.env.MOBILE_GROUP_SELF_CHECK_IN;
  afterEach(() => {
    if (saved === undefined) delete process.env.MOBILE_GROUP_SELF_CHECK_IN;
    else process.env.MOBILE_GROUP_SELF_CHECK_IN = saved;
  });

  it('is off when unset', () => {
    delete process.env.MOBILE_GROUP_SELF_CHECK_IN;
    expect(MOBILE_GROUP_SELF_CHECK_IN()).toBe(false);
  });

  it.each(['true', 'TRUE', ' True '])('is on for %j', (value) => {
    process.env.MOBILE_GROUP_SELF_CHECK_IN = value;
    expect(MOBILE_GROUP_SELF_CHECK_IN()).toBe(true);
  });

  it.each(['', 'false', '1', 'yes', 'on', 'ture'])(
    'is off for %j, a typo included',
    (value) => {
      process.env.MOBILE_GROUP_SELF_CHECK_IN = value;
      expect(MOBILE_GROUP_SELF_CHECK_IN()).toBe(false);
    },
  );

  it('does not follow MOBILE_GROUP_CHECK_IN: each switch is its own', () => {
    const party = process.env.MOBILE_GROUP_CHECK_IN;
    try {
      delete process.env.MOBILE_GROUP_SELF_CHECK_IN;
      process.env.MOBILE_GROUP_CHECK_IN = 'true';
      expect(MOBILE_GROUP_SELF_CHECK_IN()).toBe(false);
    } finally {
      if (party === undefined) delete process.env.MOBILE_GROUP_CHECK_IN;
      else process.env.MOBILE_GROUP_CHECK_IN = party;
    }
  });
});

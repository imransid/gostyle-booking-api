import { describe, expect, it } from 'vitest';
import { staffSecret } from './token-verifier.service';

/**
 * ONE READER for the staff signing secret, so the boot check and the request
 * path cannot disagree about whether it is set.
 */
describe('staffSecret', () => {
  it('returns the configured secret', () => {
    expect(staffSecret('s3cret')).toBe('s3cret');
  });

  it('treats unset, empty and whitespace as NOT CONFIGURED', () => {
    // A secret of "   " would verify nothing and reject everything, which is
    // the same failure wearing a value.
    expect(staffSecret(undefined)).toBeNull();
    expect(staffSecret('')).toBeNull();
    expect(staffSecret('   ')).toBeNull();
  });
});

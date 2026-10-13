import { describe, expect, it } from 'vitest';
import { blankToNull } from './blank-to-null';

describe('blankToNull', () => {
  it('reads empty, blank and absent as null', () => {
    expect(blankToNull('')).toBeNull();
    expect(blankToNull('   ')).toBeNull();
    expect(blankToNull(undefined)).toBeNull();
  });

  it('keeps a value, trimmed', () => {
    expect(blankToNull(' Window section ')).toBe('Window section');
  });
});

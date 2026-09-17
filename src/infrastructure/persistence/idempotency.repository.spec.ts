import { describe, expect, it } from 'vitest';
import { hashRequestBody } from './idempotency.repository';

describe('hashRequestBody', () => {
  it('is stable for the same value', () => {
    expect(hashRequestBody({ a: 1, b: 2 })).toBe(
      hashRequestBody({ a: 1, b: 2 }),
    );
  });

  it('ignores key ORDER, so two client builds agree', () => {
    // THE BUG THIS PREVENTS: a retry serialised in a different field order
    // looks like a key collision and is refused 409 -- the exact opposite of
    // what an Idempotency-Key is for.
    expect(hashRequestBody({ a: 1, b: 2 })).toBe(
      hashRequestBody({ b: 2, a: 1 }),
    );
  });

  it('ignores undefined fields, which JSON drops anyway', () => {
    expect(hashRequestBody({ a: 1, b: undefined })).toBe(
      hashRequestBody({ a: 1 }),
    );
  });

  it('does NOT ignore array order, because order is meaning', () => {
    expect(hashRequestBody([1, 2])).not.toBe(hashRequestBody([2, 1]));
  });

  it('distinguishes different values', () => {
    expect(hashRequestBody({ a: 1 })).not.toBe(hashRequestBody({ a: 2 }));
  });

  it('distinguishes a null from a missing field', () => {
    expect(hashRequestBody({ a: null })).not.toBe(hashRequestBody({}));
  });

  it('handles nesting', () => {
    expect(hashRequestBody({ a: { x: 1, y: 2 } })).toBe(
      hashRequestBody({ a: { y: 2, x: 1 } }),
    );
  });

  it('does not confuse a string with the number that looks like it', () => {
    expect(hashRequestBody({ a: '1' })).not.toBe(hashRequestBody({ a: 1 }));
  });
});

import { describe, it, expect } from 'vitest';
import { corsOptions, DEV_ORIGINS } from './cors';

describe('corsOptions', () => {
  it('reads a comma separated allowlist, trimming space', () => {
    const { origin } = corsOptions(
      ' https://app.gostyle.ae , https://desk.gostyle.ae ',
    );
    expect(origin).toEqual([
      'https://app.gostyle.ae',
      'https://desk.gostyle.ae',
    ]);
  });

  it('ignores empty entries, so a trailing comma is harmless', () => {
    expect(corsOptions('https://app.gostyle.ae,,').origin).toEqual([
      'https://app.gostyle.ae',
    ]);
  });

  it('falls back to the dev origins when unset or blank', () => {
    expect(corsOptions(undefined).origin).toEqual([...DEV_ORIGINS]);
    expect(corsOptions('').origin).toEqual([...DEV_ORIGINS]);
    expect(corsOptions('   ').origin).toEqual([...DEV_ORIGINS]);
  });

  it('takes * as "any origin"', () => {
    expect(corsOptions('*').origin).toBe(true);
  });

  /**
   * THE ONE THAT WOULD COST AN AFTERNOON. Confirm is the only call carrying
   * Idempotency-Key; drop it from the allowlist and that single request dies
   * in the browser while every other call in the flow keeps working.
   */
  it('permits Idempotency-Key through the preflight', () => {
    expect(corsOptions().allowedHeaders).toContain('Idempotency-Key');
  });

  it('never sends credentials: this API takes a bearer token, not a cookie', () => {
    expect(corsOptions('*').credentials).toBe(false);
  });
});

import { describe, it, expect } from 'vitest';
import { postingBackoffMs } from './posting-backoff';

describe('postingBackoffMs', () => {
  it('waits 10s after the first failure, doubling after that', () => {
    expect(postingBackoffMs(1)).toBe(10_000);
    expect(postingBackoffMs(2)).toBe(20_000);
    expect(postingBackoffMs(3)).toBe(40_000);
    expect(postingBackoffMs(6)).toBe(320_000);
  });

  it('never waits longer than 10 minutes, however long the platform is gone', () => {
    expect(postingBackoffMs(7)).toBe(600_000);
    expect(postingBackoffMs(30)).toBe(600_000);
    expect(postingBackoffMs(10_000)).toBe(600_000);
  });

  it('treats a nonsense attempt count as the first', () => {
    expect(postingBackoffMs(0)).toBe(10_000);
    expect(postingBackoffMs(-3)).toBe(10_000);
    expect(postingBackoffMs(Number.NaN)).toBe(10_000);
  });
});

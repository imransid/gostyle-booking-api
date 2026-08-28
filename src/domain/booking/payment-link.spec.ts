import { describe, it, expect } from 'vitest';
import {
  linkWindow,
  LINK_WINDOW_MS,
  LINK_CUTOFF_BEFORE_START_MS,
} from './payment-link';

const NOW = 1_800_000_000_000;
const H = 60 * 60 * 1000;
const mins = (a: number, b: number): number => Math.round((a - b) / 60_000);

describe('the window is the shorter of the two', () => {
  it('six hours, when the start is far away', () => {
    const w = linkWindow(NOW, NOW + 48 * H);
    expect(w.kind).toBe('open');
    expect(w.kind === 'open' && w.capped).toBe('six_hours');
    expect(w.kind === 'open' && mins(w.expiresAtMs, NOW)).toBe(360);
  });

  it('start minus two hours, when the start is close', () => {
    const w = linkWindow(NOW, NOW + 5 * H);
    expect(w.kind === 'open' && w.capped).toBe('start_minus_two');
    // 5 hours out, minus 2, is a 3-hour window.
    expect(w.kind === 'open' && mins(w.expiresAtMs, NOW)).toBe(180);
  });

  it('exactly eight hours out is the boundary between the two', () => {
    // 8 - 2 = 6, so both rules give the same answer.
    const w = linkWindow(NOW, NOW + 8 * H);
    expect(w.kind === 'open' && mins(w.expiresAtMs, NOW)).toBe(360);
  });

  it('the window never runs past start minus two', () => {
    for (const hoursOut of [3, 5, 7, 8, 9, 24]) {
      const w = linkWindow(NOW, NOW + hoursOut * H);
      if (w.kind !== 'open') continue;
      expect(w.expiresAtMs).toBeLessThanOrEqual(
        NOW + hoursOut * H - LINK_CUTOFF_BEFORE_START_MS,
      );
    }
  });

  it('and never longer than six hours', () => {
    for (const hoursOut of [9, 24, 100]) {
      const w = linkWindow(NOW, NOW + hoursOut * H);
      expect(w.kind === 'open' && w.expiresAtMs).toBeLessThanOrEqual(
        NOW + LINK_WINDOW_MS,
      );
    }
  });
});

describe('the half-time reminder', () => {
  it('falls half way to the close', () => {
    const w = linkWindow(NOW, NOW + 48 * H);
    expect(w.kind === 'open' && mins(w.remindAtMs, NOW)).toBe(180);
  });

  it('and half way through a short window too', () => {
    const w = linkWindow(NOW, NOW + 5 * H);
    expect(w.kind === 'open' && mins(w.remindAtMs, NOW)).toBe(90);
  });

  it('always lands before the close', () => {
    for (const hoursOut of [2.5, 3, 5, 8, 48]) {
      const w = linkWindow(NOW, NOW + hoursOut * H);
      if (w.kind !== 'open') continue;
      expect(w.remindAtMs).toBeLessThan(w.expiresAtMs);
      expect(w.remindAtMs).toBeGreaterThan(NOW);
    }
  });
});

describe('TOO LATE FOR A LINK AT ALL', () => {
  it('inside two hours there is no window', () => {
    const w = linkWindow(NOW, NOW + 1 * H);
    expect(w.kind).toBe('too_late');
    expect(w.kind === 'too_late' && w.minutesPastCutoff).toBe(60);
  });

  it('exactly two hours out is also too late, not a zero window', () => {
    // A window of length zero is a link that expires the instant it is sent.
    const w = linkWindow(NOW, NOW + 2 * H);
    expect(w.kind).toBe('too_late');
  });

  it('a minute past two hours is open, barely', () => {
    const w = linkWindow(NOW, NOW + 2 * H + 60_000);
    expect(w.kind).toBe('open');
  });

  it('a start already in the past says how far past', () => {
    const w = linkWindow(NOW, NOW - 1 * H);
    expect(w.kind === 'too_late' && w.minutesPastCutoff).toBe(180);
  });

  it('THE POINT: never issue a link that is already dead', () => {
    for (const hoursOut of [-2, 0, 0.5, 1, 1.9, 2]) {
      expect(linkWindow(NOW, NOW + hoursOut * H).kind).toBe('too_late');
    }
  });
});

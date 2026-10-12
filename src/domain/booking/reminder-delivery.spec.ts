import { describe, it, expect } from 'vitest';
import {
  MAX_ATTEMPTS,
  greetingName,
  planDeliveries,
  pushEventId,
  readiness,
  rungOfEvent,
  settle,
} from './reminder-delivery';

const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = Date.parse('2026-10-10T06:00:00Z');
const START = NOW + 24 * HOUR;

describe('which events become deliveries', () => {
  it.each([
    ['reminder.confirm_24h', 'confirm_24h'],
    ['reminder.day_of_3h', 'day_of_3h'],
    ['reminder.running_late_15m', 'running_late_15m'],
  ])('%s is the %s rung', (eventType, rung) => {
    expect(rungOfEvent(eventType)).toBe(rung);
  });

  it.each([
    'reminder.payment_link',
    'booking.confirmed',
    'series.session_reminder_48h',
  ])('%s is not a ladder rung', (eventType) => {
    expect(rungOfEvent(eventType)).toBeNull();
  });
});

describe('planDeliveries: one row per channel', () => {
  it('a 24h reminder is a push and an email, live until the 3h one takes over', () => {
    const got = planDeliveries({
      rung: 'confirm_24h',
      startAtMs: START,
      nowMs: NOW,
      manual: false,
      queuedUntilMs: null,
    });
    expect(got).toEqual([
      {
        channel: 'push',
        scheduledForMs: START,
        expiresAtMs: START - 3 * HOUR,
        notBeforeMs: NOW,
      },
      {
        channel: 'email',
        scheduledForMs: START,
        expiresAtMs: START - 3 * HOUR,
        notBeforeMs: NOW,
      },
    ]);
  });

  it('a 15m nudge is a push only, live until the visit starts', () => {
    const got = planDeliveries({
      rung: 'running_late_15m',
      startAtMs: START,
      nowMs: NOW,
      manual: false,
      queuedUntilMs: null,
    });
    expect(got.map((d) => [d.channel, d.expiresAtMs])).toEqual([
      ['push', START],
    ]);
  });

  it("the desk's quiet-hours time is honoured, and a manual send lives until the start", () => {
    const nine = NOW + 3 * HOUR;
    const got = planDeliveries({
      rung: 'confirm_24h',
      startAtMs: START,
      nowMs: NOW,
      manual: true,
      queuedUntilMs: nine,
    });
    expect(
      got.every((d) => d.notBeforeMs === nine && d.expiresAtMs === START),
    ).toBe(true);
  });
});

describe('pushEventId: stable per reminder, new for a new appointment time', () => {
  it('the same reminder retried keeps its id', () => {
    expect(pushEventId('b1', 'confirm_24h', START)).toBe(
      pushEventId('b1', 'confirm_24h', START),
    );
  });

  it('a different rung, booking or start time is a different reminder', () => {
    const base = pushEventId('b1', 'confirm_24h', START);
    expect(pushEventId('b1', 'day_of_3h', START)).not.toBe(base);
    expect(pushEventId('b2', 'confirm_24h', START)).not.toBe(base);
    // Rescheduled: Oct 10 10:00 -> Oct 15 10:00 is a fresh reminder.
    expect(pushEventId('b1', 'confirm_24h', START + 5 * 24 * HOUR)).not.toBe(
      base,
    );
  });

  it('is not the confirmation key, which a reschedule would collide with', () => {
    expect(pushEventId('b1', 'confirm_24h', START)).toBe(
      `reminder:b1:confirm_24h:${START}`,
    );
  });
});

describe('readiness: asked right before every send', () => {
  const ask = (over: Partial<Parameters<typeof readiness>[0]> = {}) =>
    readiness({
      booking: { status: 'confirmed', startAtMs: START },
      scheduledForMs: START,
      expiresAtMs: START - 3 * HOUR,
      attempt: 1,
      nowMs: NOW,
      ...over,
    });

  it('a live booking at the time it was claimed for: go', () => {
    expect(ask()).toEqual({ kind: 'go' });
  });

  it('a desk reminder for a visit awaiting confirmation still goes', () => {
    expect(
      ask({ booking: { status: 'pending_confirmation', startAtMs: START } }),
    ).toEqual({
      kind: 'go',
    });
  });

  it.each(['cancelled', 'no_show', 'checked_in', 'expired'])(
    'a booking %s since the claim: skipped, nothing sent',
    (status) => {
      expect(ask({ booking: { status, startAtMs: START } })).toEqual({
        kind: 'skip',
        reason: `booking_${status}`,
      });
    },
  );

  it('a booking moved since the claim: superseded', () => {
    expect(
      ask({
        booking: { status: 'confirmed', startAtMs: START + 5 * 24 * HOUR },
      }),
    ).toEqual({
      kind: 'supersede',
    });
  });

  it('a booking that is gone: skipped', () => {
    expect(ask({ booking: null })).toEqual({
      kind: 'skip',
      reason: 'booking_not_found',
    });
  });

  it('past its window and never tried: skipped', () => {
    expect(ask({ nowMs: START - 2 * HOUR })).toEqual({
      kind: 'skip',
      reason: 'window_closed',
    });
  });

  it('a row whose worker died on every attempt still runs out', () => {
    expect(ask({ attempt: MAX_ATTEMPTS + 1 })).toEqual({
      kind: 'fail',
      error: `gave up after ${MAX_ATTEMPTS} attempts that never finished`,
    });
  });

  it('past its window after failed attempts: failed', () => {
    expect(ask({ nowMs: START - 2 * HOUR, attempt: 3 })).toEqual({
      kind: 'fail',
      error: 'window closed after 2 attempt(s)',
    });
  });
});

describe('settle: every path ends', () => {
  const expires = NOW + 18 * HOUR;
  const after = (
    outcome: Parameters<typeof settle>[0]['outcome'],
    attempt = 1,
    nowMs = NOW,
  ) => settle({ outcome, attempt, nowMs, expiresAtMs: expires });

  it('sent is sent', () => {
    expect(after({ kind: 'sent', ref: 'devices=2' })).toEqual({
      status: 'sent',
      ref: 'devices=2',
    });
  });

  it('a permanent failure is failed at once, no retry', () => {
    expect(after({ kind: 'failed', error: 'HTTP 401' })).toEqual({
      status: 'failed',
      error: 'HTTP 401',
    });
  });

  it('nothing to send to is skipped', () => {
    expect(after({ kind: 'skipped', reason: 'no_email' })).toEqual({
      status: 'skipped',
      reason: 'no_email',
    });
  });

  it('a transient failure backs off: 1m, 5m, 15m, 30m, 60m', () => {
    const delays = [1, 2, 3, 4, 5].map((attempt) => {
      const s = after({ kind: 'retry', error: 'timeout' }, attempt);
      return s.status === 'pending' ? (s.nextAttemptAtMs - NOW) / MIN : null;
    });
    expect(delays).toEqual([1, 5, 15, 30, 60]);
  });

  it(`gives up after ${MAX_ATTEMPTS} attempts`, () => {
    expect(after({ kind: 'retry', error: 'timeout' }, MAX_ATTEMPTS)).toEqual({
      status: 'failed',
      error: `timeout (gave up after ${MAX_ATTEMPTS} attempts)`,
    });
  });

  it('never schedules a retry after the window closes', () => {
    const s = after(
      { kind: 'retry', error: 'HTTP 503' },
      4,
      expires - 10 * MIN,
    );
    expect(s.status).toBe('failed');
  });
});

describe('greetingName', () => {
  it.each([
    ['Sara Ahmed', 'Sara'],
    ['  Imran  Khan ', 'Imran'],
    ['', null],
    [null, null],
  ])('%j -> %j', (full, first) => {
    expect(greetingName(full)).toBe(first);
  });
});

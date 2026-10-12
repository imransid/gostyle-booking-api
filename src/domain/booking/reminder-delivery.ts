/**
 * Delivering a reminder, once the ladder has claimed it.
 *
 * reminders.ts decides WHICH rung is due. This file decides what happens to
 * it afterwards, per channel: what to create, whether it is still worth
 * sending when its turn comes, and what a failure turns into. Nothing here
 * knows about push-app, SMTP, gRPC or the database.
 *
 *   claim (ladder) -> outbox event -> one delivery per channel -> send
 *
 * THE STAMP IS NOT THE DELIVERY. reminded_24h_at says the scheduler took the
 * rung. Whether the customer was actually told is a delivery's status, one
 * row per channel, so push and email succeed, fail and retry apart.
 */
import {
  REMINDER_LIVE_STATUSES,
  isRung,
  rungSpec,
  windowCloseMs,
  type ReminderChannel,
  type Rung,
} from './reminders';

const MIN = 60_000;

export type DeliveryStatus =
  'pending' | 'sent' | 'failed' | 'skipped' | 'superseded';

/** The ladder rung an outbox event is about, or null if it is not one. */
export function rungOfEvent(eventType: string): Rung | null {
  const prefix = 'reminder.';
  if (!eventType.startsWith(prefix)) return null;
  const rung = eventType.slice(prefix.length);
  // reminder.payment_link is a reminder but not a rung: not delivered here.
  return isRung(rung) ? rung : null;
}

export interface PlannedDelivery {
  readonly channel: ReminderChannel;
  /** The booking start this reminder was claimed for. */
  readonly scheduledForMs: number;
  /** After this, sending it would be noise. */
  readonly expiresAtMs: number;
  /** Not before this. Quiet hours, when the desk asked for them. */
  readonly notBeforeMs: number;
}

/**
 * The deliveries one reminder event becomes: one per channel of its rung.
 *
 * A rung expires where the next one takes over (the same window `due`
 * uses), so a 24h reminder held up by an outage is never delivered after
 * the 3h one. A manual reminder from the desk was asked for on purpose and
 * stays worth sending until the visit starts.
 *
 * `queuedUntilMs` is the desk's quiet-hours answer ("it will go out at
 * 09:00"), which until now was written into the event and honoured by
 * nothing.
 */
export function planDeliveries(input: {
  readonly rung: Rung;
  readonly startAtMs: number;
  readonly nowMs: number;
  readonly manual: boolean;
  readonly queuedUntilMs: number | null;
}): PlannedDelivery[] {
  const spec = rungSpec(input.rung);
  const expiresAtMs = input.manual
    ? input.startAtMs
    : windowCloseMs(spec, input.startAtMs);
  return spec.channels.map((channel) => ({
    channel,
    scheduledForMs: input.startAtMs,
    expiresAtMs,
    notBeforeMs: input.queuedUntilMs ?? input.nowMs,
  }));
}

/**
 * The push service's idempotency key for one reminder.
 *
 * push-app sends at most once per (user, eventId, device). So the id must be
 * the same on every retry of this reminder, and different for anything that
 * is genuinely a new reminder:
 *
 *   booking  -- two visits never share one
 *   rung     -- the 24h and the 3h reminder are two messages
 *   start    -- a booking MOVED to a new time is a new appointment and gets
 *               its own ladder; keyed on the booking alone, push-app would
 *               drop the new reminder as a duplicate of the old one
 *
 * NOT `eventIdFor` in push-listener.ts: that keys a confirmation per booking
 * and slices off a 'booking.' prefix these events do not have.
 */
export function pushEventId(
  bookingId: string,
  rung: Rung,
  scheduledForMs: number,
): string {
  return `reminder:${bookingId}:${rung}:${scheduledForMs}`;
}

export type Readiness =
  | { readonly kind: 'go' }
  | { readonly kind: 'skip'; readonly reason: string }
  | { readonly kind: 'supersede' }
  | { readonly kind: 'fail'; readonly error: string };

/**
 * Is this reminder still about a visit that is coming, at the time it was
 * claimed for? Asked immediately before every send, because a claim and its
 * send are seconds -- or, through an outage, hours -- apart.
 *
 *   cancelled since       -> skipped, nothing sent
 *   moved since           -> superseded; the move reset the ladder, and the
 *                            new time gets its own reminders
 *   too late to be useful -> skipped if never tried, failed if it was
 */
export function readiness(input: {
  readonly booking: {
    readonly status: string;
    readonly startAtMs: number;
  } | null;
  readonly scheduledForMs: number;
  readonly expiresAtMs: number;
  /** Which attempt this is, counting from 1. */
  readonly attempt: number;
  readonly nowMs: number;
}): Readiness {
  const { booking } = input;
  if (booking === null) return { kind: 'skip', reason: 'booking_not_found' };

  if (!(REMINDER_LIVE_STATUSES as readonly string[]).includes(booking.status)) {
    return { kind: 'skip', reason: `booking_${booking.status}` };
  }

  if (booking.startAtMs !== input.scheduledForMs) return { kind: 'supersede' };

  // A claim counts an attempt even when the worker dies before recording
  // one, so a send that kills its worker every time still runs out. Without
  // this, a manual reminder -- live until the visit starts -- would be
  // claimed, crash and come back every lease for days.
  if (input.attempt > MAX_ATTEMPTS) {
    return {
      kind: 'fail',
      error: `gave up after ${MAX_ATTEMPTS} attempts that never finished`,
    };
  }

  if (input.nowMs >= input.expiresAtMs) {
    return input.attempt <= 1
      ? { kind: 'skip', reason: 'window_closed' }
      : {
          kind: 'fail',
          error: `window closed after ${input.attempt - 1} attempt(s)`,
        };
  }

  return { kind: 'go' };
}

/** What one channel's send came to, in words the retry rule understands. */
export type ChannelOutcome =
  | { readonly kind: 'sent'; readonly ref: string | null }
  /** Might work later: a timeout, a 5xx, a dependency that is down. */
  | { readonly kind: 'retry'; readonly error: string }
  /** Will not work by trying again: a 4xx, a refused address. */
  | { readonly kind: 'failed'; readonly error: string }
  /** Nothing to send to, or not wanted: no devices, no email, opted out. */
  | { readonly kind: 'skipped'; readonly reason: string };

/**
 * After a transient failure, when to try again.
 *
 * ONE ATTEMPT IS COUNTED PER CLAIM, so this is the whole retry budget: six
 * attempts, backing off from a minute to an hour, and never past the moment
 * the reminder stops being worth sending. There is no infinite loop to fall
 * into: every path ends in sent, failed or skipped.
 */
export const MAX_ATTEMPTS = 6;
export const RETRY_DELAYS_MS: readonly number[] = [
  1 * MIN,
  5 * MIN,
  15 * MIN,
  30 * MIN,
  60 * MIN,
];

/**
 * How long a claimed delivery is held before another worker may take it.
 *
 * A worker killed mid-send (kill -9, an OOM, a deploy) leaves its rows
 * claimed and never recorded. The claim pushes next_attempt_at this far
 * ahead, so those rows simply come due again. Longer than the slowest send
 * (a contact lookup, a push and an SMTP conversation, each with its own
 * timeout), so a slow worker is not raced by a second one.
 */
export const DISPATCH_LEASE_MS = 5 * MIN;

export type Settlement =
  | { readonly status: 'sent'; readonly ref: string | null }
  | {
      readonly status: 'pending';
      readonly nextAttemptAtMs: number;
      readonly error: string;
    }
  | { readonly status: 'failed'; readonly error: string }
  | { readonly status: 'skipped'; readonly reason: string };

/** What a channel's outcome turns the delivery into. */
export function settle(input: {
  readonly outcome: ChannelOutcome;
  readonly attempt: number;
  readonly nowMs: number;
  readonly expiresAtMs: number;
}): Settlement {
  const { outcome } = input;
  switch (outcome.kind) {
    case 'sent':
      return { status: 'sent', ref: outcome.ref };
    case 'skipped':
      return { status: 'skipped', reason: outcome.reason };
    case 'failed':
      return { status: 'failed', error: outcome.error };
    case 'retry': {
      if (input.attempt >= MAX_ATTEMPTS) {
        return {
          status: 'failed',
          error: `${outcome.error} (gave up after ${input.attempt} attempts)`,
        };
      }
      const delay =
        RETRY_DELAYS_MS[Math.min(input.attempt, RETRY_DELAYS_MS.length) - 1]!;
      const at = input.nowMs + delay;
      if (at >= input.expiresAtMs) {
        return {
          status: 'failed',
          error: `${outcome.error} (no time left to retry before the window closed)`,
        };
      }
      return { status: 'pending', nextAttemptAtMs: at, error: outcome.error };
    }
  }
}

/** "Sara Ahmed" -> "Sara". The greeting, from what customer-api holds. */
export function greetingName(fullName: string | null): string | null {
  const first = (fullName ?? '').trim().split(/\s+/)[0] ?? '';
  return first === '' ? null : first;
}

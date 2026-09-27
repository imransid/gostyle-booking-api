import { createHash } from 'node:crypto';
import {
  REMINDER_HOURS,
  beyondHorizon,
  sessionBucket,
  type SessionFacts,
} from './mobile-series';

const HOUR_MS = 3_600_000;

/** The outbox event a visit's 48 hour reminder is (plan R10). */
export const REMINDER_EVENT = 'series.session_reminder_48h';

/**
 * A visit's 48 hour reminder is due: it is booked, still to come, and starts
 * within REMINDER_HOURS. A visit with nothing booked yet, or already closed,
 * gets none.
 */
export function reminderDue(s: SessionFacts, nowMs: number): boolean {
  return (
    sessionBucket(s) === 'remaining' &&
    s.bookingStatus !== null &&
    s.startAtMs > nowMs &&
    s.startAtMs - nowMs <= REMINDER_HOURS * HOUR_MS
  );
}

/**
 * The reminder's own event id, made from the visit and its start time (a
 * UUID shaped like a version 5 one). Both copies of the job, every hour,
 * work out the same id for the same visit, so the outbox keeps exactly one
 * reminder: the database skips a second row with the same id. A visit moved
 * to another time gets a new id, so a new reminder.
 */
export function reminderEventId(
  occurrenceId: string,
  startAtMs: number,
): string {
  const hex = createHash('sha256')
    .update(`${REMINDER_EVENT}:${occurrenceId}:${startAtMs}`)
    .digest('hex');
  const variant = ((parseInt(hex.charAt(16), 16) & 0x3) | 0x8).toString(16);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `5${hex.slice(13, 16)}`,
    `${variant}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join('-');
}

/**
 * Every visit of the routine is closed (done, skipped or cancelled): plan
 * E.4 step 4 marks the routine `completed`, so no job looks at it again. A
 * routine with no visits at all has nothing to close.
 */
export function allClosed(facts: readonly SessionFacts[]): boolean {
  return (
    facts.length > 0 && facts.every((f) => sessionBucket(f) !== 'remaining')
  );
}

/**
 * A pause whose date has come ends by itself (plan E.4 step 1). A pause
 * with no date (two misses, D5) never does: only the customer or the desk
 * resumes it.
 */
export function resumeDue(pausedUntil: string | null, today: string): boolean {
  return pausedUntil !== null && pausedUntil <= today;
}

/**
 * Why the job released a visit when two misses paused its routine (D5):
 * booking_status_history.reason, as the desk reads it.
 */
export const MISSED_RELEASE_REASON =
  'Released: the routine was paused after 2 missed visits.';

/** The outbox event a far-off visit becomes when its time is not free (8c). */
export const NEEDS_ACTION_EVENT = 'series.session_needs_action';

/** A UUID shaped like a version 5 one, made from a text: same text, same id. */
function idFrom(text: string): string {
  const hex = createHash('sha256').update(text).digest('hex');
  const variant = ((parseInt(hex.charAt(16), 16) & 0x3) | 0x8).toString(16);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `5${hex.slice(13, 16)}`,
    `${variant}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join('-');
}

/**
 * The "needs action" event's own id, made from the visit and its day, as
 * reminderEventId is: one event per visit and day, whoever writes it.
 */
export function needsActionEventId(occurrenceId: string, day: string): string {
  return idFrom(`${NEEDS_ACTION_EVENT}:${occurrenceId}:${day}`);
}

/**
 * A far-off visit the diary now reaches (plan E.4 step 3, R8): planned with
 * nothing booked, still to come, and no longer past the booking horizon.
 * The job books it at its own day, time and stylist, or marks it "needs
 * action" (D4: never moved silently).
 */
export function horizonDue(
  s: SessionFacts,
  nowMs: number,
  today: string,
): boolean {
  return (
    s.state === 'planned' &&
    s.bookingStatus === null &&
    s.startAtMs > nowMs &&
    !beyondHorizon(s.day, today)
  );
}

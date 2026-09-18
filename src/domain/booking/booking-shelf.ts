import { TERMINAL_STATES, type BookingStatus } from './lifecycle';

/**
 * Which list a customer's booking belongs on.
 *
 * The app shows three tabs. `recurring` is not decided here -- it is a
 * property of whether a series exists, not of one booking's state -- so
 * this answers the only question with a rule behind it: is this booking
 * still ahead of the customer, or is it history?
 *
 * TWO INPUTS, NOT ONE. Status alone is wrong: a `confirmed` booking from
 * last March is not upcoming. Time alone is wrong too: a booking cancelled
 * for next Tuesday is not upcoming either, and showing it under a heading
 * that means "what is coming" is how someone turns up for an appointment
 * that is not there.
 *
 * TERMINAL_STATES is imported, never re-listed. It is the lifecycle's own
 * answer to "can this still move", and a second copy here would be a
 * second thing to update the day a status is added (CLAUDE.md 4).
 */
export type BookingShelf = 'upcoming' | 'archive';

/**
 * `completed` is NOT in TERMINAL_STATES -- it still moves on to `settled`
 * once the money is closed -- but it has already happened, and a customer
 * looking at "upcoming" does not want to see this morning's haircut.
 * Belonging on the archive shelf and being unable to move are different
 * questions, and this is the one place they part company.
 */
const ALREADY_HAPPENED: ReadonlySet<BookingStatus> = new Set<BookingStatus>([
  'completed',
]);

export function shelfOf(input: {
  readonly status: BookingStatus;
  /**
   * When the visit ENDS, not when it starts.
   *
   * A visit that began an hour ago and is still running has not become
   * history while the customer is sitting in the chair. Starting-time
   * would move it to the archive tab mid-haircut.
   */
  readonly endsAtMs: number;
  readonly nowMs: number;
}): BookingShelf {
  if (TERMINAL_STATES.has(input.status)) return 'archive';
  if (ALREADY_HAPPENED.has(input.status)) return 'archive';
  return input.endsAtMs > input.nowMs ? 'upcoming' : 'archive';
}

import { TERMINAL_STATES, type BookingStatus } from './lifecycle';
import type { PaymentStatus } from '../../generated/prisma/enums';

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

/**
 * Every status that puts a booking on the archive shelf REGARDLESS of when
 * it was for.
 *
 * Exported because the list query has to express the same rule in SQL: a
 * page of bookings cannot be filtered by calling `shelfOf` on rows that
 * have not been fetched yet. Deriving the set here rather than writing the
 * status names a second time in the repository is the point -- the two
 * would disagree the day a status is added, and the query is the copy
 * nobody would think to update (CLAUDE.md 4).
 */
export const ARCHIVE_STATES: ReadonlySet<BookingStatus> =
  new Set<BookingStatus>([...TERMINAL_STATES, ...ALREADY_HAPPENED]);

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
  if (ARCHIVE_STATES.has(input.status)) return 'archive';
  return input.endsAtMs > input.nowMs ? 'upcoming' : 'archive';
}

// --------------------------------------------------------------- the tabs

/**
 * The three words the `filter` parameter accepts (booking-list.md §2).
 *
 * `recurring` is one of them even though nothing can land on it yet. The tab
 * exists in the app, and answering an empty page is a different thing from
 * answering 422 -- the first says "you have no routines", which is true, and
 * the second says "there is no such tab", which is not.
 */
export type ListFilter = 'upcoming' | 'recurring' | 'archive';

const FILTERS: ReadonlySet<string> = new Set<ListFilter>([
  'upcoming',
  'recurring',
  'archive',
]);

/** The default is `upcoming`; anything unrecognised is null, not a guess. */
export function parseFilter(raw: string | undefined | null): ListFilter | null {
  if (raw === undefined || raw === null || raw === '') return 'upcoming';
  return FILTERS.has(raw) ? (raw as ListFilter) : null;
}

/**
 * §2.3: a DRAFT payment is not a booking yet.
 *
 * A checkout still inside its hold window appears on none of the three
 * shelves, and an expired one is simply GONE -- not archived. Both halves
 * matter: showing the first would put a booking in "upcoming" that the
 * customer has not paid for and may never, and archiving the second would
 * fill a customer's history with abandoned checkouts they never made.
 *
 * `unpaid` IS the app's `DRAFT` -- see `toMobilePaymentStatus`, which is the
 * only mapping between the two vocabularies. Checking the payment state
 * rather than the hold window is deliberate: the window is cleared by the
 * §11 patch at the same moment the payment state moves, so the payment
 * state answers the question without a clock in it.
 *
 * `none_required` is NOT excluded. A PAY_AFTER_CHECK_IN booking is settled
 * by arrangement, not unfinished: the salon is holding a chair for it and
 * the customer must see it under "upcoming".
 */
export function isListable(input: {
  readonly status: BookingStatus;
  readonly paymentStatus: PaymentStatus;
}): boolean {
  if (input.paymentStatus === 'unpaid') return false;
  // Never real bookings: a `draft` row is a shell and a `held` one is a
  // reservation that has not been confirmed into anything.
  return input.status !== 'draft' && input.status !== 'held';
}

/** The statuses `isListable` refuses outright, for the query to exclude. */
export const NEVER_LISTED_STATES: readonly BookingStatus[] = ['draft', 'held'];

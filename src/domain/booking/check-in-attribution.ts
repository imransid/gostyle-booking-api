import type { ActorKind, BookingStatus } from './lifecycle';

/**
 * WHO CHECKED THIS PERSON IN, AND HOW: the facts behind the welcome screen
 * ("Checked in by Layla R. at 14:24").
 *
 * ONE HOME: the booking's status history row for the move into CHECKED_IN.
 * Both ways in write it, the desk's own check-in and the approval of a self
 * check-in request (which runs that very check-in), so nothing about a
 * check-in is copied anywhere else (CLAUDE.md 4).
 *
 *   who    the row's actor, by id. The id is the record. The NAME is looked
 *          up when the screen is read, never stored: the row is written
 *          while a receptionist has a customer in front of them, and a name
 *          is decoration that must never make them wait. So the name shown
 *          is the one platform has now, not then; the id is still exactly
 *          who.
 *   how    CheckInVia, stored on the row as it is written. It cannot be
 *          worked out afterwards: an approval undone and then a desk
 *          check-in leaves an approved request behind a check-in the desk
 *          did on its own.
 *   when   the row's time.
 */

/**
 * HOW they were checked in.
 *
 *   self    the customer asked first: a check-in request, at a chair or
 *           with Wait for Staff, approved by the desk
 *   staff   the desk checked them in on its own: their pass scanned, or the
 *           booking found on the calendar. booking-api cannot tell those
 *           two apart (both are POST /v1/bookings/:id/check-in) and does
 *           not try.
 *
 * SELF NEVER MEANS NOBODY AT THE SALON TOUCHED IT. The desk approves every
 * self check-in (D1); nothing checks a customer in on their word alone. SELF
 * means "the customer asked first". A screen that reads "Self-approved"
 * describes a path that was deliberately not built.
 */
export type CheckInVia = 'self' | 'staff';

/** One row of a booking's status history, as checkInOf reads it. */
export interface HistoryEntry {
  readonly fromStatus: BookingStatus | null;
  readonly toStatus: BookingStatus;
  readonly atMs: number;
  readonly actorKind: ActorKind;
  readonly actorId: string | null;
  /**
   * On a move into CHECKED_IN written since `via` was recorded; null on
   * every other row, and on a check-in written before.
   */
  readonly via: CheckInVia | null;
}

/** The check-in that stands. */
export interface StandingCheckIn {
  readonly atMs: number;
  /** Null on a check-in written before `via` was recorded: unknown, not staff. */
  readonly via: CheckInVia | null;
  /**
   * The desk member who checked them in, whose name the screen may show.
   * Null when the row names no desk member. Null is also "nothing to look
   * up": a reader asks platform for a name only when this is set.
   */
  readonly by: { readonly kind: ActorKind; readonly id: string } | null;
}

/**
 * The check-in that stands, or null: the latest move into CHECKED_IN,
 * unless the desk undid it afterwards (CHECKED_IN back to CONFIRMED, the
 * desk checked in the wrong Amira). A check-in after the undo is a new one,
 * and it is the one that stands.
 *
 * A later cancel or no-show does not erase it. They were checked in, and
 * then the visit ended another way; whether to greet anybody is the
 * screen's call, from the booking's status.
 *
 * `history` oldest first, as booking_status_history_booking_idx reads it.
 */
export function checkInOf(
  history: readonly HistoryEntry[],
): StandingCheckIn | null {
  let standing: HistoryEntry | null = null;
  for (const entry of history) {
    if (entry.toStatus === 'checked_in') standing = entry;
    else if (
      entry.fromStatus === 'checked_in' &&
      entry.toStatus === 'confirmed'
    ) {
      standing = null;
    }
  }
  if (standing === null) return null;

  const deskMember =
    (standing.actorKind === 'staff' || standing.actorKind === 'manager') &&
    standing.actorId !== null;
  return {
    atMs: standing.atMs,
    via: standing.via,
    by: deskMember
      ? { kind: standing.actorKind, id: standing.actorId as string }
      : null,
  };
}

/**
 * The desk member's name as the customer sees it: "Layla R.", the first
 * name and the initial of the last, as platform spells them. Only what a
 * welcome needs; the id says exactly who.
 *
 * The initial is the last name's first letter as given ("Al Rashid" is
 * "A."), whole even outside the Basic Multilingual Plane, and upper-cased
 * where the script has a case.
 *
 * Null with no first name: an initial alone greets nobody, so the screen
 * reads as it does with no name at all.
 */
export function staffShortName(
  firstName: string | null | undefined,
  lastName: string | null | undefined,
): string | null {
  const first = squash(firstName);
  if (first === '') return null;
  const initial = Array.from(squash(lastName))[0];
  return initial === undefined ? first : `${first} ${initial.toUpperCase()}.`;
}

/** Trimmed, with every run of whitespace inside one space. */
function squash(text: string | null | undefined): string {
  return (text ?? '').trim().replace(/\s+/g, ' ');
}

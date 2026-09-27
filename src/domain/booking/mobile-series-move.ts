import { isLocked, sessionBucket, type SessionFacts } from './mobile-series';

/** Why a PAUSE released a session's old booking (booking_status_history.reason). */
export const PAUSE_MOVE_REASON =
  'Moved by a pause in the app, as part of a routine.';

/** Why a RESUME released a session's old booking. */
export const RESUME_MOVE_REASON =
  'Moved by a resume in the app, as part of a routine.';

const DAY_MS = 86_400_000;

/** The calendar day after `day` (YYYY-MM-DD). */
function dayAfter(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + DAY_MS)
    .toISOString()
    .slice(0, 10);
}

/** The day after the latest of `days`, or null when there are none. */
function dayAfterAll(days: readonly string[]): string | null {
  if (days.length === 0) return null;
  return dayAfter([...days].sort()[days.length - 1]!);
}

/** The latest of the days given (YYYY-MM-DD sorts as text). */
function latestOf(first: string, ...rest: readonly (string | null)[]): string {
  return rest.reduce<string>((a, b) => (b !== null && b > a ? b : a), first);
}

/**
 * The sessions a PAUSE or RESUME moves: still to come and past the 24 hour
 * lock, in the routine's order. A session inside the lock stays where it is
 * (plan R13), as it does for SKIP and RESCHEDULE.
 */
export function movableSessions<T extends SessionFacts>(
  facts: readonly T[],
  nowMs: number,
): T[] {
  return facts
    .filter(
      (f) => sessionBucket(f) === 'remaining' && !isLocked(f.startAtMs, nowMs),
    )
    .sort((a, b) => a.index - b.index);
}

/**
 * The days of the sessions still to come that a move leaves where they are
 * (inside the 24 hour lock). Nothing moved may land on or before them.
 */
export function stayingDays(
  facts: readonly SessionFacts[],
  moved: ReadonlySet<string>,
): string[] {
  return facts
    .filter((f) => !moved.has(f.id) && sessionBucket(f) === 'remaining')
    .map((f) => f.day);
}

/**
 * The first day a PAUSE may put a session on: the resume date, but never
 * before the first session it moves (a pause never brings a visit closer),
 * and after every session it leaves where it is.
 */
export function pauseFrom(
  until: string,
  firstMovedDay: string | null,
  staying: readonly string[],
): string {
  return latestOf(until, firstMovedDay, dayAfterAll(staying));
}

/**
 * The first day a RESUME may put a session on: tomorrow ("Resume now"), and
 * after every session it leaves where it is, so no day holds two sessions.
 */
export function resumeFrom(today: string, staying: readonly string[]): string {
  return latestOf(dayAfter(today), dayAfterAll(staying));
}

/** Where a session is booked now, or its planned slot when nothing is booked. */
export interface CurrentSlot {
  readonly bookingId: string | null;
  readonly day: string;
  readonly startMin: number;
  readonly staffId: string | null;
}

/** Where a moved session goes. */
export interface TargetSlot {
  readonly day: string;
  readonly startMin: number;
  readonly staffId: string;
}

/**
 * Which bookings a move keeps, and which it releases.
 *
 * A session already booked on one of the new slots (same day, time and
 * stylist) KEEPS its booking: booking that slot again would clash with the
 * routine's own booking, so the stylist would look busy. Every other new
 * slot gets a new booking (or none past the 90 day horizon), and every
 * booking not kept is released, once the new ones are made.
 *
 * `keep` maps a new slot's position to the booking it keeps.
 */
export function keepPlan(
  current: readonly CurrentSlot[],
  targets: readonly TargetSlot[],
): {
  readonly keep: ReadonlyMap<number, string>;
  readonly release: readonly string[];
} {
  const keep = new Map<number, string>();
  const used = new Set<string>();
  targets.forEach((t, position) => {
    const match = current.find(
      (c) =>
        c.bookingId !== null &&
        !used.has(c.bookingId) &&
        c.day === t.day &&
        c.startMin === t.startMin &&
        c.staffId === t.staffId,
    );
    if (match !== undefined && match.bookingId !== null) {
      keep.set(position, match.bookingId);
      used.add(match.bookingId);
    }
  });
  const release = current
    .map((c) => c.bookingId)
    .filter((id): id is string => id !== null && !used.has(id));
  return { keep, release };
}

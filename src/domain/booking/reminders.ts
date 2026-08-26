/**
 * The reminder ladder.
 *
 * Three messages before a visit, each with a different job. Nothing here
 * knows about queues, templates or the database: this file decides WHICH
 * message is due and WHETHER it should be sent at all.
 */

export type Rung = 'confirm_24h' | 'day_of_3h' | 'running_late_15m';

export interface RungSpec {
  readonly rung: Rung;
  /** How far before the start it fires. */
  readonly leadMs: number;
  /** The column that records the send, so the scheduler is idempotent. */
  readonly column: 'reminded24hAt' | 'reminded3hAt' | 'nudged15mAt';
  readonly purpose: string;
}

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

/** Ordered furthest-out first, which is also the order they fire. */
export const LADDER: readonly RungSpec[] = [
  {
    rung: 'confirm_24h',
    leadMs: 24 * HOUR,
    column: 'reminded24hAt',
    purpose: 'Confirm or move, with a payment prompt when anything is pending',
  },
  {
    rung: 'day_of_3h',
    leadMs: 3 * HOUR,
    column: 'reminded3hAt',
    purpose: 'Day-of nudge with directions and preparation notes',
  },
  {
    rung: 'running_late_15m',
    leadMs: 15 * MIN,
    column: 'nudged15mAt',
    purpose: 'Running late? nudge, naming the grace window',
  },
];

export interface BookingClock {
  readonly startAtMs: number;
  readonly reminded24hAt: number | null;
  readonly reminded3hAt: number | null;
  readonly nudged15mAt: number | null;
}

export type RungVerdict =
  /** Send it. */
  | { readonly kind: 'send'; readonly spec: RungSpec }
  /**
   * The window closed before anyone looked.
   *
   * A booking made two hours before its start is already past the 24-hour
   * and the three-hour marks. Firing both immediately, back to back, is spam
   * that teaches the customer to ignore the third one, which is the only
   * message that actually saves the slot. So the rung is marked sent WITHOUT
   * sending, and the ladder picks up at whichever rung the booking is
   * actually inside.
   */
  | { readonly kind: 'skip'; readonly spec: RungSpec; readonly why: string }
  /** Not yet, or already handled. */
  | { readonly kind: 'nothing' };

/**
 * Which rung, if any, this booking is due right now.
 *
 * Each rung owns a WINDOW, not a threshold: it fires between its own lead
 * time and the next rung's. That is what stops a late booking firing the
 * whole ladder in one tick.
 */
export function due(booking: BookingClock, nowMs: number): RungVerdict {
  const untilStart = booking.startAtMs - nowMs;

  for (let i = 0; i < LADDER.length; i++) {
    const spec = LADDER[i]!;
    if (booking[spec.column] !== null) continue; // already handled

    // The window: from this rung's lead time down to the next rung's.
    // The last rung's floor is the start itself.
    const nextLead = LADDER[i + 1]?.leadMs ?? 0;

    if (untilStart > spec.leadMs) return { kind: 'nothing' }; // too early
    if (untilStart > nextLead) return { kind: 'send', spec };

    return {
      kind: 'skip',
      spec,
      why:
        untilStart <= 0
          ? 'the visit has already started'
          : 'booked inside this window, so a later rung covers it',
    };
  }

  return { kind: 'nothing' };
}

/** Every rung still outstanding, for a status view. */
export function pending(booking: BookingClock): Rung[] {
  return LADDER.filter((s) => booking[s.column] === null).map((s) => s.rung);
}

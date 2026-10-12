/**
 * The reminder ladder.
 *
 * Three messages before a visit, each with a different job. Nothing here
 * knows about queues, templates or the database: this file decides WHICH
 * message is due and WHETHER it should be sent at all.
 */

export type Rung = 'confirm_24h' | 'day_of_3h' | 'running_late_15m';

/** How a reminder reaches the customer. */
export type ReminderChannel = 'push' | 'email';

export interface RungSpec {
  readonly rung: Rung;
  /** How far before the start it fires. */
  readonly leadMs: number;
  /**
   * The column that records the CLAIM, so the scheduler is idempotent.
   *
   * Not proof of delivery: the stamp says the scheduler took this rung and
   * wrote its event. Whether a push or an email actually went out is
   * notification_delivery's to say (reminder-delivery.ts).
   */
  readonly column: 'reminded24hAt' | 'reminded3hAt' | 'nudged15mAt';
  readonly purpose: string;
  /**
   * Where this rung goes. The 15-minute nudge is push only: an email read
   * after the visit started is noise, not a reminder.
   */
  readonly channels: readonly ReminderChannel[];
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
    channels: ['push', 'email'],
  },
  {
    rung: 'day_of_3h',
    leadMs: 3 * HOUR,
    column: 'reminded3hAt',
    purpose: 'Day-of nudge with directions and preparation notes',
    channels: ['push', 'email'],
  },
  {
    rung: 'running_late_15m',
    leadMs: 15 * MIN,
    column: 'nudged15mAt',
    purpose: 'Running late? nudge, naming the grace window',
    channels: ['push'],
  },
];

/**
 * The statuses the ladder CLAIMS. Only a live booking is worth reminding.
 *
 * One copy, imported by the claim SQL, so the scheduler and anything that
 * reasons about it cannot disagree about what "live" means.
 */
export const LADDER_STATUSES = ['confirmed', 'pending_payment'] as const;

/**
 * The statuses a reminder may still be DELIVERED for.
 *
 * Wider than the ladder by one: the desk's manual "remind" also reaches a
 * booking waiting for the customer's confirmation (an ask_each_time visit),
 * and a reminder the desk wrote must not be dropped as "not live" on its way
 * out. Anything else -- cancelled, no_show, checked_in -- means the visit
 * this reminder was about is no longer coming.
 */
export const REMINDER_LIVE_STATUSES = [
  ...LADDER_STATUSES,
  'pending_confirmation',
] as const;

/**
 * "With a payment prompt when anything is pending" (the 24h rung's purpose).
 * One rule, read by the claim's event payload and by the message copy.
 */
export function paymentPending(paymentStatus: string): boolean {
  return paymentStatus === 'unpaid';
}

export function rungSpec(rung: Rung): RungSpec {
  const spec = LADDER.find((s) => s.rung === rung);
  if (spec === undefined) throw new Error(`unknown reminder rung: ${rung}`);
  return spec;
}

export function isRung(value: string): value is Rung {
  return LADDER.some((s) => s.rung === value);
}

/** The lead time of the rung after this one; the last rung's is the start. */
function nextLeadMs(spec: RungSpec): number {
  const i = LADDER.findIndex((s) => s.rung === spec.rung);
  return LADDER[i + 1]?.leadMs ?? 0;
}

/**
 * When this rung's window closes for a visit starting at `startAtMs`.
 *
 * The same boundary `due` uses: the 24h reminder is only worth sending until
 * the 3h one takes over, and the 15m nudge until the visit starts. Anything
 * delivering a rung late uses this to know when "late" becomes "pointless".
 */
export function windowCloseMs(spec: RungSpec, startAtMs: number): number {
  return startAtMs - nextLeadMs(spec);
}

/**
 * The rungs that must be stamped before this one may be claimed.
 *
 * THE CLAIM ORDER IS THE FIX for a reminder that was marked handled and never
 * sent. A claim stamps its own column unconditionally, and `due` always
 * judges a booking from its FIRST outstanding rung. So a 3h claim on a
 * booking whose 24h rung was still open -- created or moved inside the
 * window between the 24h pass and the 3h pass of the same tick -- stamped
 * reminded_3h_at while `due` answered "skip" about the 24h rung. The 3h
 * message was gone. Claiming a rung only after every earlier one is stamped
 * means the 24h pass of the next tick skips its rung first, and the 3h pass
 * then claims its own.
 */
export function earlierColumns(spec: RungSpec): RungSpec['column'][] {
  const i = LADDER.findIndex((s) => s.rung === spec.rung);
  return LADDER.slice(0, i).map((s) => s.column);
}

/**
 * Whether the scheduler may claim this rung of this booking right now.
 *
 * The claim SQL in reminder.repository.ts is this predicate, built from the
 * same `earlierColumns` and `leadMs`; it is spelled out here so the rule can
 * be exercised without a database.
 */
export function claimable(
  spec: RungSpec,
  booking: BookingClock,
  nowMs: number,
): boolean {
  return (
    booking[spec.column] === null &&
    earlierColumns(spec).every((c) => booking[c] !== null) &&
    booking.startAtMs <= nowMs + spec.leadMs
  );
}

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
    const nextLead = nextLeadMs(spec);

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

export type ClaimVerdict =
  | Extract<RungVerdict, { kind: 'send' | 'skip' }>
  /**
   * NOT THIS RUNG'S TURN. The claim must be given back, never kept: keeping
   * it would stamp a rung as handled when nothing judged it.
   */
  | { readonly kind: 'release'; readonly why: string };

/**
 * The verdict for exactly the rung that was claimed, and no other.
 *
 * The claim has already stamped `spec.column`, so the booking is judged with
 * that rung read as outstanding. Whatever `due` answers about a DIFFERENT
 * rung is not this claim's business: it means the claim was premature, and
 * the answer is to release it.
 *
 *   24h claim -> only ever a 24h send or skip
 *   3h claim  -> only ever a 3h send or skip
 *   15m claim -> only ever a 15m send or skip
 */
export function claimVerdict(
  spec: RungSpec,
  booking: BookingClock,
  nowMs: number,
): ClaimVerdict {
  const v = due({ ...booking, [spec.column]: null }, nowMs);
  if (v.kind !== 'nothing' && v.spec.rung === spec.rung) return v;
  return {
    kind: 'release',
    why:
      v.kind === 'nothing'
        ? `${spec.rung} is not due yet`
        : `${v.spec.rung} is still outstanding, so ${spec.rung} is not next`,
  };
}

/** Every rung still outstanding, for a status view. */
export function pending(booking: BookingClock): Rung[] {
  return LADDER.filter((s) => booking[s.column] === null).map((s) => s.rung);
}

import type { BookingStatus } from './lifecycle';
import { checkInTiming } from './lifecycle';

/**
 * SELF CHECK-IN: the customer says "I am here", and the desk answers.
 *
 * A check-in request is that claim, on one booking. It never checks anybody
 * in by itself. The desk approves it, and approving runs the ordinary desk
 * check-in, so the state machine (lifecycle.ts), the status history and the
 * outbox event are exactly what a desk check-in writes. This file is only the
 * claim: when it may be raised, and how it ends.
 *
 * Built for both designs still on the table (a QR on the customer's pass, or
 * a QR on the chair). Neither is chosen, so nothing here knows about chairs.
 * A chair is one more column later, not a different flow.
 *
 * THE STATES. One open, four closed, and nothing leaves a closed state:
 *
 *   waiting    raised, and nobody has answered yet
 *   approved   the desk said yes; the booking is now CHECKED_IN
 *   rejected   the desk said no, with a reason; the booking is untouched
 *   expired    nobody answered before the booking's end time
 *   closed     the booking moved on another way before anybody answered
 *              (the desk used the ordinary check-in, or it was cancelled or
 *              moved)
 *
 * WHAT A RAISE BUYS THE CUSTOMER. The auto no-show sweeper leaves the booking
 * alone for as long as the LATEST request on it is anything but rejected.
 * Not only while it waits: a request that expired unanswered still means the
 * customer told us they were here, and a deposit taken automatically after we
 * ignored them is a dispute our own record would lose. Only the desk saying
 * no hands the booking back to the sweeper. That rule is SQL, because the
 * sweeper has to filter on it: see arrivalClaimed in
 * check-in-request.repository.ts.
 */
export type CheckInRequestState =
  | 'waiting'
  | 'approved'
  | 'rejected'
  | 'expired'
  | 'closed';

export const CHECK_IN_REQUEST_STATES: readonly CheckInRequestState[] = [
  'waiting',
  'approved',
  'rejected',
  'expired',
  'closed',
];

export type RaiseRefusal =
  /** The booking is not CONFIRMED: already checked in, cancelled, gone by. */
  | 'not_confirmed'
  /** The desk said no to this booking once. The customer goes to the desk. */
  | 'rejected_before'
  /** Check-in has not opened: the same window as the desk check-in. */
  | 'too_early'
  /** The booking's end time has passed. */
  | 'too_late';

export type RaiseVerdict =
  /** Raise a new request. */
  | { readonly kind: 'raise' }
  /** One is already waiting. Answer with it rather than raising a second. */
  | { readonly kind: 'already_waiting' }
  | {
      readonly kind: 'refused';
      readonly why: RaiseRefusal;
      /** Present on too_early: when to try again. */
      readonly opensAtMs?: number;
    };

/**
 * May the customer raise a check-in request on this booking NOW?
 *
 * Asked inside the booking's row lock, against the booking as the database
 * has it and the latest request on it, so two taps and the sweeper all see
 * the same facts.
 *
 * In this order, and each answer is the most useful one to give first:
 *
 *   1. not CONFIRMED      nothing to check in to, whatever else is true
 *   2. already waiting    a second tap is the same claim, not a new one
 *   3. rejected before    no second try after the desk said no: a raise, a
 *                         rejection, a raise again would hold the sweeper off
 *                         for as long as the customer kept tapping
 *   4. too early          check-in opens CHECK_IN_OPENS_MIN before the start,
 *                         asked of lifecycle.ts's own checkInTiming, so the
 *                         request opens when the desk check-in does and an
 *                         approval is never refused as too early
 *   5. too late           at or past the booking's end time
 *
 * A request that expired or was closed does not stop a new one. Closed means
 * the booking left CONFIRMED and came back (a check-in undone); expired means
 * the booking has ended, which 5 refuses anyway.
 */
export function raiseVerdict(input: {
  readonly bookingStatus: BookingStatus;
  readonly startAtMs: number;
  readonly endAtMs: number;
  readonly nowMs: number;
  /** The booking's latest request, or null if it never had one. */
  readonly latest: CheckInRequestState | null;
}): RaiseVerdict {
  if (input.bookingStatus !== 'confirmed') {
    return { kind: 'refused', why: 'not_confirmed' };
  }
  if (input.latest === 'waiting') return { kind: 'already_waiting' };
  if (input.latest === 'rejected') {
    return { kind: 'refused', why: 'rejected_before' };
  }

  const timing = checkInTiming({
    nowMs: input.nowMs,
    startAtMs: input.startAtMs,
  });
  if (timing.kind === 'too_early') {
    return { kind: 'refused', why: 'too_early', opensAtMs: timing.opensAtMs };
  }
  if (input.nowMs >= input.endAtMs) {
    return { kind: 'refused', why: 'too_late' };
  }
  return { kind: 'raise' };
}

export type Lapse =
  | { readonly to: 'closed'; readonly reason: string }
  | { readonly to: 'expired'; readonly reason: string };

/**
 * Does a WAITING request end on its own, and how?
 *
 * Asked by the lapse job of every waiting request, once a minute. Null: it
 * keeps waiting.
 *
 *   closed    the booking is no longer CONFIRMED. Somebody acted on the
 *             booking without answering the request. Checked first: a booking
 *             that was checked in at 10:58 and has ended by 11:01 was not
 *             ignored.
 *   expired   still CONFIRMED at or past its end time. Nobody answered.
 *
 * An expired request does NOT hand the booking to the auto no-show sweeper.
 * The desk closes it by hand. See the note at the top of this file.
 */
export function lapseOf(input: {
  readonly bookingStatus: BookingStatus;
  readonly endAtMs: number;
  readonly nowMs: number;
}): Lapse | null {
  if (input.bookingStatus !== 'confirmed') {
    return {
      to: 'closed',
      reason: `The booking became ${input.bookingStatus} before the desk answered.`,
    };
  }
  if (input.nowMs >= input.endAtMs) {
    return {
      to: 'expired',
      reason: 'Nobody answered before the booking ended.',
    };
  }
  return null;
}

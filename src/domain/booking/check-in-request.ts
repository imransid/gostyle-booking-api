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
 * THE STATES. One open, five closed, and nothing leaves a closed state:
 *
 *   waiting    raised, and nobody has answered yet
 *   approved   the desk said yes; the booking is now CHECKED_IN
 *   rejected   the desk said no, with a reason; the booking is untouched
 *   expired    nobody answered before the booking's end time
 *   closed     the booking moved on another way before anybody answered
 *              (the desk used the ordinary check-in, or it was cancelled or
 *              moved)
 *   withdrawn  the customer took it back before anybody answered (the app's
 *              Cancel Request): a wrong chair to scan again, or Wait for
 *              Staff instead. Not CANCELLED: the booking has a cancelled of
 *              its own, and a request reading CANCELLED on a CONFIRMED
 *              booking reads as the booking cancelled.
 *
 * WHAT A RAISE BUYS THE CUSTOMER. The auto no-show sweeper leaves the booking
 * alone for as long as the LATEST request on it is anything but rejected.
 * Not only while it waits: a request that expired unanswered still means the
 * customer told us they were here, and a deposit taken automatically after we
 * ignored them is a dispute our own record would lose. A withdrawn one too:
 * the customer who took it back to scan again is still standing in the
 * salon, and a no-show in the minute before they raise again would punish
 * them for correcting themselves. Only the desk saying no hands the booking
 * back to the sweeper. That rule is SQL, because the sweeper has to filter on
 * it: see arrivalClaimed in check-in-request.repository.ts.
 */
export type CheckInRequestState =
  'waiting' | 'approved' | 'rejected' | 'expired' | 'closed' | 'withdrawn';

/** In the order of the database enum, which only ever appends. */
export const CHECK_IN_REQUEST_STATES: readonly CheckInRequestState[] = [
  'waiting',
  'approved',
  'rejected',
  'expired',
  'closed',
  'withdrawn',
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
 * A request that expired, was closed or was withdrawn does not stop a new
 * one. Closed means the booking left CONFIRMED and came back (a check-in
 * undone); expired means the booking has ended, which 5 refuses anyway.
 * Withdrawn means the customer took it back, and nobody at the desk said no:
 * asking again (another chair, or Wait for Staff) is the point of taking it
 * back.
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

export type WithdrawVerdict =
  /** Withdraw the waiting request. */
  | { readonly kind: 'withdraw' }
  /** Already withdrawn: a second tap, answered with the same request. */
  | { readonly kind: 'already_withdrawn' }
  /** Nothing is waiting: none was raised, or it was answered or ended. */
  | { readonly kind: 'refused'; readonly why: 'nothing_waiting' }
  /**
   * It still says waiting, but it has lapsed: the lapse job ends it the next
   * minute, and this is how (lapseOf's own answer).
   */
  | { readonly kind: 'refused'; readonly why: 'lapsed'; readonly lapse: Lapse };

/**
 * May the customer take back their request NOW?
 *
 * Asked inside the request's row lock, against the booking's latest request
 * and the booking as the database has it.
 *
 *   1. withdrawn already   a second tap is the same act, whatever has
 *                          happened to the booking since
 *   2. nothing waiting     approved, rejected, expired and closed are
 *                          answers, and an answer is not taken back here
 *   3. lapsed              lapseOf, the job's own rule, so the two can never
 *                          disagree: the booking moved on (the desk checked
 *                          them in with the ordinary button, or it was
 *                          cancelled) or it has ended. The request is the
 *                          job's to close or expire, and what it writes is
 *                          what happened. A withdrawal there would hide it:
 *                          an expired request is the desk not answering, and
 *                          the desk is shown how often that happens.
 *
 * No window of its own and no count. A waiting request was raised inside the
 * check-in window, and its end is lapseOf's (3). Raising again after a
 * withdrawal is the point, so there is no limit on how often.
 */
export function withdrawVerdict(input: {
  /** The booking's latest request, or null if it never had one. */
  readonly latest: CheckInRequestState | null;
  readonly bookingStatus: BookingStatus;
  readonly endAtMs: number;
  readonly nowMs: number;
}): WithdrawVerdict {
  if (input.latest === 'withdrawn') return { kind: 'already_withdrawn' };
  if (input.latest !== 'waiting') {
    return { kind: 'refused', why: 'nothing_waiting' };
  }
  const lapse = lapseOf(input);
  if (lapse !== null) return { kind: 'refused', why: 'lapsed', lapse };
  return { kind: 'withdraw' };
}

/**
 * The desk's reason for a rejection, as it is stored: trimmed, and null when
 * there is nothing left, which the desk is told to fill in ("Choose a
 * reason", as lifecycle.ts says for any move that needs one). The table
 * refuses a blank one too (check_in_request_rejection_says_why); this keeps
 * that from ever being the answer the desk sees.
 */
export function rejectionReason(raw: string | null | undefined): string | null {
  const reason = (raw ?? '').trim();
  return reason === '' ? null : reason;
}

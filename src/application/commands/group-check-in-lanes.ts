import type { BookingError } from '@application/contract/errors';
import {
  raiseRefusalError,
  type RaiseRefused,
} from '@application/commands/check-in-refusal';
import type { RaiseOutcome } from '@infrastructure/persistence/check-in-request.repository';

/** A booking's status, as a refused raise reports it. */
type BookingStatus = RaiseRefused['bookingStatus'];

/** The request a lane raised or found waiting, exactly as raise gave it. */
type RequestRow = Extract<RaiseOutcome, { kind: 'raised' }>['request'];

/**
 * What happened to ONE lane of a party when the booker said "we are here".
 *
 *   RAISED      a request was raised now
 *   WAITING     one was already waiting, nothing new
 *   CHECKED_IN  the person already came (checked in, in service, or done)
 *   LEFT        the lane is no longer a visit today (cancelled, no-show, ...)
 *   REFUSED     the single route's own refusal, in its own words
 */
export type LaneOutcome =
  | { readonly outcome: 'RAISED'; readonly request: RequestRow }
  | { readonly outcome: 'WAITING'; readonly request: RequestRow }
  | { readonly outcome: 'CHECKED_IN' }
  | { readonly outcome: 'LEFT' }
  | { readonly outcome: 'REFUSED'; readonly error: BookingError };

/**
 * Where each status sends a lane that raise refused as not_confirmed.
 *
 * A Record over EVERY status, not two short lists: a status added to the
 * schema later fails the build here until someone decides where it goes,
 * instead of silently landing in REFUSED.
 *
 * confirmed is listed only to make the Record complete: raise never refuses
 * a confirmed booking as not_confirmed.
 */
const STATUS_GROUP: Readonly<
  Record<BookingStatus, 'arrived' | 'left' | 'refused'>
> = {
  draft: 'refused',
  held: 'refused',
  pending_payment: 'refused',
  pending_confirmation: 'refused',
  confirmed: 'refused',
  checked_in: 'arrived',
  in_service: 'arrived',
  completed: 'arrived',
  settled: 'arrived',
  cancelled: 'left',
  no_show: 'left',
  rescheduled: 'left',
  expired: 'left',
  skipped: 'left',
};

/**
 * One lane's outcome, from what raise answered for it.
 *
 * Every rule (status, rejected before, the window) was already decided by
 * raise, inside the booking's lock. This only sorts the answer; it decides
 * nothing of its own.
 *
 * not_found and chair_refused cannot happen for a lane (the lane id comes
 * from the party's own rows, and a party sends no chair), so they are a bug
 * and thrown, never hidden as a lane outcome.
 */
export function laneOutcome(out: RaiseOutcome): LaneOutcome {
  switch (out.kind) {
    case 'raised':
      return { outcome: 'RAISED', request: out.request };
    case 'already_waiting':
      return { outcome: 'WAITING', request: out.request };
    case 'refused': {
      if (out.why === 'not_confirmed') {
        const group = STATUS_GROUP[out.bookingStatus];
        if (group === 'arrived') return { outcome: 'CHECKED_IN' };
        if (group === 'left') return { outcome: 'LEFT' };
      }
      return { outcome: 'REFUSED', error: raiseRefusalError(out) };
    }
    case 'not_found':
    case 'chair_refused':
      throw new Error(
        `group check-in: a lane answered ${out.kind}, which cannot happen`,
      );
  }
}

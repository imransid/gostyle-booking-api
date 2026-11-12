import { voidsTicket, type SyncBookingStatus } from './pos-ticket-request';

/**
 * What a failed send to the platform's POS means for its sync row.
 *
 *   retry             no verdict: the platform was down, slow, or broke
 *                     while answering. Send again after a backoff, with NO
 *                     attempt limit -- a ticket that gave up is a customer
 *                     the till cannot charge.
 *   next_trading_day  the branch's trading day is closed on the till (the Z
 *                     is signed, or the storefront is shut). Nothing a
 *                     person need do: the next day opens it.
 *   park              the platform read the request and refused it. It will
 *                     refuse it again until a person fixes the cause (a
 *                     service the tenant does not own, an unknown branch),
 *                     then requeues it. Holds back the booking's later rows.
 *   nothing_to_do     a void for a booking with no live ticket: there is
 *                     nothing to void, which is the outcome a void wants.
 *
 * Pure. The adapter reports the gRPC status by NAME and the platform's own
 * code from the `error-code` trailer; this decides.
 */
export interface SyncFailure {
  /** 'UNAVAILABLE', 'FAILED_PRECONDITION', ...; null for no gRPC status
   *  (a timeout, a local refusal such as a missing key). */
  readonly grpcStatus: string | null;
  /** The platform's code (POS_Z_IMMUTABLE, ...), or null. */
  readonly errorCode: string | null;
}

export type SyncVerdict =
  | { readonly kind: 'retry' }
  | { readonly kind: 'next_trading_day' }
  | { readonly kind: 'park'; readonly code: string }
  | { readonly kind: 'nothing_to_do' };

/**
 * NO VERDICT. UNAUTHENTICATED and UNIMPLEMENTED are here too, unlike the
 * journal's REFUSED: they are SETUP faults (the key differs between the two
 * services, or the platform is older than pos_booking.proto) that nothing
 * about the request can fix, and every row would park until somebody
 * requeued each one. Retried, they flow on their own the moment the setup is
 * fixed; the worker logs them at ERROR meanwhile.
 */
const NO_VERDICT: ReadonlySet<string> = new Set([
  'UNAVAILABLE',
  'DEADLINE_EXCEEDED',
  'UNKNOWN',
  'INTERNAL',
  'RESOURCE_EXHAUSTED',
  'ABORTED',
  'CANCELLED',
  'UNAUTHENTICATED',
  'UNIMPLEMENTED',
]);

const DAY_CLOSED: ReadonlySet<string> = new Set([
  'POS_Z_IMMUTABLE',
  'POS_BRANCH_CLOSED',
]);

/**
 * A status for a booking whose open has not landed yet (the relay delivered
 * a later event first, after a failed attempt). Worth a few backed-off
 * tries for the open to catch up; past that, a person looks.
 */
export const TICKET_NOT_FOUND_RETRIES = 5;

export function classifySyncFailure(
  failure: SyncFailure,
  row: {
    readonly bookingStatus: SyncBookingStatus;
    /** Failed sends so far, not counting this one. */
    readonly attempts: number;
  },
): SyncVerdict {
  const code = failure.errorCode;

  if (code !== null && DAY_CLOSED.has(code)) {
    return { kind: 'next_trading_day' };
  }

  if (code === 'POS_BOOKING_TICKET_NOT_FOUND') {
    if (voidsTicket(row.bookingStatus)) return { kind: 'nothing_to_do' };
    return row.attempts + 1 < TICKET_NOT_FOUND_RETRIES
      ? { kind: 'retry' }
      : { kind: 'park', code };
  }

  if (failure.grpcStatus === null || NO_VERDICT.has(failure.grpcStatus)) {
    return { kind: 'retry' };
  }

  return { kind: 'park', code: code ?? failure.grpcStatus };
}

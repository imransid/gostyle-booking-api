import { Inject, Injectable, Logger } from '@nestjs/common';
import { shout, type Shouted } from '@application/contract/wire';
import { bookingError } from '@application/contract/errors';
import type { ActorKind } from '@domain/booking/lifecycle';
import type { CheckInRequestState } from '@domain/booking/check-in-request';
import {
  customerReason,
  customerSentence,
  type ChairRefusal,
  type CustomerChairReason,
  type ScannedChair,
} from '@domain/booking/chair-check-in';
import {
  CHAIR_DIRECTORY,
  type ChairDirectory,
} from '@application/ports/chair-directory.port';
import {
  CheckInRequestRepository,
  type CheckInRequestRow,
} from '@infrastructure/persistence/check-in-request.repository';

/**
 * A check-in request as the customer sees it.
 *
 * NO REASON. A rejection's reason is the desk's own words, written for the
 * desk ("not at the salon", "wrong Amira") and not for the customer's
 * screen; expired and closed carry the system's. The app says its own
 * sentence for each state.
 */
export interface CheckInRequestView {
  readonly requestId: string;
  readonly bookingId: string;
  readonly state: Shouted<CheckInRequestState>;
  readonly raisedAt: string;
  /** Null while WAITING. */
  readonly decidedAt: string | null;
  /**
   * The chair claimed with this request, as it was when it was scanned
   * ("7", "Window section"); null for a request with no chair.
   */
  readonly chair: {
    readonly number: string;
    readonly zoneName: string | null;
  } | null;
}

export function viewOf(row: CheckInRequestRow): CheckInRequestView {
  return {
    requestId: row.id,
    bookingId: row.bookingId,
    state: shout(row.state),
    raisedAt: row.raisedAt.toISOString(),
    decidedAt: row.decidedAt === null ? null : row.decidedAt.toISOString(),
    chair:
      row.chairId === null || row.chairNumber === null
        ? null
        : { number: row.chairNumber, zoneName: row.chairZoneName },
  };
}

/**
 * Why a chair was refused, as the app reads it: the rule's reasons
 * (customerReason), and the one the rule never sees, a code platform never
 * printed.
 */
export type ChairWireReason = CustomerChairReason | 'UNKNOWN_CARD';

/** A code that is not a chair card platform printed: the pass, a poster. */
const UNKNOWN_CARD_SENTENCE =
  'This is not a chair card we know. Please scan the card on your chair, ' +
  'or see the desk.';

/**
 * Platform did not answer. NOT "check-in is broken": the app falls back to
 * Wait for Staff, which is this same request with no chairToken, answered
 * by the desk, and never calls platform. The sentence says so, because a
 * customer who reads only "try again" walks out.
 */
const CHAIR_CHECK_UNAVAILABLE_SENTENCE =
  'We could not check this chair just now. Please use Wait for Staff and ' +
  'the desk will check you in.';

/** Cancel Request on a request that was answered, or ended on its own. */
const REQUEST_ENDED_SENTENCE = 'This request has already ended.';

/**
 * Cancel Request with none ever raised: an app bug, but the sentence must
 * still be true, and nothing has ended.
 */
const NO_REQUEST_SENTENCE = 'There is no check-in request to cancel.';

/**
 * Self check-in for the customer: say "I am here", take it back, and read
 * the answer.
 *
 * Whose booking it is has been asked before this runs (the controller's
 * scope check). This only raises, withdraws and reads.
 */
@Injectable()
export class CheckInRequestHandler {
  private readonly logger = new Logger(CheckInRequestHandler.name);

  constructor(
    private readonly requests: CheckInRequestRepository,
    @Inject(CHAIR_DIRECTORY) private readonly chairs: ChairDirectory,
  ) {}

  /**
   * `created` is false when a request was already waiting: the same claim,
   * answered with the same request, so a second tap is harmless.
   *
   * WITH A CHAIR, platform is asked FIRST, before the booking's row lock is
   * taken: it is a network call, and the lock would be held for as long as
   * platform took. Asked once: every answered call is a scan in the salon's
   * registry, so a second tap is a second real scan, never a retry.
   */
  async raise(cmd: {
    readonly bookingId: string;
    readonly actor: ActorKind;
    readonly actorId: string;
    /** The raw token off the chair's card. Absent: no chair. */
    readonly chairToken?: string;
    /** The app's user agent, for the scan row. */
    readonly userAgent?: string | null;
    /** Test hook only. A route never passes the caller's clock. */
    readonly nowMs?: number;
  }): Promise<{ created: boolean; request: CheckInRequestView }> {
    const chair =
      cmd.chairToken === undefined
        ? undefined
        : await this.scanned(cmd.bookingId, cmd.chairToken, cmd.userAgent);

    const out = await this.requests.raise({
      bookingId: cmd.bookingId,
      actor: cmd.actor,
      actorId: cmd.actorId,
      ...(chair !== undefined ? { chair } : {}),
      ...(cmd.nowMs !== undefined ? { nowMs: cmd.nowMs } : {}),
    });

    switch (out.kind) {
      case 'raised':
        return { created: true, request: viewOf(out.request) };
      case 'already_waiting':
        return { created: false, request: viewOf(out.request) };
      case 'not_found':
        throw bookingError('BOOKING_NOT_FOUND', 'No such booking');
      case 'chair_refused': {
        // Platform's words (the card status, the chair state) and another
        // customer's booking go to the log, never to the app: it gets one
        // sentence and one reason of ours (chair-check-in.ts).
        const { why } = out.refusal;
        this.logger.log(
          `Chair claim refused on booking ${cmd.bookingId}: ${why}` +
            ` (${refusalDetail(out.refusal)})`,
        );
        throw bookingError('BOOKING_CHAIR_REFUSED', customerSentence(why), {
          reason: customerReason(why) satisfies ChairWireReason,
        });
      }
      case 'refused':
        switch (out.why) {
          case 'not_confirmed':
            throw bookingError(
              'BOOKING_STATE_INVALID',
              `A ${out.bookingStatus} booking cannot be checked in.`,
              { status: shout(out.bookingStatus) },
            );
          case 'rejected_before':
            throw bookingError(
              'BOOKING_CHECKIN_REJECTED',
              'The desk could not confirm your arrival. Please speak to ' +
                'the desk.',
            );
          case 'too_early': {
            // The desk check-in's own sentence and detail
            // (lifecycle.handler.ts), so the app reads one shape for both.
            const opensAt = new Date(out.opensAtMs ?? 0).toISOString();
            throw bookingError(
              'BOOKING_CHECKIN_WINDOW',
              `Check-in opens at ${opensAt}.`,
              { windowOpensAt: opensAt },
            );
          }
          case 'too_late':
            throw bookingError(
              'BOOKING_CHECKIN_WINDOW',
              'Check-in for this booking has closed.',
              { windowClosed: true },
            );
        }
    }
  }

  /**
   * The chair behind a scanned token, or the refusal. Only a found chair
   * goes on to the booking's own rules; the other two answers end here.
   */
  private async scanned(
    bookingId: string,
    token: string,
    userAgent: string | null | undefined,
  ): Promise<ScannedChair> {
    const found = await this.chairs.resolve(token, userAgent ?? null);
    switch (found.kind) {
      case 'found':
        return found.chair;
      case 'unknown_card':
        this.logger.log(
          `Chair claim on booking ${bookingId}: not a card platform printed`,
        );
        throw bookingError('BOOKING_CHAIR_REFUSED', UNKNOWN_CARD_SENTENCE, {
          reason: 'UNKNOWN_CARD' satisfies ChairWireReason,
        });
      case 'unavailable':
        // Logged by the adapter already: a setup fault once per process, and
        // platform trouble once per scan. Not again here.
        throw bookingError(
          'DEPENDENCY_UNAVAILABLE',
          CHAIR_CHECK_UNAVAILABLE_SENTENCE,
          { reason: 'CHAIR_CHECK_UNAVAILABLE', fallback: 'WAIT_FOR_STAFF' },
        );
    }
  }

  /**
   * The customer takes their request back: the app's Cancel Request.
   *
   * Withdrawn, and a second tap, answer with the request. Anything else is
   * BOOKING_STATE_INVALID, and its details.request is the request's state AS
   * IT NOW IS, so the app moves on at once:
   *
   *   lapsed            the desk checked them in with its own button, or the
   *                     end time passed. The repository has just made the
   *                     lapse job's own write (CLOSED or EXPIRED, by the
   *                     system, never a withdrawal); that state is the one
   *                     sent, not the WAITING it was a moment ago.
   *   nothing waiting   the latest state, already answered or ended. Null
   *                     when none was ever raised, with its own sentence:
   *                     nothing has ended.
   */
  async withdraw(cmd: {
    readonly bookingId: string;
    readonly actorId: string;
    /** Test hook only. A route never passes the caller's clock. */
    readonly nowMs?: number;
  }): Promise<{ request: CheckInRequestView }> {
    const out = await this.requests.withdraw({
      bookingId: cmd.bookingId,
      actorId: cmd.actorId,
      ...(cmd.nowMs !== undefined ? { nowMs: cmd.nowMs } : {}),
    });

    switch (out.kind) {
      case 'withdrawn':
      case 'already_withdrawn':
        return { request: viewOf(out.request) };
      case 'not_found':
        throw bookingError('BOOKING_NOT_FOUND', 'No such booking');
      case 'lapsed':
        throw bookingError('BOOKING_STATE_INVALID', REQUEST_ENDED_SENTENCE, {
          request: shout(out.request.state),
        });
      case 'nothing_waiting':
        throw out.latest === null
          ? bookingError('BOOKING_STATE_INVALID', NO_REQUEST_SENTENCE, {
              request: null,
            })
          : bookingError('BOOKING_STATE_INVALID', REQUEST_ENDED_SENTENCE, {
              request: shout(out.latest),
            });
    }
  }

  /** The booking's latest request, or null if it never had one. */
  async latest(bookingId: string): Promise<CheckInRequestView | null> {
    const row = await this.requests.latestFor(bookingId);
    return row === null ? null : viewOf(row);
  }
}

/** A refusal's own detail, for the log line only. */
function refusalDetail(refusal: ChairRefusal): string {
  switch (refusal.why) {
    case 'card_out_of_date':
      return `card ${refusal.cardStatus || "''"}`;
    case 'other_salon':
      return refusal.which;
    case 'chair_not_bookable':
      return `chair state ${refusal.chairState ?? 'none'}`;
    case 'chair_occupied':
      return `${refusal.occupant} is in it`;
  }
}

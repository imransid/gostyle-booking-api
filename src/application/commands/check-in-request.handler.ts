import { Injectable } from '@nestjs/common';
import { shout, type Shouted } from '@application/contract/wire';
import { bookingError } from '@application/contract/errors';
import type { ActorKind } from '@domain/booking/lifecycle';
import type { CheckInRequestState } from '@domain/booking/check-in-request';
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
}

export function viewOf(row: CheckInRequestRow): CheckInRequestView {
  return {
    requestId: row.id,
    bookingId: row.bookingId,
    state: shout(row.state),
    raisedAt: row.raisedAt.toISOString(),
    decidedAt: row.decidedAt === null ? null : row.decidedAt.toISOString(),
  };
}

/**
 * Self check-in for the customer: say "I am here", and read the answer.
 *
 * Whose booking it is has been asked before this runs (the controller's
 * scope check). This only raises and reads.
 */
@Injectable()
export class CheckInRequestHandler {
  constructor(private readonly requests: CheckInRequestRepository) {}

  /**
   * `created` is false when a request was already waiting: the same claim,
   * answered with the same request, so a second tap is harmless.
   */
  async raise(cmd: {
    readonly bookingId: string;
    readonly actor: ActorKind;
    readonly actorId: string;
    /** Test hook only. A route never passes the caller's clock. */
    readonly nowMs?: number;
  }): Promise<{ created: boolean; request: CheckInRequestView }> {
    const out = await this.requests.raise({
      bookingId: cmd.bookingId,
      actor: cmd.actor,
      actorId: cmd.actorId,
      ...(cmd.nowMs !== undefined ? { nowMs: cmd.nowMs } : {}),
    });

    switch (out.kind) {
      case 'raised':
        return { created: true, request: viewOf(out.request) };
      case 'already_waiting':
        return { created: false, request: viewOf(out.request) };
      case 'not_found':
        throw bookingError('BOOKING_NOT_FOUND', 'No such booking');
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

  /** The booking's latest request, or null if it never had one. */
  async latest(bookingId: string): Promise<CheckInRequestView | null> {
    const row = await this.requests.latestFor(bookingId);
    return row === null ? null : viewOf(row);
  }
}

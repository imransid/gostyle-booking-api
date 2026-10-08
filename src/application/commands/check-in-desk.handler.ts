import { Injectable } from '@nestjs/common';
import { shout, type Shouted } from '@application/contract/wire';
import { bookingError } from '@application/contract/errors';
import type { ActorKind, BookingStatus } from '@domain/booking/lifecycle';
import type { ScopedBooking } from '@domain/booking/booking-scope';
import { rejectionReason } from '@domain/booking/check-in-request';
import {
  CheckInRequestRepository,
  type CheckInRequestRow,
  type NothingToAnswer,
  type ReceptionRow,
} from '@infrastructure/persistence/check-in-request.repository';
import { LifecycleHandler, type LifecycleView } from './lifecycle.handler';
import { viewOf, type CheckInRequestView } from './check-in-request.handler';

/**
 * A check-in request as the DESK sees it: the customer's view, plus who
 * answered and the reason. The reason is the desk's own words, so it is
 * shown here and never on the customer's side.
 */
export interface DeskRequestView extends CheckInRequestView {
  readonly decidedByKind: Shouted<ActorKind> | null;
  readonly decidedById: string | null;
  readonly reason: string | null;
}

/** One line of the reception list. */
export interface ReceptionItem {
  readonly request: DeskRequestView;
  readonly booking: {
    readonly bookingId: string;
    readonly code: string;
    readonly status: Shouted<BookingStatus>;
    readonly startAt: string;
    readonly endAt: string;
    readonly customerId: string;
  };
}

/**
 * A reception line with what the scope check needs to know about its
 * booking. The controller keeps the lines the caller may see (BookingScope
 * .keepInScope) and sends only `item`: the booking's tenant is not shown.
 */
export interface ReceptionEntry {
  readonly item: ReceptionItem;
  readonly scope: ScopedBooking;
}

export function deskViewOf(row: CheckInRequestRow): DeskRequestView {
  return {
    ...viewOf(row),
    decidedByKind: row.decidedByKind === null ? null : shout(row.decidedByKind),
    decidedById: row.decidedById,
    reason: row.reason,
  };
}

/**
 * Self check-in for the desk: approve, reject, and the reception list.
 *
 * Whose booking it is has been asked before this runs (the controller's
 * scope check, always on).
 */
@Injectable()
export class CheckInDeskHandler {
  constructor(
    private readonly requests: CheckInRequestRepository,
    private readonly lifecycle: LifecycleHandler,
  ) {}

  /**
   * Yes. THE EXISTING CHECK-IN FIRST, the one POST /v1/bookings/:id/check-in
   * runs (its timing gate, the state machine, the history row and the outbox
   * event, all unchanged), and only then the request is marked approved.
   * Anything the check-in refuses is the answer, and the request still waits.
   */
  async approve(cmd: {
    readonly bookingId: string;
    readonly actor: ActorKind;
    readonly actorId: string;
  }): Promise<{ request: DeskRequestView; checkIn: LifecycleView }> {
    const out = await this.requests.approveWith(
      {
        bookingId: cmd.bookingId,
        deciderKind: cmd.actor,
        deciderId: cmd.actorId,
      },
      () =>
        this.lifecycle.execute({
          bookingId: cmd.bookingId,
          to: 'checked_in',
          actor: cmd.actor,
          actorId: cmd.actorId,
        }),
    );
    if (out.kind !== 'approved') refuse(out);
    return { request: deskViewOf(out.request), checkIn: out.checkIn };
  }

  /**
   * No, with a reason. The booking is untouched and goes back to the
   * ordinary rules, the auto no-show sweeper included; the customer may not
   * raise again (BOOKING_CHECKIN_REJECTED on their side).
   */
  async reject(cmd: {
    readonly bookingId: string;
    readonly actor: ActorKind;
    readonly actorId: string;
    readonly reason: string | undefined;
  }): Promise<{ request: DeskRequestView }> {
    const reason = rejectionReason(cmd.reason);
    if (reason === null) {
      // lifecycle.ts's own words for a move that needs a reason.
      throw bookingError('BOOKING_REASON_REQUIRED', 'Choose a reason');
    }
    const out = await this.requests.reject({
      bookingId: cmd.bookingId,
      deciderKind: cmd.actor,
      deciderId: cmd.actorId,
      reason,
    });
    if (out.kind !== 'rejected') refuse(out);
    return { request: deskViewOf(out.request) };
  }

  /** The branch's reception list, both halves, before the scope check. */
  async reception(
    branchId: string,
  ): Promise<{ waiting: ReceptionEntry[]; needsDecision: ReceptionEntry[] }> {
    const list = await this.requests.listForBranch(branchId, Date.now());
    return {
      waiting: list.waiting.map(entryOf),
      needsDecision: list.needsDecision.map(entryOf),
    };
  }
}

function refuse(out: NothingToAnswer): never {
  if (out.kind === 'not_found') {
    throw bookingError('BOOKING_NOT_FOUND', 'No such booking');
  }
  throw bookingError(
    'BOOKING_STATE_INVALID',
    'No check-in request is waiting on this booking.',
    { request: out.latest === null ? null : shout(out.latest) },
  );
}

function entryOf(row: ReceptionRow): ReceptionEntry {
  return {
    item: {
      request: deskViewOf(row.request),
      booking: {
        bookingId: row.booking.id,
        code: row.booking.code,
        status: shout(row.booking.status),
        startAt: row.booking.startAt.toISOString(),
        endAt: row.booking.endAt.toISOString(),
        customerId: row.booking.customerId,
      },
    },
    scope: {
      customerId: row.booking.customerId,
      tenantId: row.booking.tenantId,
      branchId: row.booking.branchId,
    },
  };
}

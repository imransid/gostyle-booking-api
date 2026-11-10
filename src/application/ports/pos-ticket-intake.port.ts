import type {
  OpenTicketForBookingRequest,
  UpdateBookingStatusRequest,
} from '@domain/pos/pos-ticket-request';

export type { OpenTicketForBookingRequest, UpdateBookingStatusRequest };

/**
 * The platform's POS, as booking-api needs it (proto/pos_booking.proto,
 * PosBookingIntake): open a booked visit's ticket at check-in, mirror the
 * visit's later moves onto it, and read it back.
 *
 * OWNED BY THE HANDLERS (CLAUDE.md 7): PosTicketSyncHandler sends, the
 * safety net reads. No repository ever sees it.
 *
 * Every call is safe to retry: the platform answers an open for a booking
 * that already has a live ticket with that ticket, and a status the ticket
 * already carries with `replayed`.
 */
export interface TicketRef {
  readonly ticketId: string;
  /** "#T-42" */
  readonly number: string;
  /** The platform's TicketState name: OPEN | READY | VOIDED | ... */
  readonly state: string;
  /** True when nothing new was written. */
  readonly replayed: boolean;
}

export interface TicketDocument {
  /** RECEIPT | INVOICE */
  readonly type: string;
  readonly number: string;
}

export interface TicketForBooking {
  readonly found: boolean;
  readonly ticketId: string | null;
  readonly number: string | null;
  readonly state: string | null;
  readonly paidAt: string | null;
  readonly cashierId: string | null;
  readonly totalMinor: number;
  readonly depositAppliedMinor: number;
  readonly depositAppliedVatMinor: number;
  readonly documents: readonly TicketDocument[];
}

/**
 * Every failure, normalised: the gRPC status by NAME and the platform's own
 * code from the `error-code` trailer, which is what
 * domain/pos/pos-sync-outcome.ts decides on. A local refusal (no key) has no
 * status and an errorCode of ours.
 */
export class PosIntakeFailure extends Error {
  constructor(
    readonly grpcStatus: string | null,
    readonly errorCode: string | null,
    message: string,
  ) {
    super(message);
    this.name = 'PosIntakeFailure';
  }
}

export interface PosTicketIntake {
  openTicketForBooking(
    request: OpenTicketForBookingRequest,
  ): Promise<TicketRef>;
  updateBookingStatus(request: UpdateBookingStatusRequest): Promise<TicketRef>;
  getTicketForBooking(
    tenantId: string,
    bookingId: string,
  ): Promise<TicketForBooking>;
}

export const POS_TICKET_INTAKE = Symbol('POS_TICKET_INTAKE');

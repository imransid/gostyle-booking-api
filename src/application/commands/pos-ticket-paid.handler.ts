import { Injectable, Logger } from '@nestjs/common';
import { bookingError } from '@application/contract/errors';
import { LifecycleRepository } from '@infrastructure/persistence/lifecycle.repository';

/**
 * The till's word that a booked visit is paid (gostyle-platform
 * docs/booking-pos-tickets-plan.md, B6), from the platform's paid callback
 * (POST /v1/internal/pos/ticket-paid) or read back from the ticket by the
 * safety net (B10) when that callback never came.
 */
export interface PosTicketPaid {
  readonly tenantId: string;
  readonly bookingId: string;
  readonly ticketId: string;
  /** "#T-42" */
  readonly ticketNumber: string;
  readonly paidAt: string | null;
  /** The cashier who took the money: the staff actor of the settlement. */
  readonly cashierId: string;
  readonly totalMinor: number;
  readonly depositAppliedMinor: number;
  readonly depositAppliedVatMinor: number;
  readonly documents: readonly {
    readonly type: string;
    readonly number: string;
  }[];
}

export interface PosTicketPaidView {
  readonly bookingId: string;
  readonly code: string;
  readonly status: 'settled';
  /** The same ticket's payment, again: nothing was written this time. */
  readonly alreadySettled: boolean;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Completed -> settled, as the till did it. The POS owns the bill: this
 * records the deposit it applied (and the VAT it reversed on it), credits
 * whatever of the deposit the bill did not need to the wallet, and moves
 * the booking to settled with the cashier as the staff actor. The receipt
 * and invoice numbers go into the history row.
 *
 * Every refusal is a BookingError, so the callback answers the platform
 * with a code it branches on (409 ALREADY_SETTLED is "done", anything else
 * is retried), and the safety net logs the same code.
 */
@Injectable()
export class PosTicketPaidHandler {
  private static readonly log = new Logger(PosTicketPaidHandler.name);

  constructor(private readonly lifecycle: LifecycleRepository) {}

  async settle(paid: PosTicketPaid): Promise<PosTicketPaidView> {
    for (const id of [paid.bookingId, paid.tenantId]) {
      if (!UUID_RE.test(id)) {
        throw bookingError('BOOKING_NOT_FOUND', 'No such booking');
      }
    }

    const outcome = await this.lifecycle.settleFromPos({
      tenantId: paid.tenantId,
      bookingId: paid.bookingId,
      ticketId: paid.ticketId,
      ticketNumber: paid.ticketNumber,
      cashierId: paid.cashierId,
      depositAppliedFils: paid.depositAppliedMinor,
      depositAppliedVatFils: paid.depositAppliedVatMinor,
      historyMetadata: {
        pos: {
          ticketId: paid.ticketId,
          ticketNumber: paid.ticketNumber,
          paidAt: paid.paidAt,
          totalMinor: paid.totalMinor,
          depositAppliedMinor: paid.depositAppliedMinor,
          depositAppliedVatMinor: paid.depositAppliedVatMinor,
          documents: paid.documents.map((d) => ({
            type: d.type,
            number: d.number,
          })),
        },
      },
    });

    switch (outcome.kind) {
      case 'settled':
        if (!outcome.alreadySettled) {
          PosTicketPaidHandler.log.log(
            `${outcome.code} settled by POS ticket ${paid.ticketNumber}: ` +
              `${paid.depositAppliedMinor} fils of deposit applied` +
              (paid.documents.length > 0
                ? ` (${paid.documents.map((d) => d.number).join(', ')})`
                : ''),
          );
        }
        return {
          bookingId: paid.bookingId,
          code: outcome.code,
          status: 'settled',
          alreadySettled: outcome.alreadySettled,
        };
      case 'not_found':
        throw bookingError('BOOKING_NOT_FOUND', 'No such booking');
      case 'settled_by_other':
        PosTicketPaidHandler.log.error(
          `${outcome.code} was already settled by another ticket; ` +
            `POS ticket ${paid.ticketNumber} (${paid.ticketId}) paid for ` +
            'it too. Two tills took money for one visit: refund one.',
        );
        throw bookingError(
          'ALREADY_SETTLED',
          `${outcome.code} is already settled by another ticket.`,
          { ticketId: paid.ticketId },
        );
      case 'not_completed':
        throw bookingError(
          'BOOKING_STATE_INVALID',
          `A booking is settled from completed; this one is ${outcome.status}.`,
          { status: outcome.status },
        );
      case 'refused':
        // The till has the money and the books disagree with it: at ERROR,
        // because nothing settles this booking until a person looks.
        PosTicketPaidHandler.log.error(
          `POS ticket ${paid.ticketNumber} for booking ` +
            `${paid.bookingId.slice(0, 8)} refused (${outcome.code}): ` +
            outcome.reason,
        );
        throw bookingError('BOOKING_STATE_INVALID', outcome.reason, {
          reason: outcome.code,
        });
      case 'illegal':
      case 'forbidden':
      case 'needs_reason':
        throw bookingError('BOOKING_STATE_INVALID', outcome.message);
    }
  }
}

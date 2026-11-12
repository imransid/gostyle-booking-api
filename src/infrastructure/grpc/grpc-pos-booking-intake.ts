import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ClientGrpc } from '@nestjs/microservices';
import { Metadata } from '@grpc/grpc-js';
import { Observable } from 'rxjs';

import { callWithRetry, type GrpcCallOptions } from './call-with-retry';
import { describeGrpcFailure, grpcStatusName } from './grpc-failure';
import { blankToNull } from './blank-to-null';
import { journalErrorCode } from './grpc-journal-ledger';
import { POS_BOOKING_INTAKE_CLIENT } from './pos-booking-grpc.constants';
import {
  PosIntakeFailure,
  type OpenTicketForBookingRequest,
  type PosTicketIntake,
  type TicketForBooking,
  type TicketRef,
  type UpdateBookingStatusRequest,
} from '@application/ports/pos-ticket-intake.port';

/** The wire shapes, snake_case, exactly as pos_booking.proto declares them. */
interface TicketRefWire {
  ticket_id?: string;
  number?: string;
  state?: string;
  replayed?: boolean;
}

interface TicketForBookingWire {
  found?: boolean;
  ticket_id?: string;
  state?: string;
  paid_at?: string;
  cashier_id?: string;
  total_minor?: number;
  deposit_applied_minor?: number;
  deposit_applied_vat_minor?: number;
  documents?: { type?: string; number?: string }[];
  number?: string;
}

interface PosBookingIntakeGrpc {
  openTicketForBooking(
    data: OpenTicketForBookingRequest,
    metadata?: Metadata,
    options?: GrpcCallOptions,
  ): Observable<TicketRefWire>;
  updateBookingStatus(
    data: UpdateBookingStatusRequest,
    metadata?: Metadata,
    options?: GrpcCallOptions,
  ): Observable<TicketRefWire>;
  getTicketForBooking(
    data: { tenant_id: string; booking_id: string },
    metadata?: Metadata,
    options?: GrpcCallOptions,
  ): Observable<TicketForBookingWire>;
}

/**
 * Milliseconds, per attempt. An open is one transaction on the platform
 * (lines, stock, customer, number); anything slower than this is the
 * platform in trouble, and the queue will send it again.
 */
const CALL_TIMEOUT_MS = 5_000;

/**
 * POS_TICKET_INTAKE over gRPC to platform's PosBookingIntake.
 *
 * KEYED, like ChairDirectory: PLATFORM_INTERNAL_KEY goes as gRPC metadata
 * `x-internal-key` on every call, read per call so a rotation needs a
 * restart and not a rebuild. Never logged, nor any part of it.
 *
 * callWithRetry retries UNAVAILABLE once, waiting for the channel -- this
 * service's rule for every platform call. Every other failure is thrown, as
 * a PosIntakeFailure carrying the status by name and the platform's own
 * `error-code`, and the QUEUE decides (domain/pos/pos-sync-outcome.ts): it
 * retries over minutes, not milliseconds. Every RPC is idempotent, so a
 * resend after an answer that never arrived is harmless.
 */
@Injectable()
export class GrpcPosBookingIntake implements PosTicketIntake, OnModuleInit {
  private readonly logger = new Logger(GrpcPosBookingIntake.name);
  private svc!: PosBookingIntakeGrpc;

  constructor(
    @Inject(POS_BOOKING_INTAKE_CLIENT) private readonly client: ClientGrpc,
  ) {}

  onModuleInit(): void {
    this.svc = this.client.getService<PosBookingIntakeGrpc>('PosBookingIntake');
  }

  async openTicketForBooking(
    request: OpenTicketForBookingRequest,
  ): Promise<TicketRef> {
    const res = await this.call(
      `OpenTicketForBooking ${request.booking_code}`,
      (md, opts) => this.svc.openTicketForBooking(request, md, opts),
    );
    return toRef(res, 'OpenTicketForBooking');
  }

  async updateBookingStatus(
    request: UpdateBookingStatusRequest,
  ): Promise<TicketRef> {
    const res = await this.call(
      `UpdateBookingStatus ${request.booking_id.slice(0, 8)} ${request.status}`,
      (md, opts) => this.svc.updateBookingStatus(request, md, opts),
    );
    return toRef(res, 'UpdateBookingStatus');
  }

  async getTicketForBooking(
    tenantId: string,
    bookingId: string,
  ): Promise<TicketForBooking> {
    const res = await this.call(
      `GetTicketForBooking ${bookingId.slice(0, 8)}`,
      (md, opts) =>
        this.svc.getTicketForBooking(
          { tenant_id: tenantId, booking_id: bookingId },
          md,
          opts,
        ),
    );
    return {
      found: res.found === true,
      ticketId: blankToNull(res.ticket_id),
      number: blankToNull(res.number),
      state: blankToNull(res.state),
      paidAt: blankToNull(res.paid_at),
      cashierId: blankToNull(res.cashier_id),
      totalMinor: Number(res.total_minor ?? 0),
      depositAppliedMinor: Number(res.deposit_applied_minor ?? 0),
      depositAppliedVatMinor: Number(res.deposit_applied_vat_minor ?? 0),
      documents: (res.documents ?? [])
        .filter((d) => (d.number ?? '') !== '')
        .map((d) => ({ type: d.type ?? '', number: d.number ?? '' })),
    };
  }

  private async call<T>(
    label: string,
    issue: (metadata: Metadata, options: GrpcCallOptions) => Observable<T>,
  ): Promise<T> {
    const key = (process.env.PLATFORM_INTERNAL_KEY ?? '').trim();
    if (key === '') {
      // The platform would refuse it anyway. Refused here it costs no round
      // trip, and the message says which service to fix. No gRPC status:
      // the queue retries, so rows flow the moment the key is set.
      throw new PosIntakeFailure(
        null,
        'PLATFORM_INTERNAL_KEY_UNSET',
        'PLATFORM_INTERNAL_KEY is not set on booking-api, so nothing is ' +
          'sent to the POS. Set it to the value platform holds.',
      );
    }

    try {
      return await callWithRetry(
        this.logger,
        label,
        CALL_TIMEOUT_MS,
        (md, opts) => {
          md.set('x-internal-key', key);
          return issue(md, opts);
        },
      );
    } catch (e) {
      throw new PosIntakeFailure(
        grpcStatusName(e),
        journalErrorCode(e),
        `${label}: platform ${describeGrpcFailure(e)}`,
      );
    }
  }
}

function toRef(res: TicketRefWire, rpc: string): TicketRef {
  const ticketId = blankToNull(res.ticket_id);
  if (ticketId === null) {
    // The contract always names the ticket. An answer without one is the
    // platform breaking its word: no verdict, so the queue sends it again.
    throw new PosIntakeFailure(
      'INTERNAL',
      null,
      `${rpc}: platform answered with no ticket_id`,
    );
  }
  return {
    ticketId,
    number: res.number ?? '',
    state: res.state ?? '',
    replayed: res.replayed === true,
  };
}

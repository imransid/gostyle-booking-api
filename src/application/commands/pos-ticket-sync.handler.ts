import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  POS_TICKET_INTAKE,
  PosIntakeFailure,
  type PosTicketIntake,
  type TicketRef,
} from '@application/ports/pos-ticket-intake.port';
import {
  CUSTOMER_CONTACT,
  type CustomerContactReader,
} from '@application/ports/customer-contact.port';
import {
  PosTicketSyncRepository,
  type BookingPosContext,
  type DuePosSync,
} from '@infrastructure/persistence/pos-ticket-sync.repository';
import {
  branchInstant,
  branchToday,
} from '@infrastructure/persistence/hold.repository';
import { depositPosition } from '@domain/journal/deposit-position';
import { postingBackoffMs } from '@domain/journal/posting-backoff';
import {
  buildOpenRequest,
  buildStatusRequest,
  historyStatusOf,
  openStillWanted,
  voidsTicket,
  type PosContact,
} from '@domain/pos/pos-ticket-request';
import { classifySyncFailure } from '@domain/pos/pos-sync-outcome';
import { isBookingError } from '@application/contract/errors';
import {
  posTicketSyncEnabled,
  posTicketSyncTenants,
} from './pos-ticket-sync.flag';
import { PosTicketPaidHandler } from './pos-ticket-paid.handler';

/**
 * Rows sent per tick, one after another. The LEASE must outlast the batch:
 * a send is at most a contact lookup (CONTACT_MS) and two 5s attempts
 * (callWithRetry), so 20 stay well under five minutes even if every call
 * times out.
 */
const BATCH = 20;
const LEASE_MS = 5 * 60_000;

/**
 * customer-api is asked for the address the till links a CRM customer on.
 * Briefly: a slow customer-api must not hold the ticket back, and a ticket
 * without the address still opens (the cashier can attach the customer).
 */
const CONTACT_MS = 2_000;

/** The safety net: completed visits quiet this long with no settlement. */
export const UNSETTLED_AFTER_MS = 30 * 60_000;
const UNSETTLED_BATCH = 20;

/** A minute past the branch's midnight, so the new trading day is open. */
const NEXT_DAY_GRACE_MS = 60_000;

export interface PosTicketSyncRunReport {
  readonly sendingEnabled: boolean;
  readonly done: number;
  readonly skipped: number;
  readonly retried: number;
  readonly parked: number;
}

export interface PosSettleSweepReport {
  readonly checked: number;
  readonly settled: number;
  readonly failed: number;
}

/**
 * Sends each queued booking event to the platform's POS, once, in order
 * (gostyle-platform docs/booking-pos-tickets-plan.md, B2-B5).
 *
 * OWNS THE PORTS (CLAUDE.md 7): POS_TICKET_INTAKE and CUSTOMER_CONTACT. The
 * repository reads and writes rows; this decides what each one becomes:
 *
 *   open, visit still in progress -> OpenTicketForBooking; the booking
 *                                    stores the ticket id and number
 *   open, visit since undone or    -> skipped: the void behind it finds no
 *   cancelled                         ticket and is done too
 *   status                         -> UpdateBookingStatus; a void clears the
 *                                    booking's ticket
 *   a failure                      -> domain/pos/pos-sync-outcome.ts decides:
 *                                    retry (backoff, no attempt limit), the
 *                                    next trading day, park, or nothing to do
 *
 * THE REQUEST IS BUILT FROM THE BOOKING AT SEND TIME. Safe because a
 * checked-in visit's items and prices are frozen; and it means a send that
 * waited out a platform outage carries the deposit as it stands now.
 */
@Injectable()
export class PosTicketSyncHandler {
  private static readonly log = new Logger(PosTicketSyncHandler.name);

  constructor(
    private readonly rows: PosTicketSyncRepository,
    @Inject(POS_TICKET_INTAKE) private readonly intake: PosTicketIntake,
    @Inject(CUSTOMER_CONTACT) private readonly contacts: CustomerContactReader,
    private readonly paid: PosTicketPaidHandler,
  ) {}

  async run(): Promise<PosTicketSyncRunReport> {
    const report = {
      sendingEnabled: posTicketSyncEnabled(),
      done: 0,
      skipped: 0,
      retried: 0,
      parked: 0,
    };
    // Off: nothing is claimed. Nothing new is queued either (the enqueuer
    // reads the same switch), so turning it back on resumes where it was.
    if (!report.sendingEnabled) return report;

    const due = await this.rows.claimDue(
      BATCH,
      posTicketSyncTenants(),
      LEASE_MS,
    );
    for (const row of due) {
      report[await this.sync(row)] += 1;
    }
    return report;
  }

  private async sync(
    row: DuePosSync,
  ): Promise<'done' | 'skipped' | 'retried' | 'parked'> {
    const label = `pos-sync ${row.kind} ${row.bookingStatus} ${row.bookingId.slice(0, 8)}`;

    let ctx: BookingPosContext | null;
    try {
      ctx = await this.rows.bookingFor(row.bookingId);
    } catch (e) {
      return this.retry(row, label, null, e);
    }
    if (ctx === null) {
      // The claim only takes rows whose booking has a tenant, and bookings
      // are never deleted; this is a booking that lost its tenant.
      const why = 'the booking has no tenant (or no longer exists)';
      PosTicketSyncHandler.log.error(`${label}: ${why} -- parked`);
      await this.rows.markParked(row.id, 'BOOKING_NO_TENANT', why);
      return 'parked';
    }

    try {
      if (row.kind === 'open') {
        if (!openStillWanted(ctx.booking.status)) {
          await this.rows.markSkipped(
            row.id,
            `the booking is ${ctx.booking.status} by now; no ticket opened`,
          );
          return 'skipped';
        }
        const ref = await this.intake.openTicketForBooking(
          buildOpenRequest({
            booking: ctx.booking,
            contact: await this.contactFor(ctx),
            deposit: depositPosition(ctx.ledger, ctx.breakdown),
            openedBy: ctx.actorByStatus.get('checked_in') ?? null,
            eventId: row.eventId,
          }),
        );
        await this.rows.setTicket(row.bookingId, ref.ticketId, ref.number);
        await this.done(row, label, ref);
        return 'done';
      }

      if (row.bookingStatus === 'checked_in') {
        // pos_ticket_sync_kind_matches makes this unreachable.
        await this.rows.markParked(
          row.id,
          'BAD_ROW',
          'a status row for a check-in',
        );
        return 'parked';
      }
      const ref = await this.intake.updateBookingStatus(
        buildStatusRequest({
          booking: ctx.booking,
          bookingStatus: row.bookingStatus,
          deposit: depositPosition(ctx.ledger, ctx.breakdown),
          actorId:
            ctx.actorByStatus.get(historyStatusOf(row.bookingStatus)) ?? null,
          eventId: row.eventId,
        }),
      );
      if (voidsTicket(row.bookingStatus)) {
        await this.rows.clearTicket(row.bookingId, ref.ticketId);
      }
      await this.done(row, label, ref);
      return 'done';
    } catch (e) {
      if (!(e instanceof PosIntakeFailure))
        return this.retry(row, label, null, e);

      const verdict = classifySyncFailure(e, row);
      switch (verdict.kind) {
        case 'retry':
          return this.retry(row, label, e.errorCode, e);
        case 'next_trading_day': {
          const at = this.nextTradingDay();
          PosTicketSyncHandler.log.error(
            `${label}: the till's trading day is closed (${e.errorCode}) -- ` +
              `will send again at ${at.toISOString()}`,
          );
          await this.rows.markRetry(row.id, e.errorCode, e.message, at);
          return 'retried';
        }
        case 'nothing_to_do':
          await this.rows.markSkipped(
            row.id,
            'the till had no live ticket for this booking: nothing to void',
          );
          return 'skipped';
        case 'park':
          // At ERROR, every time: each one is a visit the till cannot
          // charge, or a ticket it cannot void, until somebody acts.
          PosTicketSyncHandler.log.error(
            `${label}: REFUSED by the platform (${verdict.code}): ` +
              `${e.message} -- parked. Fix the cause, then requeue it ` +
              '(POST /v1/pos-ticket-sync/requeue).',
          );
          await this.rows.markParked(row.id, verdict.code, e.message);
          return 'parked';
      }
    }
  }

  private async done(
    row: DuePosSync,
    label: string,
    ref: TicketRef,
  ): Promise<void> {
    await this.rows.markDone(row.id, ref.ticketId);
    PosTicketSyncHandler.log.log(
      `${label}: ticket ${ref.number} ${ref.state}` +
        (ref.replayed ? ' (replayed: the till already had it)' : '') +
        (row.attempts > 0 ? ` after ${row.attempts} failure(s)` : ''),
    );
  }

  private async retry(
    row: DuePosSync,
    label: string,
    code: string | null,
    e: unknown,
  ): Promise<'retried'> {
    const message = e instanceof Error ? e.message : String(e);
    const attempts = row.attempts + 1;
    const delayMs = postingBackoffMs(attempts);
    // At ERROR from the first attempt (CLAUDE.md 9), then every thirtieth,
    // so a long outage is visible without burying the log.
    if (attempts === 1 || attempts % 30 === 0) {
      PosTicketSyncHandler.log.error(
        `${label}: no verdict from the platform (attempt ${attempts}): ` +
          `${message} -- will send again in ${Math.round(delayMs / 1000)}s`,
      );
    }
    await this.rows.markRetry(
      row.id,
      code,
      message,
      new Date(Date.now() + delayMs),
    );
    return 'retried';
  }

  /** The start of the branch's next trading day, plus a minute's grace. */
  private nextTradingDay(): Date {
    const today = branchToday(Date.now());
    const tomorrow = new Date(`${today}T00:00:00Z`);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    const midnight = branchInstant(tomorrow.toISOString().slice(0, 10), 0);
    return new Date(midnight.getTime() + NEXT_DAY_GRACE_MS);
  }

  /**
   * The address the till links a CRM customer on. A guest lane names no
   * person; an unreachable customer-api is no address, not a failed open.
   */
  private async contactFor(ctx: BookingPosContext): Promise<PosContact | null> {
    if (ctx.booking.isGuest) return null;
    const found = await this.contacts.lookup(ctx.booking.customerId, {
      quickMs: CONTACT_MS,
    });
    if (found.kind !== 'found') {
      if (found.kind === 'unavailable') {
        PosTicketSyncHandler.log.warn(
          `${ctx.booking.code}: customer-api did not answer (${found.error}); ` +
            'the ticket opens without the customer, the cashier can attach them',
        );
      }
      return null;
    }
    return {
      email: found.contact.email,
      emailVerified: found.contact.emailVerified,
      fullName: found.contact.fullName,
    };
  }

  // ------------------------------------------------------------ the safety net

  /**
   * B10: settle visits whose paid callback never arrived.
   *
   * The platform retries the callback for a few minutes and then gives up;
   * a booking-api outage longer than that would leave a paid visit
   * `completed` forever. So every few minutes, completed visits with a live
   * ticket and no settlement for half an hour are read back from the till,
   * and a ticket that was paid settles the booking exactly as the callback
   * would have -- the same handler, the cashier as the staff actor.
   */
  async sweepUnsettled(): Promise<PosSettleSweepReport> {
    const report = { checked: 0, settled: 0, failed: 0 };
    if (!posTicketSyncEnabled()) return report;

    const due = await this.rows.unsettledCompleted(
      UNSETTLED_AFTER_MS,
      UNSETTLED_BATCH,
      posTicketSyncTenants(),
    );
    for (const b of due) {
      report.checked += 1;
      try {
        const t = await this.intake.getTicketForBooking(
          b.tenantId,
          b.bookingId,
        );
        if (
          !t.found ||
          t.ticketId === null ||
          (t.state !== 'PAID' && t.state !== 'COMPLETED')
        ) {
          continue; // Not paid yet: the cashier has not taken it.
        }
        if (t.cashierId === null) {
          PosTicketSyncHandler.log.error(
            `safety net: POS ticket ${t.number ?? t.ticketId} for booking ` +
              `${b.bookingId.slice(0, 8)} is ${t.state} with no cashier; ` +
              'it cannot be settled here without a staff actor',
          );
          report.failed += 1;
          continue;
        }
        const view = await this.paid.settle({
          tenantId: b.tenantId,
          bookingId: b.bookingId,
          ticketId: t.ticketId,
          ticketNumber: t.number ?? '',
          paidAt: t.paidAt,
          cashierId: t.cashierId,
          totalMinor: t.totalMinor,
          depositAppliedMinor: t.depositAppliedMinor,
          depositAppliedVatMinor: t.depositAppliedVatMinor,
          documents: t.documents,
        });
        report.settled += 1;
        PosTicketSyncHandler.log.warn(
          `safety net: ${view.code} settled from POS ticket ${t.number} -- ` +
            'its paid callback never arrived. Check the platform outbox.',
        );
      } catch (e) {
        report.failed += 1;
        PosTicketSyncHandler.log.error(
          `safety net: booking ${b.bookingId.slice(0, 8)}: ` +
            (isBookingError(e)
              ? `${e.code}: ${e.message}`
              : e instanceof Error
                ? e.message
                : String(e)),
        );
      }
    }
    return report;
  }
}

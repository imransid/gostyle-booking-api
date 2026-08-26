import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { toUuid } from './hold.repository';
import {
  checkTransition,
  releasesCapacity,
  cancellationOutcome,
  noShowOutcome,
  type ActorKind,
  type BookingStatus,
  type CancelInitiator,
  type MoneyOutcome,
} from '@domain/booking/lifecycle';

/**
 * The shape SELECT ... FOR UPDATE returns.
 *
 * Named rather than inlined into the generic. An inline type argument
 * that spans lines is fragile twice over: a formatter can move the
 * angle bracket away from the call, and a heredoc can swallow it.
 */
/** One row of the ticket query. Named, because a multi-line generic
 *  after $queryRaw gets eaten by the shell when this file is written
 *  through a heredoc. A line ending in "<" never survives. */
interface TicketRow {
  customer_id: string;
  status: string;
  service_fils: bigint | null;
  captured_fils: bigint | null;
}

interface LockedBooking {
  readonly id: string;
  readonly code: string;
  readonly status: BookingStatus;
  readonly start_at: Date;
}

/**
 * A settled ticket, already computed by the handler.
 *
 * The repository does not run the arithmetic: the handler owns the customer
 * and the tier, exactly as it owns the requirement at confirm. This is the
 * result, ready to persist.
 */
export interface SettlementWrite {
  readonly baseFils: number;
  readonly tipFils: number;
  readonly vatFils: number;
  readonly depositAppliedFils: number;
  readonly loyaltyRedeemFils: number;
  readonly dueFils: number;
  readonly creditFils: number;
  readonly taxExempt: boolean;
  readonly rail: string;
}

export interface TransitionInput {
  readonly bookingId: string;
  readonly to: BookingStatus;
  readonly actor: ActorKind;
  readonly actorId: string | null;
  readonly reason: string | null;
  readonly nowMs?: number;
  /** Present only on completed -> settled. */
  readonly settlement?: SettlementWrite;
  /** A salon-initiated cancel refunds in full, whatever the timing. */
  readonly initiatedBy?: CancelInitiator;
  readonly vipStandingReservation?: boolean;
}

export interface TransitionedBooking {
  readonly bookingId: string;
  readonly code: string;
  readonly from: BookingStatus;
  readonly to: BookingStatus;
  readonly paymentStatus: string;
}

export type TransitionOutcome =
  | {
      readonly kind: 'transitioned';
      readonly booking: TransitionedBooking;
      readonly money: MoneyOutcome | null;
    }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'illegal'; readonly message: string }
  | { readonly kind: 'forbidden'; readonly message: string }
  | { readonly kind: 'needs_reason'; readonly message: string };

@Injectable()
export class LifecycleRepository {
  private static readonly log = new Logger(LifecycleRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * One method for every lifecycle move: check in, start, complete, settle,
   * cancel, no-show.
   *
   * They all have the identical shape, which is only true because the state
   * machine is DATA rather than a switch. Six endpoints, one transaction,
   * one place where the audit row and the outbox event can be forgotten.
   *
   * The order inside matters:
   *   1. lock, so two conflicting commands cannot both apply
   *   2. decide legality against the CURRENT state, not the one the client saw
   *   3. write the status
   *   4. release capacity if this is an exit
   *   5. settle the money
   *   6. audit and event, in the same commit
   */
  /**
   * What the ticket is worth, before the register adds anything.
   *
   * Three facts, one round trip: the services actually delivered, the
   * customer the booking belongs to, and what has already been captured.
   *
   * The deposit comes from the LEDGER, not from booking.deposit_fils. The
   * ledger is the accounting truth: a partial refund or a goodwill credit
   * between confirm and checkout moves the real figure, and the booking row
   * still shows what was taken on the day.
   */
  async ticketFor(bookingId: string): Promise<{
    serviceFils: number;
    customerId: string;
    capturedFils: number;
    status: string;
  } | null> {
    const rows = await this.prisma.$queryRaw<TicketRow[]>`
      SELECT b.customer_id,
             b.status::text                       AS status,
             (SELECT COALESCE(SUM(bi.price_fils), 0)
                FROM booking_item bi
               WHERE bi.booking_id = b.id)        AS service_fils,
             (SELECT COALESCE(SUM(dl.amount_fils), 0)
                FROM deposit_ledger dl
               WHERE dl.booking_id = b.id)        AS captured_fils
        FROM booking b
       WHERE b.id = ${bookingId}::uuid`;

    const row = rows[0];
    if (row === undefined) return null;

    return {
      customerId: row.customer_id,
      status: row.status,
      serviceFils: Number(row.service_fils ?? 0),
      capturedFils: Number(row.captured_fils ?? 0),
    };
  }

  async transition(input: TransitionInput): Promise<TransitionOutcome> {
    const nowMs = input.nowMs ?? Date.now();

    try {
      return await this.prisma.$transaction(async (tx) => {
        // 1. Row lock. When the desk marks a no-show while the customer taps
        //    a self-scan check-in, exactly one of them wins and the loser
        //    reads fresh state rather than silently overwriting.
        const locked = await tx.$queryRaw<LockedBooking[]>`
          SELECT id, code, status, start_at
            FROM booking
           WHERE id = ${input.bookingId}::uuid
           FOR UPDATE`;

        const booking = locked[0];
        if (booking === undefined) return { kind: 'not_found' as const };

        // 2. Legality is judged against what the database says NOW, not
        //    against whatever the client had on screen a minute ago.
        const verdict = checkTransition({
          from: booking.status,
          to: input.to,
          actor: input.actor,
          reason: input.reason,
        });
        if (verdict.kind !== 'allowed') {
          return { kind: verdict.kind, message: verdict.message };
        }

        // 3. Money, decided before anything is applied, so the outcome can be
        //    read back to the customer and stored verbatim.
        const money = await this.settleMoney(tx, {
          bookingId: booking.id,
          to: input.to,
          startAtMs: booking.start_at.getTime(),
          nowMs,
          initiatedBy: input.initiatedBy ?? 'customer',
          ...(input.vipStandingReservation !== undefined
            ? { vipStandingReservation: input.vipStandingReservation }
            : {}),
          actor: input.actor,
          actorId: input.actorId,
        });

        // 3b. Settlement. The deposit is TENDER: it is consumed by the
        //     ticket, not refunded, so it leaves the ledger as
        //     applied_at_pos. Anything the ticket did not need goes back as
        //     credit, which is why both entries are negative and the
        //     booking's protected balance lands on zero either way.
        //
        //     Tips and retail never touch THIS ledger. It tracks the deposit,
        //     and a tip is a fresh charge at the till.
        if (input.settlement !== undefined) {
          const st = input.settlement;
          const applied = st.depositAppliedFils - st.creditFils;

          if (applied > 0) {
            await tx.depositLedger.create({
              data: {
                bookingId: booking.id,
                entryType: 'applied_at_pos',
                amountFils: -applied,
                rail: 'internal',
                reason: `Applied to ticket ${booking.code}`,
                actorKind: input.actor,
                actorId:
                  input.actor === 'system' || input.actorId === null
                    ? null
                    : toUuid(input.actorId),
              },
            });
          }

          if (st.creditFils > 0) {
            await tx.depositLedger.create({
              data: {
                bookingId: booking.id,
                entryType: 'refunded',
                amountFils: -st.creditFils,
                rail: 'internal',
                reason: 'Overpayment credited to the wallet',
                actorKind: input.actor,
                actorId:
                  input.actor === 'system' || input.actorId === null
                    ? null
                    : toUuid(input.actorId),
              },
            });
          }
        }

        const paymentStatus = nextPaymentStatus(money);

        await tx.booking.update({
          where: { id: booking.id },
          data: {
            status: input.to,
            ...(paymentStatus !== null ? { paymentStatus } : {}),
          },
        });

        // 4. THE LINE THAT RETURNS CAPACITY.
        //    Never delete a reservation: history survives, the time becomes
        //    sellable, and the row leaves the exclusion constraint's
        //    WHERE (blocking) filter in the same statement.
        if (releasesCapacity(input.to)) {
          const items = await tx.bookingItem.findMany({
            where: { bookingId: booking.id },
            select: { id: true },
          });
          const itemIds = items.map((i) => i.id);
          if (itemIds.length > 0) {
            await tx.staffReservation.updateMany({
              where: { bookingItemId: { in: itemIds } },
              data: { blocking: false },
            });
            await tx.resourceReservation.updateMany({
              where: { bookingItemId: { in: itemIds } },
              data: { blocking: false },
            });
          }
        }

        // 5. Audit. The CHECK constraints from step 3 enforce that a system
        //    action has no human actor and a manager override has a reason.
        await tx.bookingStatusHistory.create({
          data: {
            bookingId: booking.id,
            fromStatus: booking.status,
            toStatus: input.to,
            reason: input.reason,
            metadata: money === null ? undefined : { ...money },
            actorKind: input.actor,
            actorId:
              input.actor === 'system' || input.actorId === null
                ? null
                : toUuid(input.actorId),
          },
        });

        // 6. The event, same commit. The waitlist and the reminder scheduler
        //    both hang off this, and neither may be lost.
        await tx.eventOutbox.create({
          data: {
            aggregateType: 'booking',
            aggregateId: booking.id,
            // The in-service event is named session.started, not booking.in_service.
            // Everything else follows booking.<status>.
            eventType:
              input.to === 'in_service'
                ? 'session.started'
                : `booking.${input.to}`,
            payload: {
              code: booking.code,
              from: booking.status,
              to: input.to,
              refundFils: money?.refundFils ?? 0,
              keptFils: money?.keptFils ?? 0,
              releasedCapacity: releasesCapacity(input.to),
            },
          },
        });

        return {
          kind: 'transitioned' as const,
          booking: {
            bookingId: booking.id,
            code: booking.code,
            from: booking.status,
            to: input.to,
            paymentStatus: paymentStatus ?? 'unchanged',
          },
          money,
        };
      });
    } catch (e) {
      LifecycleRepository.log.error(
        `transition() failed: ${e instanceof Error ? e.message.slice(0, 400) : String(e)}`,
      );
      throw e;
    }
  }

  /**
   * Only cancel and no-show move money. Everything else on the happy path
   * leaves the ledger alone.
   *
   * Corrections are new rows, never edits: the append-only trigger from
   * step 3 would reject an UPDATE outright.
   */
  private async settleMoney(
    tx: Parameters<Parameters<PrismaService['$transaction']>[0]>[0],
    input: {
      bookingId: string;
      to: BookingStatus;
      startAtMs: number;
      nowMs: number;
      initiatedBy: CancelInitiator;
      vipStandingReservation?: boolean;
      actor: ActorKind;
      actorId: string | null;
    },
  ): Promise<MoneyOutcome | null> {
    if (input.to !== 'cancelled' && input.to !== 'no_show') return null;

    // The protected balance is simply the sum. That is the whole reason the
    // ledger stores signed amounts rather than a separate balance column
    // that could drift.
    const rows = await tx.$queryRaw<{ balance: bigint | null }[]>`
      SELECT COALESCE(SUM(amount_fils), 0) AS balance
        FROM deposit_ledger
       WHERE booking_id = ${input.bookingId}::uuid`;
    const captured = Number(rows[0]?.balance ?? 0);

    const outcome =
      input.to === 'no_show'
        ? noShowOutcome({
            capturedFils: captured,
            ...(input.vipStandingReservation !== undefined
              ? { vipStandingReservation: input.vipStandingReservation }
              : {}),
          })
        : cancellationOutcome({
            nowMs: input.nowMs,
            startAtMs: input.startAtMs,
            capturedFils: captured,
            paidInFull: false,
            initiatedBy: input.initiatedBy,
          });

    const actorKind = input.actor === 'system' ? 'system' : input.actor;
    const actorId =
      input.actor === 'system' || input.actorId === null
        ? null
        : toUuid(input.actorId);

    // Two entries at most, both negative, because money is leaving the
    // protected balance in both directions. The entry TYPE is what tells
    // finance whether it went back to the customer or stayed with the salon.
    if (outcome.refundFils > 0) {
      await tx.depositLedger.create({
        data: {
          bookingId: input.bookingId,
          entryType: 'refunded',
          amountFils: -outcome.refundFils,
          rail: 'internal',
          reason: outcome.explanation,
          actorKind,
          actorId,
        },
      });
    }
    if (outcome.keptFils > 0) {
      await tx.depositLedger.create({
        data: {
          bookingId: input.bookingId,
          entryType: 'forfeited',
          amountFils: -outcome.keptFils,
          rail: 'internal',
          reason: outcome.explanation,
          actorKind,
          actorId,
        },
      });
    }

    return outcome;
  }
}

/** Where the money ended up, in one word, for the booking row. */
function nextPaymentStatus(
  money: MoneyOutcome | null,
): 'refunded' | 'forfeited' | 'partially_refunded' | null {
  if (money === null) return null;
  if (money.refundFils > 0 && money.keptFils > 0) return 'partially_refunded';
  if (money.refundFils > 0) return 'refunded';
  if (money.keptFils > 0) return 'forfeited';
  return null;
}

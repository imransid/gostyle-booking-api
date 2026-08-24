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
interface LockedBooking {
  readonly id: string;
  readonly code: string;
  readonly status: BookingStatus;
  readonly start_at: Date;
}

export interface TransitionInput {
  readonly bookingId: string;
  readonly to: BookingStatus;
  readonly actor: ActorKind;
  readonly actorId: string | null;
  readonly reason: string | null;
  readonly nowMs?: number;
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
            eventType: `booking.${input.to}`,
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

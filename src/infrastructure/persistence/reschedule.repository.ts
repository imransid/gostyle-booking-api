import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { rescheduleOutcome } from '@domain/booking/reschedule';
import type { RescheduleOutcome } from '@domain/booking/reschedule';
import type { ActorKind } from '@domain/booking/lifecycle';
import { toUuid, branchInstant } from './hold.repository';

/** Named: a heredoc eats a line ending in `<`. */
interface MovingBooking {
  id: string;
  code: string;
  status: string;
  start_at: Date;
  trading_day: Date;
  duration_min: number;
  price_fils: number;
  move_count: number;
  captured_fils: bigint | null;
}

interface HeldSlot {
  staff_id: string;
  start_minute: number;
}

export interface RescheduleInput {
  readonly bookingId: string;
  /** The hold placed on the NEW slot, with its own TTL and token. */
  readonly holdId: string;
  readonly tradingDay: string;
  readonly reason: string;
  readonly actor: ActorKind;
  readonly actorId: string | null;
  readonly nowMs?: number;
}

export type RescheduleResult =
  | { readonly kind: 'not_found' }
  | { readonly kind: 'illegal'; readonly message: string }
  | { readonly kind: 'hold_expired' }
  | {
      readonly kind: 'moved';
      readonly code: string;
      readonly fromStartAt: Date;
      readonly toStartAt: Date;
      readonly outcome: RescheduleOutcome;
    };

/** A move is only legal from a booking that has not happened yet. */
const MOVABLE = new Set([
  'confirmed',
  'pending_payment',
  'pending_confirmation',
]);

@Injectable()
export class RescheduleRepository {
  private static readonly log = new Logger(RescheduleRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Move a booking to the slot a hold is already protecting.
   *
   * THE BOOKING IS MOVED, NOT REPLACED. Same row, same code, new time, move
   * counter up by one. A new booking would orphan the deposit, break the
   * customer's reference, and leave two rows where the customer has one
   * appointment.
   *
   * Nine writes, one transaction:
   *   1  lock the booking
   *   2  prove the new hold is still alive
   *   3  decide the money BEFORE anything is applied
   *   4  release the old reservations, which wakes the waitlist
   *   5  re-point the hold's reservations at this booking's items
   *   6  move the booking row and bump the counter
   *   7  forfeit the old deposit, if the move was late
   *   8  history, with the reason
   *   9  the event, so the waitlist and the notifier both hear about it
   */
  async move(input: RescheduleInput): Promise<RescheduleResult> {
    const nowMs = input.nowMs ?? Date.now();

    return this.prisma.$transaction(async (tx) => {
      // 1. Lock, so a cancel arriving at the same moment cannot interleave.
      const locked = await tx.$queryRaw<MovingBooking[]>`
        SELECT b.id, b.code, b.status::text AS status, b.start_at,
               b.trading_day, b.duration_min, b.price_fils, b.move_count,
               (SELECT COALESCE(SUM(amount_fils), 0)
                  FROM deposit_ledger WHERE booking_id = b.id) AS captured_fils
          FROM booking b
         WHERE b.id = ${input.bookingId}::uuid
         FOR UPDATE`;

      const booking = locked[0];
      if (booking === undefined) return { kind: 'not_found' as const };

      if (!MOVABLE.has(booking.status)) {
        return {
          kind: 'illegal' as const,
          message: `A ${booking.status} booking cannot be moved.`,
        };
      }

      // 2. The new slot has to still be held. The hold did the racing.
      const held = await tx.$queryRaw<HeldSlot[]>`
        SELECT sr.staff_id, sr.start_minute
          FROM staff_reservation sr
          JOIN hold h ON h.id = sr.hold_id
         WHERE sr.hold_id = ${input.holdId}::uuid
           AND h.expires_at > now()
         ORDER BY sr.start_minute
         LIMIT 1`;

      const slot = held[0];
      if (slot === undefined) return { kind: 'hold_expired' as const };

      // 3. Money first, so the outcome can be read back before it is applied.
      const outcome = rescheduleOutcome({
        nowMs,
        currentStartAtMs: booking.start_at.getTime(),
        capturedFils: Number(booking.captured_fils ?? 0),
        totalFils: booking.price_fils,
        moveCount: booking.move_count,
      });

      const items = await tx.bookingItem.findMany({
        where: { bookingId: booking.id },
        select: { id: true },
        orderBy: { position: 'asc' },
      });
      const itemIds = items.map((i) => i.id);
      const firstItem = items[0];
      if (firstItem === undefined) return { kind: 'not_found' as const };

      // 4. THE OLD SLOT GOES BACK. blocking = false rather than DELETE, so
      //    the history survives and the row leaves the exclusion constraint's
      //    WHERE (blocking) filter in the same statement.
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

      // 5. The hold's reservations become this booking's. Re-pointed, not
      //    recreated: the rows never leave the table, so the new slot is
      //    protected continuously and there is no window to lose it in.
      await tx.staffReservation.updateMany({
        where: { holdId: input.holdId },
        data: { holdId: null, bookingItemId: firstItem.id },
      });
      await tx.resourceReservation.updateMany({
        where: { holdId: input.holdId },
        data: { holdId: null, bookingItemId: firstItem.id },
      });

      // 6. The booking itself.
      const newStart = branchInstant(input.tradingDay, slot.start_minute);
      const newEnd = new Date(
        newStart.getTime() + booking.duration_min * 60_000,
      );

      await tx.booking.update({
        where: { id: booking.id },
        data: {
          tradingDay: new Date(`${input.tradingDay}T00:00:00Z`),
          startAt: newStart,
          endAt: newEnd,
          startMinute: slot.start_minute,
          moveCount: outcome.newMoveCount,
          // The ladder starts again: a customer who moved to Friday should
          // not be reminded about Tuesday, and should still be reminded
          // about Friday.
          reminded24hAt: null,
          reminded3hAt: null,
          nudged15mAt: null,
          ...(outcome.acquiresDepositFils !== null
            ? {
                status: 'pending_payment' as const,
                paymentStatus: 'unpaid' as const,
              }
            : {}),
          ...(outcome.money.kind === 'forfeit_and_requote'
            ? { paymentStatus: 'forfeited' as const }
            : {}),
        },
      });

      // 7. A late move forfeits, exactly as a late cancel would.
      if (
        outcome.money.kind === 'forfeit_and_requote' &&
        outcome.money.forfeitedFils > 0
      ) {
        await tx.depositLedger.create({
          data: {
            bookingId: booking.id,
            entryType: 'forfeited',
            amountFils: -outcome.money.forfeitedFils,
            rail: 'internal',
            reason: outcome.explanation,
            actorKind: input.actor,
            actorId:
              input.actor === 'system' || input.actorId === null
                ? null
                : toUuid(input.actorId),
          },
        });
      }

      // 8. Audit. Two rows, because the CHECK constraint forbids a history
      //    entry whose from and to are the same, and a move is not a status
      //    change: the booking is confirmed before and confirmed after.
      const resting =
        outcome.acquiresDepositFils !== null
          ? 'pending_payment'
          : booking.status;

      await tx.bookingStatusHistory.create({
        data: {
          bookingId: booking.id,
          fromStatus: booking.status as 'confirmed',
          toStatus: 'rescheduled',
          reason: input.reason,
          metadata: {
            fromStartAt: booking.start_at.toISOString(),
            toStartAt: newStart.toISOString(),
            moveCount: outcome.newMoveCount,
            ...outcome,
          },
          actorKind: input.actor,
          actorId:
            input.actor === 'system' || input.actorId === null
              ? null
              : toUuid(input.actorId),
        },
      });
      await tx.bookingStatusHistory.create({
        data: {
          bookingId: booking.id,
          fromStatus: 'rescheduled',
          toStatus: resting as 'confirmed',
          reason: `Moved to ${newStart.toISOString()}`,
          actorKind: input.actor,
          actorId:
            input.actor === 'system' || input.actorId === null
              ? null
              : toUuid(input.actorId),
        },
      });

      // 9. The freed slot wakes the waitlist ranker. Same commit, so it can
      //    never be lost.
      await tx.eventOutbox.create({
        data: {
          aggregateType: 'booking',
          aggregateId: booking.id,
          eventType: 'booking.rescheduled',
          payload: {
            code: booking.code,
            fromStartAt: booking.start_at.toISOString(),
            toStartAt: newStart.toISOString(),
            moveCount: outcome.newMoveCount,
            lateMove: outcome.lateMove,
            forfeitedFils:
              outcome.money.kind === 'forfeit_and_requote'
                ? outcome.money.forfeitedFils
                : 0,
            acquiresDepositFils: outcome.acquiresDepositFils,
            releasedCapacity: true,
          },
        },
      });

      // The hold is spent; its reservations belong to the booking now.
      await tx.hold.delete({ where: { id: input.holdId } });

      RescheduleRepository.log.log(
        `${booking.code} moved to ${newStart.toISOString()} (move ${outcome.newMoveCount})`,
      );

      return {
        kind: 'moved' as const,
        code: booking.code,
        fromStartAt: booking.start_at,
        toStartAt: newStart,
        outcome,
      };
    });
  }
}

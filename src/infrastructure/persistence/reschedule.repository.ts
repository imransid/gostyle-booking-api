import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { rescheduleOutcome } from '@domain/booking/reschedule';
import type { RescheduleOutcome } from '@domain/booking/reschedule';
import type { ActorKind } from '@domain/booking/lifecycle';
import { toUuid, branchInstant } from './hold.repository';
import { isExclusionViolation } from './booking.repository';

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

export interface ShiftInPlaceInput {
  readonly bookingId: string;
  readonly tradingDay: string;
  /** The same professional. A shift changes when, never who. */
  readonly toStartMin: number;
  readonly reason: string;
  readonly actor: ActorKind;
  readonly actorId: string | null;
}

export type ShiftResult =
  | { readonly kind: 'not_found' }
  | { readonly kind: 'illegal'; readonly message: string }
  /** The exclusion constraint refused: somebody else has that time now. */
  | { readonly kind: 'slot_taken' }
  | {
      readonly kind: 'shifted';
      readonly code: string;
      readonly fromStartMin: number;
      readonly toStartMin: number;
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

  /**
   * Nudge a booking a few minutes without holding the new slot first.
   *
   * THE HOLD-THEN-MOVE PATH CANNOT DO THIS, and the reason is not obvious
   * until you watch it fail: a booking shifted by fifteen minutes overlaps
   * ITSELF, so placing a hold on the new slot is refused by the exclusion
   * constraint against the very booking being moved. Compaction found this
   * immediately, because every move it proposes is small by definition.
   *
   * So the atomicity comes from the transaction instead of from a hold. The
   * old reservations stop blocking and the new ones are written in the same
   * commit, under the same advisory lock a hold would have taken, and the
   * exclusion constraint still has the final word about everybody else.
   *
   * No money moves. A compaction shift is the salon's convenience and the
   * customer has already agreed to it; charging a move fee for it would be
   * charging someone for doing us a favour.
   */
  async shiftInPlace(input: ShiftInPlaceInput): Promise<ShiftResult> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<
          {
            id: string;
            code: string;
            status: string;
            start_minute: number;
            duration_min: number;
            branch_id: string;
          }[]
        >`
          SELECT id, code, status, start_minute, duration_min, branch_id
            FROM booking
           WHERE id = ${input.bookingId}::uuid
           FOR UPDATE`;

        const booking = rows[0];
        if (booking === undefined) return { kind: 'not_found' as const };
        if (!MOVABLE.has(booking.status)) {
          return {
            kind: 'illegal' as const,
            message: `A ${booking.status} booking cannot be shifted.`,
          };
        }

        const items = await tx.bookingItem.findMany({
          where: { bookingId: booking.id },
          select: { id: true, staffId: true, resourceType: true },
          orderBy: { position: 'asc' },
        });
        const first = items[0];
        if (first === undefined) return { kind: 'not_found' as const };

        // The same turn-taking a hold would do, so two shifts on one chair
        // type cannot interleave.
        const key = `${booking.branch_id}:${first.resourceType}:${input.tradingDay}`;
        await tx.$executeRaw`
          SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;

        const oldStart = branchInstant(input.tradingDay, booking.start_minute);
        const newStart = branchInstant(input.tradingDay, input.toStartMin);
        const newEnd = new Date(
          newStart.getTime() + booking.duration_min * 60_000,
        );
        const itemIds = items.map((i) => i.id);

        // Release first. Inside this transaction the released rows leave the
        // constraint's WHERE (blocking) filter, so the booking stops
        // colliding with itself and everyone else still counts.
        await tx.staffReservation.updateMany({
          where: { bookingItemId: { in: itemIds } },
          data: { blocking: false },
        });
        await tx.resourceReservation.updateMany({
          where: { bookingItemId: { in: itemIds } },
          data: { blocking: false },
        });

        await tx.staffReservation.create({
          data: {
            bookingItemId: first.id,
            branchId: booking.branch_id,
            staffId: first.staffId ?? '',
            tradingDay: new Date(`${input.tradingDay}T00:00:00Z`),
            kind: 'active',
            startAt: newStart,
            endAt: newEnd,
            startMinute: input.toStartMin,
            durationMin: booking.duration_min,
          },
        });
        await tx.resourceReservation.create({
          data: {
            bookingItemId: first.id,
            branchId: booking.branch_id,
            resourceType: first.resourceType,
            tradingDay: new Date(`${input.tradingDay}T00:00:00Z`),
            startAt: newStart,
            endAt: newEnd,
            startMinute: input.toStartMin,
            durationMin: booking.duration_min,
          },
        });

        await tx.booking.update({
          where: { id: booking.id },
          data: {
            startAt: newStart,
            endAt: newEnd,
            startMinute: input.toStartMin,
            moveCount: { increment: 1 },
            // The ladder starts again, exactly as it does on a full move.
            reminded24hAt: null,
            reminded3hAt: null,
            nudged15mAt: null,
          },
        });

        await tx.bookingStatusHistory.create({
          data: {
            bookingId: booking.id,
            fromStatus: booking.status as 'confirmed',
            toStatus: 'rescheduled',
            reason: input.reason,
            metadata: {
              fromStartAt: oldStart.toISOString(),
              toStartAt: newStart.toISOString(),
              shiftMin: input.toStartMin - booking.start_minute,
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
            toStatus: booking.status as 'confirmed',
            reason: `Shifted to ${newStart.toISOString()}`,
            actorKind: input.actor,
            actorId:
              input.actor === 'system' || input.actorId === null
                ? null
                : toUuid(input.actorId),
          },
        });

        await tx.eventOutbox.create({
          data: {
            aggregateType: 'booking',
            aggregateId: booking.id,
            eventType: 'booking.rescheduled',
            payload: {
              code: booking.code,
              fromStartAt: oldStart.toISOString(),
              toStartAt: newStart.toISOString(),
              reason: input.reason,
              releasedCapacity: true,
            },
          },
        });

        RescheduleRepository.log.log(
          `${booking.code} shifted ${booking.start_minute} -> ${input.toStartMin}`,
        );

        return {
          kind: 'shifted' as const,
          code: booking.code,
          fromStartMin: booking.start_minute,
          toStartMin: input.toStartMin,
        };
      });
    } catch (e) {
      if (isExclusionViolation(e)) return { kind: 'slot_taken' as const };
      throw e;
    }
  }

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

      // 5b. WHO IS DOING THE WORK MOVED TOO.
      //
      // The reservation and booking_item.staff_id both record the
      // professional, and until this line only the reservation was updated.
      // A move that kept the same person hid it perfectly; the first move
      // that landed on somebody ELSE left the diary saying anya and the
      // booking item saying maya, with nothing to say which was right.
      //
      // Found when the disruption ladder reassigned a booking away from a
      // professional who had called in sick, which is the one case where a
      // reschedule ALWAYS changes the person.
      await tx.bookingItem.update({
        where: { id: firstItem.id },
        data: { staffId: slot.staff_id },
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

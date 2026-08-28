import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { isExclusionViolation } from './pg-errors';
import { toUuid } from './hold.repository';

export type PaymentRail =
  'wallet' | 'card' | 'apple_pay' | 'cash' | 'link' | 'internal';

/** What was already captured. null means the requirement was "none". */
export interface PaymentRecord {
  readonly amountFils: number;
  readonly rail: PaymentRail;
  readonly gatewayRef: string | null;
}

export interface ConfirmItem {
  readonly serviceId: string;
  readonly serviceName: string;
  readonly resourceType: string;
  readonly requiredSkill: string;
  /** Frozen at booking time. The menu can change; this cannot. */
  readonly priceFils: number;
  readonly durationMin: number;
  readonly staffId: string;
}

export interface ConfirmBookingInput {
  readonly holdId: string;
  readonly branchId: string;
  readonly customerId: string;
  readonly tradingDay: string;
  readonly channel: string;
  readonly items: readonly ConfirmItem[];
  readonly priceFils: number;
  readonly depositFils: number;
  /** "Service rule 50% (Full color and gloss)". Answers "why was I charged this". */
  readonly requirementSource: string | null;
  readonly payment: PaymentRecord | null;
  readonly actorId: string | null;
  readonly idempotencyKey: string | null;
  readonly requestHash: string;
  /**
   * When the payment link closes. Null on every rail but 'link'.
   *
   * Computed by the handler, because refusing a link that is already dead is
   * a decision about what to tell the desk, not a decision about what to
   * store.
   */
  readonly linkExpiresAt: Date | null;
  /**
   * Exactly what a retry should receive. Stored verbatim, so a replay is
   * answered from bytes rather than re-derived from a world that has
   * already changed underneath it.
   */
  readonly responseView?: unknown;
}

export interface ConfirmedBooking {
  readonly bookingId: string;
  readonly code: string;
  readonly status: string;
  readonly paymentStatus: string;
  readonly startMin: number;
  readonly durationMin: number;
  readonly staffId: string;
}

export type ConfirmOutcome =
  | { readonly kind: 'confirmed'; readonly booking: ConfirmedBooking }
  /** The same Idempotency-Key came back. Return the original, charge nothing. */
  | { readonly kind: 'replayed'; readonly booking: ConfirmedBooking }
  /** Money is never taken against a dead hold. */
  | { readonly kind: 'hold_expired' }
  /** Somebody else got the slot between the hold and the confirm. */
  | { readonly kind: 'slot_taken' };

@Injectable()
export class BookingRepository {
  private static readonly log = new Logger(BookingRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Turn a hold into a booking. Nine writes, one COMMIT.
   *
   * The rule the whole method serves: in EVERY failure branch, the answer to
   * "was anything charged?" is no. Postgres rolls back all nine or none, so
   * there is no half-confirmed state to clean up later.
   */
  async confirm(input: ConfirmBookingInput): Promise<ConfirmOutcome> {
    // Fast path. A retried request should not even open a transaction.
    if (input.idempotencyKey !== null) {
      const seen = await this.findReplay(input.idempotencyKey);
      if (seen !== null) return { kind: 'replayed', booking: seen };
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        // 1. Lock the hold and prove it is alive, in one statement.
        //    FOR UPDATE stops the sweeper deleting it, and stops a second
        //    confirm running beside us, for as long as we hold the row.
        const alive = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM hold
           WHERE id = ${input.holdId}::uuid
             AND expires_at > now()
           FOR UPDATE`;
        if (alive.length === 0) {
          throw new HoldExpiredError();
        }

        // The reservations ARE the truth about what was held. Reading the
        // times from them rather than from the request means a tampered or
        // stale client cannot book a different slot than the one it holds.
        const staffRes = await tx.staffReservation.findFirst({
          where: { holdId: input.holdId },
          orderBy: { startMinute: 'asc' },
        });
        if (staffRes === null) throw new HoldExpiredError();

        const totalDuration = input.items.reduce(
          (a, i) => a + i.durationMin,
          0,
        );
        const endMinute = staffRes.startMinute + totalDuration;

        const codeRows = await tx.$queryRaw<{ code: string }[]>`
          SELECT 'GS-' || nextval('booking_code_seq') AS code`;
        const code = codeRows[0]?.code;
        if (code === undefined) {
          throw new Error('booking_code_seq returned nothing');
        }

        const { status, paymentStatus } = resolveStatus(input);

        // 2. The visit.
        const booking = await tx.booking.create({
          data: {
            code,
            branchId: toUuid(input.branchId),
            customerId: toUuid(input.customerId),
            status,
            paymentStatus,
            tradingDay: new Date(`${input.tradingDay}T00:00:00Z`),
            startAt: staffRes.startAt,
            endAt: staffRes.endAt,
            startMinute: staffRes.startMinute,
            durationMin: totalDuration,
            priceFils: input.priceFils,
            depositFils: input.depositFils,
            requirementSource: input.requirementSource,
            linkExpiresAt: input.linkExpiresAt,
            channel: input.channel,
          },
          select: { id: true, code: true },
        });

        // 3. The line items, each with its frozen price.
        const items = [];
        for (const [position, item] of input.items.entries()) {
          items.push(
            await tx.bookingItem.create({
              data: {
                bookingId: booking.id,
                serviceId: toUuid(item.serviceId),
                serviceName: item.serviceName,
                resourceType: item.resourceType,
                requiredSkill: item.requiredSkill,
                priceFils: item.priceFils,
                durationMin: item.durationMin,
                position,
                staffId: toUuid(item.staffId),
              },
              select: { id: true },
            }),
          );
        }
        const firstItem = items[0];
        if (firstItem === undefined) throw new Error('a booking needs an item');

        // 4. THE IMPORTANT ONE. The reservations are RE-POINTED, not deleted
        //    and remade. The row never leaves the table, so the capacity is
        //    held continuously from hold to booking. There is no instant, in
        //    any isolation level, where the slot looks free.
        await tx.staffReservation.updateMany({
          where: { holdId: input.holdId },
          data: { holdId: null, bookingItemId: firstItem.id },
        });
        await tx.resourceReservation.updateMany({
          where: { holdId: input.holdId },
          data: { holdId: null, bookingItemId: firstItem.id },
        });

        // 5. Money. Append-only, signed, and only when something moved.
        //    A payment link captures nothing yet, so no entry: the ledger
        //    records money, not intentions.
        if (input.payment !== null && input.payment.rail !== 'link') {
          await tx.depositLedger.create({
            data: {
              bookingId: booking.id,
              entryType: 'captured',
              amountFils: input.payment.amountFils,
              rail: input.payment.rail,
              gatewayRef: input.payment.gatewayRef,
              actorKind: input.actorId === null ? 'system' : 'staff',
              actorId: input.actorId === null ? null : toUuid(input.actorId),
            },
          });
        }

        // 6. Audit.
        await tx.bookingStatusHistory.create({
          data: {
            bookingId: booking.id,
            fromStatus: 'held',
            toStatus: status,
            reason: input.requirementSource,
            actorKind: input.actorId === null ? 'system' : 'staff',
            actorId: input.actorId === null ? null : toUuid(input.actorId),
          },
        });

        // 7. The event, in the SAME commit. Redis can be on fire and the
        //    reminder still cannot be lost: a relay picks this up later.
        await tx.eventOutbox.create({
          data: {
            aggregateType: 'booking',
            aggregateId: booking.id,
            eventType: 'booking.confirmed',
            payload: {
              code: booking.code,
              // Which hold became this booking. The walk-in queue uses it to
              // find its own entry and clear it, so the desk does not have to
              // tell us twice that somebody sat down.
              holdId: input.holdId,
              startMinute: staffRes.startMinute,
              endMinute,
              depositFils: input.depositFils,
              rail: input.payment?.rail ?? null,
            },
          },
        });

        const result: ConfirmedBooking = {
          bookingId: booking.id,
          code: booking.code,
          status,
          paymentStatus,
          startMin: staffRes.startMinute,
          durationMin: totalDuration,
          staffId: staffRes.staffId,
        };

        // 8. Retry safety, inside the transaction so it cannot disagree
        //    with whether the booking exists.
        if (input.idempotencyKey !== null) {
          await tx.idempotencyKey.create({
            data: {
              key: input.idempotencyKey,
              operation: 'POST /bookings',
              requestHash: input.requestHash,
              responseStatus: 201,
              responseBody: input.responseView ?? { ...result },
              bookingId: booking.id,
              expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
            },
          });
        }

        // 9. The hold is spent. Its reservations already belong to the
        //    booking, so nothing cascades away with it.
        await tx.hold.delete({ where: { id: input.holdId } });

        return { kind: 'confirmed', booking: result };
      });
    } catch (e) {
      if (e instanceof HoldExpiredError) return { kind: 'hold_expired' };
      if (isExclusionViolation(e)) return { kind: 'slot_taken' };

      // A concurrent request with the same key won the race. Both are the
      // same intent, so return what it produced rather than charging twice.
      if (
        input.idempotencyKey !== null &&
        (e as { code?: unknown })?.code === 'P2002'
      ) {
        const seen = await this.findReplay(input.idempotencyKey);
        if (seen !== null) return { kind: 'replayed', booking: seen };
      }

      BookingRepository.log.error(
        `confirm() failed: ${e instanceof Error ? e.message.slice(0, 400) : String(e)}`,
      );
      throw e;
    }
  }

  private async findReplay(key: string): Promise<ConfirmedBooking | null> {
    const row = await this.prisma.idempotencyKey.findUnique({ where: { key } });
    if (row === null || row.responseBody === null) return null;
    return row.responseBody as unknown as ConfirmedBooking;
  }
}

/**
 * Table 8.8. The pair depends only on the requirement and the rail.
 *
 * Keeping booking status and payment status separate is what lets a Confirmed
 * booking be unpaid, deposit-paid, or fully prepaid without inventing new
 * lifecycle states for each.
 */
function resolveStatus(input: ConfirmBookingInput): {
  status: 'confirmed' | 'pending_payment';
  paymentStatus: 'none_required' | 'unpaid' | 'deposit_paid' | 'fully_paid';
} {
  if (input.payment === null) {
    return { status: 'confirmed', paymentStatus: 'none_required' };
  }
  if (input.payment.rail === 'link') {
    // The link is out. The slot stays reserved for the window, but nothing
    // has been captured, so the booking is not confirmed yet.
    return { status: 'pending_payment', paymentStatus: 'unpaid' };
  }
  return {
    status: 'confirmed',
    paymentStatus:
      input.payment.amountFils >= input.priceFils
        ? 'fully_paid'
        : 'deposit_paid',
  };
}

class HoldExpiredError extends Error {
  constructor() {
    super('hold expired');
  }
}

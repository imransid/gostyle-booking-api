import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { LifecycleRepository } from './lifecycle.repository';
import type { BookingState } from '@domain/booking/payment-webhook';

/** Named: a heredoc eats a line ending in `<`. */
interface StateRow {
  id: string;
  status: string;
  seen: boolean;
}

export interface ApplyInput {
  readonly intentId: string;
  readonly bookingCode: string;
  readonly kind: string;
  readonly amountFils: number;
  readonly rail: string;
  readonly explanation: string;
  /** The refund's own gateway id. Distinct from the payment's. */
  readonly refundRef?: string;
}

/** Rails the ledger accepts. Anything else is recorded as internal. */
const KNOWN_RAILS = new Set([
  'wallet',
  'card',
  'apple_pay',
  'cash',
  'link',
  'internal',
]);

@Injectable()
export class PaymentWebhookRepository {
  private static readonly log = new Logger(PaymentWebhookRepository.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly lifecycle: LifecycleRepository,
  ) {}

  /**
   * The booking, and whether this intent has been seen before.
   *
   * One query for both, because they are one question: "what should happen to
   * this booking, given that this event may already have happened?"
   *
   * The idempotency table is the existing one. A gateway intent is exactly
   * what it was built for: an outside id that must map to one result no
   * matter how many times it arrives.
   */
  async stateFor(
    intentId: string,
    bookingCode: string,
  ): Promise<BookingState | null> {
    const rows = await this.prisma.$queryRaw<StateRow[]>`
      SELECT b.id,
             b.status::text AS status,
             EXISTS (
               SELECT 1 FROM idempotency_key
                WHERE key = ${`webhook:${intentId}`}
             ) AS seen
        FROM booking b
       WHERE b.code = ${bookingCode}`;

    const row = rows[0];
    if (row === undefined) return null;

    return {
      status: row.status,
      alreadySeen: row.seen,
      // The availability question is deliberately not asked here. Only the
      // expired path needs it, and answering it for every webhook would run
      // the engine on every retry of every payment.
      ...(row.status === 'expired'
        ? { slotStillFree: await this.slotStillFree(row.id) }
        : {}),
    };
  }

  /**
   * Did anyone take the slot after this booking expired?
   *
   * The reservations are still there with blocking = false, so the question
   * is whether anything ELSE now blocks that professional at that time.
   */
  private async slotStillFree(bookingId: string): Promise<boolean> {
    const clashes = await this.prisma.$queryRaw<{ n: bigint }[]>`
      SELECT COUNT(*) AS n
        FROM staff_reservation mine
        JOIN staff_reservation theirs
          ON theirs.staff_id = mine.staff_id
         AND theirs.blocking
         AND tstzrange(theirs.start_at, theirs.end_at, '[)')
          && tstzrange(mine.start_at, mine.end_at, '[)')
       WHERE mine.booking_item_id IN (
               SELECT id FROM booking_item WHERE booking_id = ${bookingId}::uuid
             )`;
    return Number(clashes[0]?.n ?? 0) === 0;
  }

  /**
   * Apply the decision and record the intent, in ONE transaction.
   *
   * That pairing is the whole guarantee. Recording the intent without
   * applying would lose a payment; applying without recording would let a
   * retry apply it twice. Either alone is a money bug, so neither happens
   * alone.
   */
  async apply(input: ApplyInput): Promise<void> {
    const booking = await this.prisma.booking.findUnique({
      where: { code: input.bookingCode },
      select: { id: true },
    });
    if (booking === null) return;

    await this.prisma.$transaction(async (tx) => {
      switch (input.kind) {
        case 'confirm':
        case 'reinstate':
          await tx.booking.update({
            where: { id: booking.id },
            data: { status: 'confirmed', paymentStatus: 'deposit_paid' },
          });
          await tx.depositLedger.create({
            data: {
              bookingId: booking.id,
              entryType: 'captured',
              amountFils: input.amountFils,
              rail: railOf(input.rail),
              gatewayRef: input.intentId,
              reason: input.explanation,
              actorKind: 'system',
            },
          });
          // Reinstating has to put the capacity back too: expiry released it.
          if (input.kind === 'reinstate') {
            const items = await tx.bookingItem.findMany({
              where: { bookingId: booking.id },
              select: { id: true },
            });
            const ids = items.map((i) => i.id);
            if (ids.length > 0) {
              await tx.staffReservation.updateMany({
                where: { bookingItemId: { in: ids } },
                data: { blocking: true },
              });
              await tx.resourceReservation.updateMany({
                where: { bookingItemId: { in: ids } },
                data: { blocking: true },
              });
            }
          }
          break;

        case 'auto_refund':
          // Captured then refunded, both recorded. The ledger tells the truth
          // about what happened rather than netting to nothing and hiding it.
          await tx.depositLedger.create({
            data: {
              bookingId: booking.id,
              entryType: 'captured',
              amountFils: input.amountFils,
              rail: railOf(input.rail),
              gatewayRef: input.intentId,
              reason: 'Late payment, arrived after the window closed',
              actorKind: 'system',
            },
          });
          await tx.depositLedger.create({
            data: {
              bookingId: booking.id,
              entryType: 'refunded',
              amountFils: -input.amountFils,
              rail: railOf(input.rail),
              // The REFUND's reference, not the payment's. gateway_ref is
              // unique, and rightly: one external id, one movement.
              gatewayRef: input.refundRef ?? `refund:${input.intentId}`,
              reason: input.explanation,
              actorKind: 'system',
            },
          });
          break;

        case 'record_only':
        case 'refund_settled':
        case 'refund_to_wallet':
        case 'capture_failed':
          // Nothing to change on the booking. The intent record below is the
          // whole point: it stops a retry doing anything at all.
          break;
      }

      await tx.eventOutbox.create({
        data: {
          aggregateType: 'booking',
          aggregateId: booking.id,
          eventType: `payment.${input.kind}`,
          payload: {
            code: input.bookingCode,
            intentId: input.intentId,
            amountFils: input.amountFils,
            rail: input.rail,
            explanation: input.explanation,
          },
        },
      });

      // Same transaction. This is what makes the retry free.
      await tx.idempotencyKey.create({
        data: {
          key: `webhook:${input.intentId}`,
          operation: 'payment_webhook',
          requestHash: input.kind,
          bookingId: booking.id,
          responseStatus: 200,
          responseBody: {
            outcome: input.kind,
            explanation: input.explanation,
          },
          expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
        },
      });
    });

    PaymentWebhookRepository.log.log(
      `${input.bookingCode}: ${input.kind} applied, intent ${input.intentId} recorded`,
    );
  }
}

function railOf(
  rail: string,
): 'wallet' | 'card' | 'apple_pay' | 'cash' | 'link' | 'internal' {
  return KNOWN_RAILS.has(rail)
    ? (rail as 'wallet' | 'card' | 'apple_pay' | 'cash' | 'link' | 'internal')
    : 'internal';
}

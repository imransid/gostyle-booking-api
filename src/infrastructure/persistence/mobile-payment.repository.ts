import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { toUuid } from './hold.repository';
import type { PaymentRail } from '../../generated/prisma/enums';

/**
 * §11: record what the gateway took.
 *
 * ONE TRANSACTION, three writes: the ledger entry, the booking's payment
 * state, and the link window cleared. A payment recorded without clearing
 * the window leaves the sweeper free to expire a booking that has been paid
 * for, which is the worst outcome this endpoint could produce.
 *
 * IDEMPOTENT ON THE GATEWAY'S OWN REFERENCE, not on a header. §11.3 says the
 * same `payment_reference` patched twice returns the same booking rather
 * than recording a second payment, and the database already enforces it:
 * `deposit_ledger_gateway_ref_key` is a partial unique index on
 * `gateway_ref`. So the duplicate is caught by the constraint rather than by
 * a read-then-write that two concurrent gateway callbacks could both pass.
 */

export type RecordPaymentOutcome =
  | { readonly kind: 'not_found' }
  | { readonly kind: 'already_paid'; readonly paymentStatus: string }
  | { readonly kind: 'expired' }
  /** The same reference again. Nothing was written the second time. */
  | { readonly kind: 'replayed'; readonly bookingId: string }
  | {
      readonly kind: 'recorded';
      readonly bookingId: string;
      readonly entryId: string;
    };

@Injectable()
export class MobilePaymentRepository {
  private static readonly log = new Logger(MobilePaymentRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  async record(input: {
    readonly bookingId: string;
    readonly customerId: string;
    readonly amountFils: number;
    readonly rail: PaymentRail;
    readonly reference: string | null;
    readonly paymentStatus: 'deposit_paid' | 'fully_paid' | 'none_required';
    readonly nowMs?: number;
  }): Promise<RecordPaymentOutcome> {
    const nowMs = input.nowMs ?? Date.now();

    // A REPEATED REFERENCE IS ANSWERED BEFORE THE STATE IS JUDGED.
    //
    // The first patch moves the booking out of `unpaid`, so a retry would
    // otherwise be refused 409 already_paid for work it had itself already
    // done -- the gateway would see a failure for a payment that succeeded.
    if (input.reference !== null) {
      const prior = await this.prisma.depositLedger.findFirst({
        where: { gatewayRef: input.reference },
        select: { id: true, bookingId: true },
      });
      if (prior !== null) {
        return { kind: 'replayed', bookingId: prior.bookingId };
      }
    }

    try {
      return await this.prisma.$transaction(
        async (tx) => {
          const rows = await tx.$queryRaw<
            {
              id: string;
              status: string;
              payment_status: string;
              link_expires_at: Date | null;
            }[]
          >`
          SELECT id, status::text AS status,
                 payment_status::text AS payment_status, link_expires_at
            FROM booking
           WHERE id = ${input.bookingId}::uuid
           FOR UPDATE`;

          const b = rows[0];
          if (b === undefined) return { kind: 'not_found' as const };

          // §11.1: only from DRAFT.
          if (b.payment_status !== 'unpaid') {
            return {
              kind: 'already_paid' as const,
              paymentStatus: b.payment_status,
            };
          }

          // §11.7: the draft hold already expired.
          if (
            b.link_expires_at !== null &&
            b.link_expires_at.getTime() <= nowMs
          ) {
            return { kind: 'expired' as const };
          }

          const entry =
            input.amountFils === 0
              ? null
              : await tx.depositLedger.create({
                  data: {
                    bookingId: b.id,
                    entryType: 'captured',
                    amountFils: input.amountFils,
                    rail: input.rail,
                    gatewayRef: input.reference,
                    reason: 'Recorded from the mobile payment callback',
                    actorKind: 'customer',
                    actorId: toUuid(input.customerId),
                  },
                });

          await tx.$executeRawUnsafe(
            `UPDATE booking
              SET payment_status = $2::payment_status,
                  status = CASE WHEN status = 'pending_payment'
                                THEN 'confirmed'::booking_status
                                ELSE status END,
                  -- §11.4: out of the draft hold window. Leaving it set lets
                  -- the sweeper expire a booking that has been paid for.
                  link_expires_at = NULL,
                  updated_at = now()
            WHERE id = $1::uuid`,
            b.id,
            input.paymentStatus,
          );

          if (b.status === 'pending_payment') {
            await tx.bookingStatusHistory.create({
              data: {
                bookingId: b.id,
                fromStatus: 'pending_payment',
                toStatus: 'confirmed',
                reason: 'Payment recorded',
                actorKind: 'customer',
                actorId: toUuid(input.customerId),
              },
            });
          }

          MobilePaymentRepository.log.log(
            `${b.id.slice(0, 8)} paid ${input.amountFils} fils via ${input.rail}`,
          );

          return {
            kind: 'recorded' as const,
            bookingId: b.id,
            entryId: entry?.id ?? '',
          };
        },
        { timeout: 15_000, maxWait: 10_000 },
      );
    } catch (e) {
      /**
       * TWO CALLBACKS, ONE REFERENCE, AT THE SAME INSTANT.
       *
       * The read above catches the ordinary retry. This catches the race the
       * read cannot: both callbacks find nothing, both try to write, and the
       * partial unique index refuses the loser. That is the correct outcome
       * and it is not an error -- the payment IS recorded, by the other one.
       */
      if (isDuplicateReference(e)) {
        const prior = await this.prisma.depositLedger.findFirst({
          where: { gatewayRef: input.reference },
          select: { bookingId: true },
        });
        if (prior !== null) {
          return { kind: 'replayed', bookingId: prior.bookingId };
        }
      }
      throw e;
    }
  }
}

/** The partial unique index on deposit_ledger.gateway_ref. */
function isDuplicateReference(e: unknown): boolean {
  const s = JSON.stringify(
    e instanceof Error ? { m: e.message } : e,
  ).toLowerCase();
  return s.includes('gateway_ref');
}

import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { PrismaService } from '@infrastructure/persistence/prisma.service';
import { BookingRepository } from '@infrastructure/persistence/booking.repository';
import {
  branchInstant,
  toUuid,
} from '@infrastructure/persistence/hold.repository';
import { linkWindow } from '@domain/booking/payment-link';
import { Money } from '@domain/shared/money';
import { shout, type Shouted } from '@application/contract/wire';
import type { ActorKind, BookingStatus } from '@domain/booking/lifecycle';

export interface PaymentLinkView {
  readonly bookingId: string;
  readonly code: string;
  readonly status: Shouted<BookingStatus>;
  readonly outstandingMinor: number;
  readonly outstanding: string;
  readonly expiresAt: string;
  readonly expiresInSeconds: number;
  /** The half-time nudge, so the caller can schedule it. */
  readonly remindAt: string;
  /** Which of the two rules closed the window first. */
  readonly cappedBy: 'SIX_HOURS' | 'START_MINUS_TWO';
  readonly explanation: string;
}

/**
 * The desk sends a payment link.
 *
 * §8.4.1 gives the window as "the shorter of six hours and the time until two
 * hours before the start", and linkWindow() already computes exactly that,
 * including the case the specification leaves out: a start so close that the
 * window has already closed. That case is a refusal here, not a link that
 * expired before it was sent.
 *
 * WHAT IT DOES NOT DO: take money. It moves the booking to PendingPayment and
 * opens the window; the gateway webhook confirms it. The sweeper that expires
 * an unpaid link already exists and needs no changes -- it claims on
 * link_expires_at, which is what this writes.
 */
@Injectable()
export class PaymentLinkHandler {
  private static readonly log = new Logger(PaymentLinkHandler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly bookings: BookingRepository,
  ) {}

  async execute(
    bookingId: string,
    actor: { readonly kind: ActorKind; readonly id: string | null },
    nowMs: number = Date.now(),
  ): Promise<PaymentLinkView> {
    const b = await this.bookings.detail(bookingId);
    if (b === null) throw new NotFoundException('No such booking');

    // Only a live booking can be waiting on money. A cancelled or settled one
    // has nothing outstanding, and a link against it would be a promise to
    // hold a slot that is not held.
    const sendable: BookingStatus[] = ['confirmed', 'pending_payment'];
    if (!sendable.includes(b.status)) {
      throw new ConflictException(
        `A ${shout(b.status)} booking cannot be sent a payment link.`,
      );
    }

    // What is actually owed: the price, less everything the ledger says was
    // taken. THE LEDGER, not the booking row -- it is the accounting truth,
    // and a goodwill credit or a partial refund only shows up there.
    const captured = b.ledger
      .filter(
        (l) => l.entryType === 'captured' || l.entryType === 'course_draw',
      )
      .reduce((n, l) => n + l.amountFils, 0);
    const refunded = b.ledger
      .filter((l) => l.entryType === 'refunded')
      .reduce((n, l) => n + Math.abs(l.amountFils), 0);
    const outstanding = Money.fils(
      Math.max(0, b.priceFils - (captured - refunded)),
    );

    if (outstanding.isZero()) {
      throw new UnprocessableEntityException(
        'This booking owes nothing. There is nothing to send a link for.',
      );
    }

    const day = b.tradingDay.toISOString().slice(0, 10);
    const startAtMs = branchInstant(day, b.startMinute).getTime();
    const window = linkWindow(nowMs, startAtMs);

    if (window.kind === 'too_late') {
      throw new ConflictException(
        `The start is too close for a link: the window shut ` +
          `${window.minutesPastCutoff} minutes ago. Take payment at the desk.`,
      );
    }

    // ONE TRANSACTION. The first live run wrote the booking and then failed
    // the audit insert on a CHECK, leaving a booking sitting in
    // PENDING_PAYMENT with a link and no row saying who sent it or when.
    // The status and the reason it changed are one fact; they commit together
    // or not at all.
    await this.prisma.$transaction(async (tx) => {
      await tx.booking.update({
        where: { id: bookingId },
        data: {
          status: 'pending_payment',
          paymentStatus: 'unpaid',
          linkExpiresAt: new Date(window.expiresAtMs),
          // A re-sent link gets a fresh window, so the half-time reminder
          // that already fired for the old one does not suppress the new one.
          linkRemindedAt: null,
        },
      });

      // RESENDING IS NOT A TRANSITION. bsh_actually_moved refuses a row whose
      // from and to are the same, and it is right to: a booking already
      // waiting on a link has not moved anywhere, it has been nudged. The
      // fresh window is the change, and it is on the booking, not the ladder.
      if (b.status !== 'pending_payment') {
        await tx.bookingStatusHistory.create({
          data: {
            bookingId,
            fromStatus: b.status,
            toStatus: 'pending_payment',
            // (actor_kind = 'system') = (actor_id IS NULL) is a CHECK, and it
            // caught a hard-coded 'staff' with no id on the first live run.
            actorKind: actor.kind,
            actorId: actor.id === null ? null : toUuid(actor.id),
            reason: `Payment link sent for ${outstanding.toString()}`,
          },
        });
      }
    });

    PaymentLinkHandler.log.log(
      `${b.code}: link for ${outstanding.toString()}, closes ` +
        `${new Date(window.expiresAtMs).toISOString()} (${window.capped})`,
    );

    return {
      bookingId,
      code: b.code,
      status: shout('pending_payment'),
      outstandingMinor: outstanding.fils,
      outstanding: outstanding.toString(),
      expiresAt: new Date(window.expiresAtMs).toISOString(),
      expiresInSeconds: Math.round((window.expiresAtMs - nowMs) / 1000),
      remindAt: new Date(window.remindAtMs).toISOString(),
      cappedBy: window.capped === 'six_hours' ? 'SIX_HOURS' : 'START_MINUS_TWO',
      explanation:
        window.capped === 'six_hours'
          ? 'Six hours, the longest a link is ever good for.'
          : 'Closed early: a link always shuts two hours before the start.',
    };
  }
}

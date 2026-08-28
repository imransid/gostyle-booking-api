import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { PrismaService } from '../persistence/prisma.service';
import { LifecycleRepository } from '../persistence/lifecycle.repository';

/**
 * A minute. The window is hours long, so finer buys nothing, and the expiry
 * is the half that matters: a link that closed is a slot the salon can sell.
 */
export const LINK_SWEEP_MS = 60_000;

/** Named: a heredoc eats a line ending in `<`. */
interface LinkRow {
  id: string;
  code: string;
  link_expires_at: Date;
  created_at: Date;
}

@Injectable()
export class PaymentLinkSweeper implements OnModuleInit {
  private static readonly log = new Logger(PaymentLinkSweeper.name);
  private running = false;
  private remindedTotal = 0;
  private expiredTotal = 0;
  private consecutiveFailures = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly lifecycle: LifecycleRepository,
  ) {}

  onModuleInit(): void {
    PaymentLinkSweeper.log.log(
      `Payment link sweeper armed, every ${LINK_SWEEP_MS / 1000}s`,
    );
  }

  @Interval('payment-link', LINK_SWEEP_MS)
  async sweep(): Promise<void> {
    if (this.running) return;
    this.running = true;

    try {
      await this.remindAtHalfTime();
      await this.expireClosed();
      this.consecutiveFailures = 0;
    } catch (e) {
      this.consecutiveFailures += 1;
      if (
        this.consecutiveFailures === 1 ||
        this.consecutiveFailures % 30 === 0
      ) {
        PaymentLinkSweeper.log.error(
          `Sweep failed (${this.consecutiveFailures}x): ` +
            `${e instanceof Error ? e.message : String(e)}`,
        );
      }
    } finally {
      this.running = false;
    }
  }

  /**
   * One nudge, half way through the window.
   *
   * CLAIMED, not selected. Two replicas run this, so the UPDATE stamping
   * link_reminded_at is what decides who sends: the second finds nothing
   * waiting and the customer gets one message rather than two.
   *
   * The midpoint is derived from created_at, because confirming on the link
   * rail IS the moment the link goes out. If links are ever sent separately
   * from confirm, that needs its own column.
   */
  private async remindAtHalfTime(): Promise<void> {
    const now = new Date();

    const claimed = await this.prisma.$queryRaw<LinkRow[]>`
      UPDATE booking
         SET link_reminded_at = now()
       WHERE id IN (
         SELECT id FROM booking
          WHERE status = 'pending_payment'
            AND link_expires_at IS NOT NULL
            AND link_reminded_at IS NULL
            AND ${now} >= created_at + (link_expires_at - created_at) / 2
            AND link_expires_at > ${now}
          ORDER BY link_expires_at
          LIMIT 100
          FOR UPDATE SKIP LOCKED
       )
      RETURNING id, code, link_expires_at, created_at`;

    for (const row of claimed) {
      await this.prisma.eventOutbox.create({
        data: {
          aggregateType: 'booking',
          aggregateId: row.id,
          eventType: 'reminder.payment_link',
          payload: {
            code: row.code,
            expiresAt: row.link_expires_at.toISOString(),
            minutesLeft: Math.round(
              (row.link_expires_at.getTime() - now.getTime()) / 60_000,
            ),
          },
        },
      });
      this.remindedTotal += 1;
    }

    if (claimed.length > 0) {
      PaymentLinkSweeper.log.log(`${claimed.length} link reminder(s) sent`);
    }
  }

  /**
   * The window closed unpaid.
   *
   * The transition goes through the SAME path everything else uses, so the
   * slot is released, the history is written, and the event is published,
   * which is what puts the gap in front of the waitlist. That last part is
   * the whole point: an expired link should turn into someone else's booking,
   * not into an empty chair.
   */
  private async expireClosed(): Promise<void> {
    const closed = await this.prisma.$queryRaw<LinkRow[]>`
      SELECT id, code, link_expires_at, created_at
        FROM booking
       WHERE status = 'pending_payment'
         AND link_expires_at IS NOT NULL
         AND link_expires_at <= ${new Date()}
       ORDER BY link_expires_at
       LIMIT 50`;

    for (const row of closed) {
      const outcome = await this.lifecycle.transition({
        bookingId: row.id,
        to: 'expired',
        actor: 'system',
        actorId: null,
        reason: 'The payment link window closed unpaid.',
      });

      if (outcome.kind === 'transitioned') {
        this.expiredTotal += 1;
        PaymentLinkSweeper.log.log(`${row.code} expired, link window closed`);
      }
    }
  }

  stats(): { intervalMs: number; remindedTotal: number; expiredTotal: number } {
    return {
      intervalMs: LINK_SWEEP_MS,
      remindedTotal: this.remindedTotal,
      expiredTotal: this.expiredTotal,
    };
  }
}

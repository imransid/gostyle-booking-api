import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { PrismaService } from '../persistence/prisma.service';
import { CONFIRMATION_WINDOW_HOURS } from '@domain/booking/auto-confirm';

/** Hourly. A 48-hour window does not need a finer grain than that. */
export const CONFIRM_ASK_SWEEP_MS = 60 * 60 * 1000;

/**
 * Lapses confirmation asks nobody answered.
 *
 * An `ask_each_time` occurrence is materialised as PendingConfirmation and
 * the customer has 48 hours. Silence is an answer: the slot goes back to the
 * diary and the occurrence is marked skipped.
 *
 * WHY THIS HAD TO EXIST. The 48-hour rule was written, specified and tested
 * in the domain, and nothing ever ran it. Every unanswered ask sat as
 * PendingConfirmation forever, holding a chair against a visit that was
 * never going to happen — the exact failure the rule was written to prevent.
 *
 * THE SWEEP IS THE SAME TRANSITION THE DESK WOULD MAKE, so the released slot
 * wakes the waitlist through the ordinary event rather than a special path.
 */
@Injectable()
export class ConfirmAskSweeper {
  private static readonly log = new Logger(ConfirmAskSweeper.name);
  private running = false;

  constructor(private readonly prisma: PrismaService) {}

  @Interval('confirm-ask-expiry', CONFIRM_ASK_SWEEP_MS)
  async sweep(): Promise<void> {
    // One at a time. An hourly job that overlaps itself is an hourly job
    // that has already stopped being hourly.
    if (this.running) return;
    this.running = true;
    try {
      const lapsed = await this.run();
      if (lapsed > 0) {
        ConfirmAskSweeper.log.log(`${lapsed} confirmation ask(s) lapsed`);
      }
    } catch (e) {
      // Logged from the FIRST failure, not after retries: a job that fails
      // silently for a day is a diary full of slots nobody can sell.
      ConfirmAskSweeper.log.error(
        `Confirm-ask sweep failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      this.running = false;
    }
  }

  /** Exposed so the behaviour can be driven directly in a test or by hand. */
  async run(nowMs: number = Date.now()): Promise<number> {
    const cutoff = new Date(nowMs - CONFIRMATION_WINDOW_HOURS * 60 * 60 * 1000);

    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ id: string; code: string }[]>`
        UPDATE booking
           SET status = 'expired', updated_at = now()
         WHERE id IN (
           SELECT id FROM booking
            WHERE status = 'pending_confirmation'
              AND created_at <= ${cutoff}
            ORDER BY created_at
            LIMIT 200
            FOR UPDATE SKIP LOCKED
         )
        RETURNING id, code`;

      for (const r of rows) {
        await tx.bookingStatusHistory.create({
          data: {
            bookingId: r.id,
            fromStatus: 'pending_confirmation',
            toStatus: 'expired',
            reason: `No answer within ${CONFIRMATION_WINDOW_HOURS} hours`,
            actorKind: 'system',
          },
        });
        await tx.eventOutbox.create({
          data: {
            aggregateType: 'booking',
            aggregateId: r.id,
            eventType: 'booking.confirm_ask_expired',
            payload: { code: r.code },
          },
        });
      }

      return rows.length;
    });
  }
}

import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { PrismaService } from '../persistence/prisma.service';
import { LifecycleRepository } from '../persistence/lifecycle.repository';
import { AUTO_NO_SHOW_MIN } from '@domain/booking/lifecycle';

export const NO_SHOW_SWEEP_MS = 60_000;

/** Named: a heredoc eats a line ending in `<`. */
interface StaleRow {
  id: string;
  code: string;
}

@Injectable()
export class NoShowSweeper implements OnModuleInit {
  private static readonly log = new Logger(NoShowSweeper.name);
  private running = false;
  private markedTotal = 0;
  private consecutiveFailures = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly lifecycle: LifecycleRepository,
  ) {}

  onModuleInit(): void {
    NoShowSweeper.log.log(
      `Auto no-show sweeper armed, every ${NO_SHOW_SWEEP_MS / 1000}s`,
    );
  }

  @Interval('auto-no-show', NO_SHOW_SWEEP_MS)
  async sweep(): Promise<void> {
    if (this.running) return;
    this.running = true;

    try {
      const cutoff = new Date(Date.now() - AUTO_NO_SHOW_MIN * 60_000);

      const stale = await this.prisma.$queryRaw<StaleRow[]>`
        SELECT id, code
          FROM booking
         WHERE status = 'confirmed'
           AND start_at <= ${cutoff}
         ORDER BY start_at
         LIMIT 50`;

      NoShowSweeper.log.log(
        `${stale.length} candidate(s) past start plus ${AUTO_NO_SHOW_MIN}`,
      );

      for (const row of stale) {
        const outcome = await this.lifecycle.transition({
          bookingId: row.id,
          to: 'no_show',
          actor: 'system',
          actorId: null,
          // The constraint requires a reason for anything destructive, and it
          // is right to: a no-show with no explanation is unanswerable months
          // later. The system HAS a reason, it just was not writing one.
          reason: `Nobody arrived within ${AUTO_NO_SHOW_MIN} minutes of the start.`,
        });

        if (outcome.kind === 'transitioned') {
          this.markedTotal += 1;
          NoShowSweeper.log.log(
            `${row.code} auto no-show at start plus ${AUTO_NO_SHOW_MIN}`,
          );
        }
        // Anything else means the desk got there first, which is the outcome
        // the whole grace window exists to allow. Not worth a log line.
      }

      this.consecutiveFailures = 0;
    } catch (e) {
      this.consecutiveFailures += 1;
      if (
        this.consecutiveFailures === 1 ||
        this.consecutiveFailures % 30 === 0
      ) {
        NoShowSweeper.log.error(
          `Sweep failed (${this.consecutiveFailures}x): ` +
            `${e instanceof Error ? e.message : String(e)}`,
        );
      }
    } finally {
      this.running = false;
    }
  }

  stats(): { intervalMs: number; markedTotal: number } {
    return { intervalMs: NO_SHOW_SWEEP_MS, markedTotal: this.markedTotal };
  }
}

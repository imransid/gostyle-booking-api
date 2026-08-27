import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { WaitlistRepository } from '../persistence/waitlist.repository';

/**
 * The offer TTL is fifteen minutes, so a thirty-second tick costs a candidate
 * at most half a minute of someone else's time. Finer would be noise; coarser
 * starts to matter when the freed slot is later the same day.
 */
export const WAITLIST_SWEEP_MS = 30_000;

@Injectable()
export class WaitlistSweeper {
  private static readonly log = new Logger(WaitlistSweeper.name);
  private running = false;
  private passedTotal = 0;
  private consecutiveFailures = 0;

  constructor(private readonly waitlist: WaitlistRepository) {}

  @Interval('waitlist-sweep', WAITLIST_SWEEP_MS)
  async sweep(): Promise<void> {
    // A slow sweep must never overlap itself. The claim makes it safe either
    // way; two ticks racing just pile up connections for nothing.
    if (this.running) return;
    this.running = true;

    try {
      this.passedTotal += await this.waitlist.sweepExpiredOffers();
      this.consecutiveFailures = 0;
    } catch (e) {
      this.consecutiveFailures += 1;
      // First failure, then every thirtieth. A database outage otherwise
      // writes the same line twice a minute and buries everything else.
      if (
        this.consecutiveFailures === 1 ||
        this.consecutiveFailures % 30 === 0
      ) {
        WaitlistSweeper.log.error(
          `Sweep failed (${this.consecutiveFailures}x): ` +
            `${e instanceof Error ? e.message : String(e)}`,
        );
      }
    } finally {
      this.running = false;
    }
  }

  /** For /health, so the pass-down is observable rather than assumed. */
  stats(): {
    intervalMs: number;
    passedTotal: number;
    consecutiveFailures: number;
  } {
    return {
      intervalMs: WAITLIST_SWEEP_MS,
      passedTotal: this.passedTotal,
      consecutiveFailures: this.consecutiveFailures,
    };
  }
}

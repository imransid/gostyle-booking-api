import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { HoldRepository } from '../persistence/hold.repository';

/** Fast enough that a walked-away customer costs at most half a minute. */
export const SWEEP_INTERVAL_MS = 30_000;

@Injectable()
export class HoldSweeper {
  private static readonly log = new Logger(HoldSweeper.name);
  private running = false;
  private sweptTotal = 0;

  constructor(private readonly holds: HoldRepository) {}

  @Interval('hold-sweep', SWEEP_INTERVAL_MS)
  async sweep(): Promise<void> {
    // A slow sweep must never overlap itself and pile up connections.
    if (this.running) return;
    this.running = true;

    try {
      const swept = await this.holds.sweepExpired();
      this.sweptTotal += swept;
    } catch (e) {
      // Never let a failed sweep kill the interval. It runs again in 30s,
      // and the work is idempotent, so a missed pass costs nothing.
      HoldSweeper.log.error(
        `Sweep failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      this.running = false;
    }
  }

  /** For the health endpoint, so the sweep is observable rather than assumed. */
  stats(): { intervalMs: number; sweptTotal: number } {
    return { intervalMs: SWEEP_INTERVAL_MS, sweptTotal: this.sweptTotal };
  }
}

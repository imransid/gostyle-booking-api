import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import {
  MobileSeriesJobHandler,
  type MobileSeriesJobReport,
} from '@application/commands/mobile-series-job.handler';
import { MOBILE_SERIES_BOOKING } from '@interface/http/mobile-series.flag';

/**
 * Hourly, as plan E.4 says. Nothing in it is minute-sensitive: a pause ends
 * on a day, a reminder is 48 hours ahead, a far-off visit waits for a date.
 */
export const MOBILE_SERIES_JOB_MS = 60 * 60 * 1000;

@Injectable()
export class MobileSeriesJob {
  private static readonly log = new Logger(MobileSeriesJob.name);
  private running = false;
  private runs = 0;
  private last: MobileSeriesJobReport | null = null;
  private consecutiveFailures = 0;

  constructor(private readonly job: MobileSeriesJobHandler) {}

  @Interval('mobile-series-job', MOBILE_SERIES_JOB_MS)
  async tick(): Promise<void> {
    // Behind the routes' own switch: off, the job does nothing at all.
    if (!MOBILE_SERIES_BOOKING()) return;
    // A slow run must never overlap itself. The claims are safe either way,
    // but two runs racing just pile up connections for no gain.
    if (this.running) return;
    this.running = true;

    try {
      this.last = await this.job.run();
      this.runs += 1;
      this.consecutiveFailures = 0;
    } catch (e) {
      this.consecutiveFailures += 1;
      // First failure, then once a day, so an outage does not bury the logs.
      if (
        this.consecutiveFailures === 1 ||
        this.consecutiveFailures % 24 === 0
      ) {
        MobileSeriesJob.log.error(
          `Run failed (${this.consecutiveFailures}x): ` +
            `${e instanceof Error ? e.message : String(e)}`,
        );
      }
    } finally {
      this.running = false;
    }
  }

  /** For /health, so the job is observable rather than assumed. */
  stats(): {
    intervalMs: number;
    runs: number;
    last: MobileSeriesJobReport | null;
    consecutiveFailures: number;
  } {
    return {
      intervalMs: MOBILE_SERIES_JOB_MS,
      runs: this.runs,
      last: this.last,
      consecutiveFailures: this.consecutiveFailures,
    };
  }
}

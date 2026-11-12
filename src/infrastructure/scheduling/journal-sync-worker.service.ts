import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import {
  JournalSyncHandler,
  type JournalSyncRunReport,
} from '@application/commands/journal-sync.handler';

/**
 * Every 5s. A posting is not urgent to the customer, but a desk looking for
 * a booking's entry should not wait a minute for it, and an idle tick is one
 * lookup on an empty partial index.
 */
export const JOURNAL_SYNC_MS = 5_000;

/**
 * The clock for JournalSyncHandler: send due ledger rows to the platform's
 * general ledger. Whether anything is sent is the handler's switch
 * (JOURNAL_POSTING_ENABLED), read on every tick.
 */
@Injectable()
export class JournalSyncWorker implements OnModuleInit {
  private static readonly log = new Logger(JournalSyncWorker.name);
  private running = false;
  private runs = 0;
  private last: JournalSyncRunReport | null = null;
  private consecutiveFailures = 0;

  constructor(private readonly handler: JournalSyncHandler) {}

  onModuleInit(): void {
    JournalSyncWorker.log.log(
      `Journal sync armed, every ${JOURNAL_SYNC_MS / 1000}s`,
    );
  }

  @Interval('journal-sync', JOURNAL_SYNC_MS)
  async tick(): Promise<void> {
    // A slow batch (the platform timing out) must never overlap itself. The
    // claims are safe either way; two runs racing only add load.
    if (this.running) return;
    this.running = true;

    try {
      this.last = await this.handler.run();
      this.runs += 1;
      this.consecutiveFailures = 0;
    } catch (e) {
      this.consecutiveFailures += 1;
      // First failure, then every thirtieth, so an outage does not bury the
      // log. A failure HERE is the database, not the platform: per-row
      // failures are handled, logged and backed off inside the run.
      if (
        this.consecutiveFailures === 1 ||
        this.consecutiveFailures % 30 === 0
      ) {
        JournalSyncWorker.log.error(
          `Journal sync tick failed (${this.consecutiveFailures}x): ` +
            `${e instanceof Error ? e.message : String(e)}`,
        );
      }
    } finally {
      this.running = false;
    }
  }

  /** What the last run did, so the worker is observable rather than assumed. */
  stats(): {
    intervalMs: number;
    runs: number;
    last: JournalSyncRunReport | null;
    consecutiveFailures: number;
  } {
    return {
      intervalMs: JOURNAL_SYNC_MS,
      runs: this.runs,
      last: this.last,
      consecutiveFailures: this.consecutiveFailures,
    };
  }
}

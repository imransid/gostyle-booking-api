import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { ReminderRepository } from '../persistence/reminder.repository';

/**
 * A minute of drift on a 24-hour reminder is nothing, and on the 15-minute
 * nudge it is the difference between "running late?" and "you missed it".
 * One minute is the coarsest tick the last rung can tolerate.
 */
export const REMINDER_INTERVAL_MS = 60_000;

@Injectable()
export class ReminderScheduler {
  private static readonly log = new Logger(ReminderScheduler.name);
  private running = false;
  private sentTotal = 0;
  private skippedTotal = 0;
  private consecutiveFailures = 0;

  constructor(private readonly reminders: ReminderRepository) {}

  @Interval('reminder-ladder', REMINDER_INTERVAL_MS)
  async tick(): Promise<void> {
    // A slow tick must never overlap itself. The claim is safe either way,
    // but two ticks racing just pile up connections for no gain.
    if (this.running) return;
    this.running = true;

    try {
      for (const r of await this.reminders.runLadder()) {
        this.sentTotal += r.sent;
        this.skippedTotal += r.skipped;
      }
      this.consecutiveFailures = 0;
    } catch (e) {
      this.consecutiveFailures += 1;
      // First failure, then every thirtieth. A database outage otherwise
      // writes one identical line a minute and buries everything else.
      if (
        this.consecutiveFailures === 1 ||
        this.consecutiveFailures % 30 === 0
      ) {
        ReminderScheduler.log.error(
          `Ladder tick failed (${this.consecutiveFailures}x): ` +
            `${e instanceof Error ? e.message : String(e)}`,
        );
      }
    } finally {
      this.running = false;
    }
  }

  /** For /health, so the ladder is observable rather than assumed. */
  stats(): {
    intervalMs: number;
    sentTotal: number;
    skippedTotal: number;
    consecutiveFailures: number;
  } {
    return {
      intervalMs: REMINDER_INTERVAL_MS,
      sentTotal: this.sentTotal,
      skippedTotal: this.skippedTotal,
      consecutiveFailures: this.consecutiveFailures,
    };
  }
}

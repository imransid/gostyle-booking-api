import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import {
  DISPATCH_BATCH,
  DispatchRemindersHandler,
  type DispatchReport,
} from '@application/commands/dispatch-reminders.handler';

/**
 * Ten seconds. The ladder claims on a one-minute tick, so a reminder waits
 * at most a few seconds more here; any finer is polling for its own sake.
 */
export const REMINDER_DISPATCH_MS = 10_000;

/**
 * Batches per tick. A backlog after an outage drains at up to a hundred
 * deliveries a tick per replica, without one tick running unbounded.
 */
export const MAX_BATCHES_PER_TICK = 10;

/**
 * Sends the reminders the outbox has queued: the dispatcher's clock.
 *
 * Holds no state that matters. Everything it knows is in notification_delivery,
 * so a restart -- planned, crashed or kill -9 -- loses nothing: the next tick
 * on any replica picks up whatever is due, and rows a dead worker had claimed
 * come due again when their lease runs out.
 */
@Injectable()
export class ReminderDispatchJob {
  private static readonly log = new Logger(ReminderDispatchJob.name);
  private running = false;
  private consecutiveFailures = 0;
  private totals = {
    sent: 0,
    retrying: 0,
    failed: 0,
    skipped: 0,
    superseded: 0,
    lost: 0,
  };

  constructor(private readonly dispatcher: DispatchRemindersHandler) {}

  @Interval('reminder-dispatch', REMINDER_DISPATCH_MS)
  async tick(): Promise<void> {
    // A slow tick must never overlap itself. The claim is safe either way,
    // but two ticks racing just pile up connections for no gain.
    if (this.running) return;
    this.running = true;

    try {
      for (let i = 0; i < MAX_BATCHES_PER_TICK; i++) {
        const report = await this.dispatcher.run();
        this.add(report);
        if (report.claimed < DISPATCH_BATCH) break;
      }
      this.consecutiveFailures = 0;
    } catch (e) {
      this.consecutiveFailures += 1;
      // First failure, then every thirtieth (five minutes of ticks). A
      // database outage otherwise writes one identical line every ten seconds.
      if (
        this.consecutiveFailures === 1 ||
        this.consecutiveFailures % 30 === 0
      ) {
        ReminderDispatchJob.log.error(
          `Dispatch tick failed (${this.consecutiveFailures}x): ` +
            `${e instanceof Error ? e.message : String(e)}`,
        );
      }
    } finally {
      this.running = false;
    }
  }

  private add(r: DispatchReport): void {
    this.totals.sent += r.sent;
    this.totals.retrying += r.retrying;
    this.totals.failed += r.failed;
    this.totals.skipped += r.skipped;
    this.totals.superseded += r.superseded;
    this.totals.lost += r.lost;
  }

  /** For /health: what this process has sent since it started. */
  stats(): {
    intervalMs: number;
    consecutiveFailures: number;
    sinceStart: Readonly<typeof this.totals>;
  } {
    return {
      intervalMs: REMINDER_DISPATCH_MS,
      consecutiveFailures: this.consecutiveFailures,
      sinceStart: { ...this.totals },
    };
  }
}

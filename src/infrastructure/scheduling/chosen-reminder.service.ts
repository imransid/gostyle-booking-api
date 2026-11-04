import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import {
  PlanChosenRemindersHandler,
  type ChosenReport,
} from '@application/commands/plan-chosen-reminders.handler';
import { REMINDER_INTERVAL_MS } from './reminder-scheduler.service';
import { chosenRemindersOn } from './reminder-choice.flag';

/**
 * The clock of the app customer's own reminder: the ladder's minute.
 *
 * Its own job, beside the ladder rather than inside it, so the ladder's
 * module needs nothing from customer-api. Safe on every replica at once:
 * the claim is a conditional UPDATE (ReminderRepository.claimChosen).
 */
@Injectable()
export class ChosenReminderJob {
  private static readonly log = new Logger(ChosenReminderJob.name);
  private running = false;
  private consecutiveFailures = 0;
  private consecutiveUnanswered = 0;
  private totals = { sent: 0, skipped: 0, lost: 0 };

  constructor(private readonly planner: PlanChosenRemindersHandler) {}

  @Interval('reminder-chosen', REMINDER_INTERVAL_MS)
  async tick(): Promise<void> {
    if (!chosenRemindersOn()) return;
    if (this.running) return;
    this.running = true;

    try {
      this.add(await this.planner.run());
      this.consecutiveFailures = 0;
    } catch (e) {
      this.consecutiveFailures += 1;
      // First failure, then every thirtieth, as the ladder logs.
      if (
        this.consecutiveFailures === 1 ||
        this.consecutiveFailures % 30 === 0
      ) {
        ChosenReminderJob.log.error(
          `Chosen reminder tick failed (${this.consecutiveFailures}x): ` +
            `${e instanceof Error ? e.message : String(e)}`,
        );
      }
    } finally {
      this.running = false;
    }
  }

  private add(r: ChosenReport): void {
    this.totals.sent += r.sent;
    this.totals.skipped += r.skipped;
    this.totals.lost += r.lost;
    if (r.unavailable) {
      this.consecutiveUnanswered += 1;
      if (
        this.consecutiveUnanswered === 1 ||
        this.consecutiveUnanswered % 30 === 0
      ) {
        ChosenReminderJob.log.warn(
          `customer-api did not answer GetReminderLeads ` +
            `(${this.consecutiveUnanswered}x); ${r.candidates} reminder(s) wait`,
        );
      }
    } else {
      this.consecutiveUnanswered = 0;
    }
  }

  /** For /health. */
  stats(): {
    intervalMs: number;
    on: boolean;
    consecutiveFailures: number;
    consecutiveUnanswered: number;
    sinceStart: Readonly<typeof this.totals>;
  } {
    return {
      intervalMs: REMINDER_INTERVAL_MS,
      on: chosenRemindersOn(),
      consecutiveFailures: this.consecutiveFailures,
      consecutiveUnanswered: this.consecutiveUnanswered,
      sinceStart: { ...this.totals },
    };
  }
}

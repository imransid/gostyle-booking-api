import { Inject, Injectable, Logger } from '@nestjs/common';
import { chosenVerdict } from '@domain/booking/chosen-reminder';
import {
  REMINDER_LEADS,
  type ReminderLeadReader,
} from '@application/ports/reminder-leads.port';
import { ReminderRepository } from '@infrastructure/persistence/reminder.repository';

export interface ChosenReport {
  /** Outstanding app bookings looked at. */
  readonly candidates: number;
  readonly sent: number;
  readonly skipped: number;
  /** Not due, or not wanted right now: asked again next tick. */
  readonly waiting: number;
  /** Another replica claimed it first, or it moved since the read. */
  readonly lost: number;
  /** customer-api did not answer: nothing was decided this tick. */
  readonly unavailable: boolean;
}

/**
 * The app customer's own reminder, one tick (MOBILE_REMINDER_CHOICE).
 *
 *   outstanding app bookings in the next day -> ONE question to customer-api
 *   for all their customers -> per booking, the domain's verdict -> claim
 *
 * Without an answer nothing is decided: the reminders wait a minute rather
 * than go at a guessed time, and customer-api is also what would send them.
 */
@Injectable()
export class PlanChosenRemindersHandler {
  private static readonly log = new Logger(PlanChosenRemindersHandler.name);

  constructor(
    private readonly reminders: ReminderRepository,
    @Inject(REMINDER_LEADS) private readonly leads: ReminderLeadReader,
  ) {}

  async run(nowMs: number = Date.now()): Promise<ChosenReport> {
    const candidates = await this.reminders.chosenCandidates(nowMs);
    const report = {
      candidates: candidates.length,
      sent: 0,
      skipped: 0,
      waiting: 0,
      lost: 0,
      unavailable: false,
    };
    if (candidates.length === 0) return report;

    const answer = await this.leads.leads(candidates.map((c) => c.customerId));
    if (answer.kind === 'unavailable') {
      return { ...report, unavailable: true };
    }

    for (const c of candidates) {
      const verdict = chosenVerdict({
        startAtMs: c.startAtMs,
        touchedAtMs: c.touchedAtMs,
        nowMs,
        choice: answer.leads.get(c.customerId) ?? null,
      });
      if (verdict.kind === 'wait') {
        report.waiting += 1;
        continue;
      }
      const outcome = await this.reminders.claimChosen(c, verdict);
      report[outcome] += 1;
      if (outcome === 'skipped') {
        PlanChosenRemindersHandler.log.log(
          `chosen reminder for ${c.code} passed over (${verdict.kind === 'skip' ? verdict.reason : ''})`,
        );
      }
    }

    if (report.sent > 0) {
      PlanChosenRemindersHandler.log.log(
        `chosen reminders: ${report.sent} sent, ${report.skipped} passed over`,
      );
    }
    return report;
  }
}

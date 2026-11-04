/**
 * The app customer's own reminder (MOBILE_REMINDER_CHOICE).
 *
 * One reminder per visit, at the lead the customer chose in the app: 30
 * minutes, 1 hour, 2 hours or 1 day before. It replaces the three fixed
 * rungs for app bookings; desk bookings keep the ladder in reminders.ts.
 *
 * The choice is not stored here. customer-api holds it, and the ladder asks
 * for it every tick (gRPC GetReminderLeads), so a change in the app counts
 * from the next minute. This file only decides, for one booking and one
 * answer, what to do now.
 */

const MIN = 60_000;

/** The furthest lead there is (1 day), plus a tick of slack. */
export const CHOSEN_HORIZON_MS = 24 * 60 * MIN + 2 * MIN;

/**
 * Closer to the start than this, a reminder that has not gone yet is
 * skipped: "your visit is in 5 minutes" helps nobody already on the way.
 */
export const TOO_LATE_MS = 15 * MIN;

/** Due more than this long ago: sent, but marked late in the event. */
export const LATE_AFTER_MS = 5 * MIN;

/** The four times the app offers. Anything else is not a choice. */
export const LEAD_MINUTES: ReadonlySet<number> = new Set([30, 60, 120, 1440]);

/** What customer-api answered for one customer. */
export interface ReminderChoice {
  /** NotificationPreference.appointment_reminder. */
  readonly enabled: boolean;
  /** NotificationPreference.reminder_lead_minutes. */
  readonly leadMinutes: number;
}

export type ChosenVerdict =
  /** Not now: not due yet, or not wanted, or no answer for this customer. */
  | { readonly kind: 'wait' }
  | {
      readonly kind: 'send';
      readonly leadMinutes: number;
      readonly late: boolean;
    }
  | {
      readonly kind: 'skip';
      readonly leadMinutes: number;
      readonly reason: 'booked_late' | 'too_late';
    };

/**
 * What to do with one outstanding booking.
 *
 *   wait  nothing is stamped, so it is asked again next tick. A customer
 *         who turns reminders back on, or picks an earlier time, is heard.
 *   send  stamp it and write the reminder.
 *   skip  stamp it, write nothing. Two cases (decision D6):
 *         booked_late  the booking was made, moved or touched AFTER its
 *                      reminder time: the confirmation or the "moved"
 *                      message just told them.
 *         too_late     the visit starts within TOO_LATE_MS.
 *
 * A customer who moved their reminder earlier after its time had passed
 * (1 day, chosen 10 hours before) gets it at once: the booking itself was
 * not touched after the new time, so it is not booked_late.
 */
export function chosenVerdict(input: {
  readonly startAtMs: number;
  /** booking.updated_at: its create, its last move, or any later change. */
  readonly touchedAtMs: number;
  readonly nowMs: number;
  /** Null: customer-api knows no such customer (a desk walk-in). */
  readonly choice: ReminderChoice | null;
}): ChosenVerdict {
  const { choice } = input;
  if (choice === null || !choice.enabled) return { kind: 'wait' };
  // An answer outside the four is a customer-api this build does not
  // understand; waiting costs a minute, guessing could send at random.
  if (!LEAD_MINUTES.has(choice.leadMinutes)) return { kind: 'wait' };

  const dueMs = input.startAtMs - choice.leadMinutes * MIN;
  if (input.nowMs < dueMs) return { kind: 'wait' };

  const leadMinutes = choice.leadMinutes;
  if (input.startAtMs - input.nowMs < TOO_LATE_MS) {
    return { kind: 'skip', leadMinutes, reason: 'too_late' };
  }
  if (input.touchedAtMs >= dueMs) {
    return { kind: 'skip', leadMinutes, reason: 'booked_late' };
  }
  return {
    kind: 'send',
    leadMinutes,
    late: input.nowMs - dueMs > LATE_AFTER_MS,
  };
}

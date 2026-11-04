import type { ReminderChoice } from '@domain/booking/chosen-reminder';

/**
 * Each app customer's reminder switch and chosen lead, asked of customer-api
 * once a ladder tick for every customer with a visit coming up (gRPC
 * CustomerNotifications.GetReminderLeads). Nothing is copied here: a change
 * in the app counts from the next tick.
 *
 *   answered     a customer missing from the map has no account there
 *   unavailable  no answer; the tick asks again next minute
 */
export type ReminderLeadsAnswer =
  | {
      readonly kind: 'answered';
      readonly leads: ReadonlyMap<string, ReminderChoice>;
    }
  | { readonly kind: 'unavailable'; readonly error: string };

export interface ReminderLeadReader {
  leads(customerIds: readonly string[]): Promise<ReminderLeadsAnswer>;
}

export const REMINDER_LEADS = Symbol('REMINDER_LEADS');

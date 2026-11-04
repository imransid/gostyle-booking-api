import type { HubNotice } from '@domain/booking/hub-notification';
import type { ChannelOutcome } from '@domain/booking/reminder-delivery';

/**
 * Hand one customer-facing event to customer-api's Notification Center
 * (gRPC CustomerNotifications.Notify, MOBILE_NOTIFY_HUB).
 *
 * booking-api sends facts, not words: customer-api writes the title and
 * body (in the salon's own time zone), keeps the item, and sends the push
 * and email by the customer's switches. `dedupeKey` is the idempotency key
 * there: the same key for the same customer is one notification, so a
 * retry here can never make a second one.
 */
export type NotifyRequest = HubNotice;

/**
 * Classified at the adapter, in the words the retry rule understands:
 *
 *   sent     kept (accepted, a duplicate of one already kept, or a
 *            promotion its switch keeps out), ref = outcome:notification id
 *   skipped  customer_not_found: no app customer with this id (a desk walk-in)
 *   failed   INVALID_ARGUMENT: this request can never work
 *   retry    no answer, or customer-api not ready for it yet
 */
export interface CustomerNotifier {
  notify(request: NotifyRequest): Promise<ChannelOutcome>;
}

export const CUSTOMER_NOTIFIER = Symbol('CUSTOMER_NOTIFIER');

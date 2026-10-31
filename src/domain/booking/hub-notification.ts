/**
 * Handing a booking event to customer-api's Notification Center
 * (MOBILE_NOTIFY_HUB).
 *
 * The outbox event becomes one notification_delivery row on channel `hub`
 * (HubListener); when the dispatcher claims it, this decides what to hand
 * over, from the booking AS IT IS THEN. Nothing here knows about gRPC or
 * the database.
 *
 * booking-api sends facts, not words: customer-api writes the sentence,
 * with the salon's name and the time on the salon's clock.
 */
import { REMINDER_LIVE_STATUSES } from './reminders';
import {
  CHECK_IN_ANSWER_EVENTS,
  checkInPushCopy,
  type CheckInAnswer,
} from './check-in-push';

/**
 * What is handed over: facts, and the key that makes a repeat harmless.
 * The port (CUSTOMER_NOTIFIER) takes exactly this.
 */
export interface HubNotice {
  readonly consumerId: string;
  /** A kind the center knows, e.g. "booking.confirmed". */
  readonly type: string;
  /** The center's idempotency key: the same key, one notification. */
  readonly dedupeKey: string;
  /** booking_id, booking_code, branch_id, start_at (ISO). */
  readonly params: Readonly<Record<string, string>>;
  readonly targetType: string;
  readonly targetId: string;
  /** ISO. No alert after this. */
  readonly deliverBy: string;
}

/** The booking events a customer hears about through the hub. */
export const HUB_EVENTS: ReadonlySet<string> = new Set([
  'booking.confirmed',
  // The mobile PATCH that records a payment and moves the booking from
  // pending_payment to confirmed: the moment it is really confirmed.
  'booking.payment_recorded',
  'booking.rescheduled',
  'booking.cancelled',
  // The app customer's own reminder, at the time they chose
  // (MOBILE_REMINDER_CHOICE, chosen-reminder.ts).
  'reminder.chosen',
  // The desk's answer to "I am here" (check-in-push.ts): approved,
  // rejected, expired. To whoever tapped.
  ...Object.values(CHECK_IN_ANSWER_EVENTS),
]);

/**
 * Still waiting for its payment. booking.confirmed is written when an app
 * booking is created DRAFT, before anything is paid; "confirmed" then is
 * not true yet, and the customer hears it when the payment is recorded.
 */
const AWAITING_PAYMENT: ReadonlySet<string> = new Set([
  'draft',
  'held',
  'pending_payment',
]);

/** Where "your booking is confirmed" is still true to say. */
const CONFIRMED: ReadonlySet<string> = new Set([
  'confirmed',
  'checked_in',
  'in_service',
  'completed',
  'settled',
]);

export interface HubBooking {
  readonly id: string;
  readonly code: string;
  readonly status: string;
  readonly startAtMs: number;
  readonly branchId: string;
}

export type HubPlan =
  | { readonly kind: 'send'; readonly request: HubNotice }
  | { readonly kind: 'skip'; readonly reason: string };

export function hubPlan(input: {
  readonly eventType: string;
  /** The outbox event the row came from. */
  readonly sourceEventId: string;
  readonly customerId: string;
  readonly booking: HubBooking | null;
  /** The booking start the row was written for. */
  readonly scheduledForMs: number;
  readonly expiresAtMs: number;
}): HubPlan {
  const { booking } = input;
  if (booking === null) return { kind: 'skip', reason: 'booking_gone' };

  const send = (type: string, dedupeKey: string): HubPlan => ({
    kind: 'send',
    request: {
      consumerId: input.customerId,
      type,
      dedupeKey,
      params: {
        booking_id: booking.id,
        booking_code: booking.code,
        branch_id: booking.branchId,
        start_at: new Date(booking.startAtMs).toISOString(),
      },
      targetType: 'booking',
      targetId: booking.id,
      deliverBy: new Date(input.expiresAtMs).toISOString(),
    },
  });

  switch (input.eventType) {
    case 'booking.confirmed':
    case 'booking.payment_recorded':
      if (AWAITING_PAYMENT.has(booking.status)) {
        return { kind: 'skip', reason: 'awaiting_payment' };
      }
      if (!CONFIRMED.has(booking.status)) {
        // Cancelled, or gone some other way, before it could be told.
        return { kind: 'skip', reason: `booking_${booking.status}` };
      }
      // Keyed on the booking, not the event: the create and the payment
      // both lead here, and the customer hears it once.
      return send('booking.confirmed', `booking.confirmed:${booking.id}`);
    case 'booking.rescheduled':
      // A booking moves many times; each move is its own notification.
      return send(
        'booking.rescheduled',
        `booking.rescheduled:${input.sourceEventId}`,
      );
    case 'booking.cancelled':
      return send('booking.cancelled', `booking.cancelled:${booking.id}`);
    case 'reminder.chosen':
      // The reminder rules reminders.ts gives the fixed rungs: only about a
      // visit still coming, at the time it was claimed for. A moved booking
      // has its stamp cleared and gets its own.
      if (
        !(REMINDER_LIVE_STATUSES as readonly string[]).includes(booking.status)
      ) {
        return { kind: 'skip', reason: `booking_${booking.status}` };
      }
      if (booking.startAtMs !== input.scheduledForMs) {
        return { kind: 'skip', reason: 'moved' };
      }
      return send(
        'booking.reminder',
        `booking.reminder:${booking.id}:${booking.startAtMs}`,
      );
    default:
      return { kind: 'skip', reason: 'not_a_hub_event' };
  }
}

/**
 * A desk's answer to a check-in, as a hand-over. Its words are the ones the
 * check-in push has always used (check-in-push.ts), passed along as `title`
 * and `body`: they name a party member, which only this service knows how
 * to find. Keyed on the request and the answer, as that push was.
 */
export function checkInNotice(input: {
  readonly answer: CheckInAnswer;
  readonly requestId: string;
  /** Whoever tapped: the booker for a party, else the customer. */
  readonly to: string;
  /** Their own booking, or a member of their party. */
  readonly self: boolean;
  readonly memberName: string | null;
  readonly booking: HubBooking;
  readonly groupId: string | null;
  readonly expiresAtMs: number;
}): HubNotice {
  const { booking } = input;
  const copy = checkInPushCopy({
    answer: input.answer,
    code: booking.code,
    subject: input.self
      ? { kind: 'self' }
      : { kind: 'member', name: input.memberName },
  });
  return {
    consumerId: input.to,
    type: `check_in.${input.answer}`,
    dedupeKey: `check_in:${input.requestId}:${input.answer}`,
    params: {
      booking_id: booking.id,
      booking_code: booking.code,
      branch_id: booking.branchId,
      start_at: new Date(booking.startAtMs).toISOString(),
      request_id: input.requestId,
      ...(input.groupId === null ? {} : { group_id: input.groupId }),
      title: copy.title,
      body: copy.body,
    },
    targetType: 'booking',
    targetId: booking.id,
    deliverBy: new Date(input.expiresAtMs).toISOString(),
  };
}

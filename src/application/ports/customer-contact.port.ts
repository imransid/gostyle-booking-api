/**
 * How to reach a customer, asked of the service that owns the answer.
 *
 * customer-api holds the email address, the name and the notification
 * preferences; this service holds none of them and copies none of them. A
 * stored copy would be one more thing to fall out of date the day a
 * customer changes their address or turns reminders off. So it is asked at
 * send time, over gRPC (ConsumerDirectory.GetConsumerContact).
 *
 * Separate from CUSTOMER_CONTEXT on purpose: that one answers "what does
 * this booking cost and may it be held", this one "where does a message go".
 */
export interface CustomerContact {
  readonly customerId: string;
  /** Null when the customer registered without one. */
  readonly email: string | null;
  /** Only a verified address is written to: a typo is somebody else's inbox. */
  readonly emailVerified: boolean;
  /** As customer-api holds it; may be empty. */
  readonly fullName: string | null;
  /** NotificationPreference.appointment_reminder. */
  readonly appointmentReminder: boolean;
  /** NotificationPreference.push, the master switch for push. */
  readonly pushEnabled: boolean;
}

export type ContactLookup =
  | { readonly kind: 'found'; readonly contact: CustomerContact }
  /** No such customer: a walk-in, a guest lane, a deleted account. */
  | { readonly kind: 'not_found' }
  /**
   * NO ANSWER, which is not "no". customer-api down, slow, or not yet
   * deployed with the call. Worth asking again later, so an email waiting on
   * it retries rather than failing.
   */
  | { readonly kind: 'unavailable'; readonly error: string };

export interface CustomerContactReader {
  lookup(customerId: string): Promise<ContactLookup>;
}

export const CUSTOMER_CONTACT = Symbol('CUSTOMER_CONTACT');

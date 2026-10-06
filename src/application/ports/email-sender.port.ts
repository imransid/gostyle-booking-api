import type { ChannelOutcome } from '@domain/booking/reminder-delivery';

export interface EmailMessage {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

/**
 * One email. The outcome is classified at the adapter:
 *
 *   sent     the server accepted it, ref = its message id
 *   skipped  email_not_configured (no SMTP_HOST)
 *   failed   a permanent refusal: 5xx, a rejected address, bad credentials
 *   retry    a 4xx, a timeout, a connection that never happened
 *
 * SMTP has no idempotency key. The delivery row is the fence against a
 * second send; the one window it cannot close is a worker killed between
 * the server accepting the message and the row recording it.
 */
export interface EmailSender {
  /**
   * Whether email is set up at all. Asked before anything else, so a
   * deployment without SMTP skips its email rows at once instead of asking
   * customer-api for an address it can never use.
   */
  configured(): boolean;
  send(message: EmailMessage): Promise<ChannelOutcome>;
}

export const EMAIL_SENDER = Symbol('EMAIL_SENDER');

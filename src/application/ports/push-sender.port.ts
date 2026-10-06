import type { ChannelOutcome } from '@domain/booking/reminder-delivery';

/**
 * One push to one customer, through push-app.
 *
 * `eventId` is push-app's idempotency key: it sends at most once per
 * (user, eventId, device), so a retry with the same id cannot buzz a phone
 * twice. The caller makes it stable per reminder (reminder-delivery.ts
 * `pushEventId`).
 */
export interface PushRequest {
  readonly userId: string;
  readonly eventId: string;
  readonly title: string;
  readonly body: string;
  readonly data: Record<string, string>;
}

/**
 * The outcome is classified at the adapter, which is the only place that
 * knows what an HTTP 401 or a 202 with zero devices means:
 *
 *   sent     push-app accepted and queued it, ref = how many devices
 *   skipped  no_devices, or push_not_configured (no PUSH_API_KEY)
 *   failed   4xx: the request itself is wrong; sending it again will not help
 *   retry    5xx, timeout, connection refused
 */
export interface PushSender {
  /** Whether push-app can be called at all (PUSH_API_KEY). */
  configured(): boolean;
  send(request: PushRequest): Promise<ChannelOutcome>;
}

export const PUSH_SENDER = Symbol('PUSH_SENDER');

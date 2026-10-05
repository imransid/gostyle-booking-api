import { Injectable, Logger } from '@nestjs/common';

export interface PushMessage {
  readonly userId: string;
  readonly eventId: string;
  readonly title: string;
  readonly body: string;
  readonly data: Record<string, string>;
}

const TIMEOUT_MS = 3_000;
const ATTEMPTS = 3;

/**
 * Talks to the push notification service (push-app on gostyle-net).
 *
 * NEVER THROWS. A push is best-effort; the booking event it rides on is not.
 * Returns true when the push service accepted the request.
 *
 * Safe to call twice for the same eventId: the push service keeps
 * (user, event, device) unique, so a retry cannot send a second push.
 */
@Injectable()
export class PushNotificationClient {
  private static readonly log = new Logger(PushNotificationClient.name);
  private readonly url = (
    process.env.PUSH_API_URL ?? 'http://push-app:3351'
  ).replace(/\/$/, '');
  private readonly key = process.env.PUSH_API_KEY ?? '';

  async send(message: PushMessage): Promise<boolean> {
    if (this.key === '') {
      PushNotificationClient.log.warn(
        `PUSH_API_KEY is not set; skipped ${message.eventId}`,
      );
      return false;
    }

    let lastError = '';
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      try {
        const res = await fetch(`${this.url}/notifications/user`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': this.key,
          },
          body: JSON.stringify(message),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (res.ok) return true;

        // 4xx: the request itself is wrong. Sending it again will not fix it.
        if (res.status < 500) {
          PushNotificationClient.log.error(
            `push refused ${message.eventId}: HTTP ${res.status}`,
          );
          return false;
        }
        lastError = `HTTP ${res.status}`;
      } catch (e) {
        // Timeout or connection refused: worth another try.
        lastError = e instanceof Error ? e.message : String(e);
      }
      if (attempt < ATTEMPTS) await sleep(attempt * 500);
    }

    PushNotificationClient.log.error(
      `push service unreachable for ${message.eventId} after ${ATTEMPTS} tries: ${lastError}`,
    );
    return false;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

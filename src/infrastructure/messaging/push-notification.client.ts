import { Injectable, Logger } from '@nestjs/common';
import type { ChannelOutcome } from '@domain/booking/reminder-delivery';
import type {
  PushRequest,
  PushSender,
} from '@application/ports/push-sender.port';

export type PushMessage = PushRequest;

const TIMEOUT_MS = 3_000;
const ATTEMPTS = 3;

/** What push-app answers a 202 with (send-user-notification.handler.ts). */
interface AcceptedBody {
  readonly devices?: unknown;
}

/**
 * Talks to the push notification service (push-app on gostyle-net).
 *
 * NEVER THROWS. A push is best-effort; the booking event it rides on is not.
 * Returns what happened, classified, so a caller that retries knows whether
 * trying again could help:
 *
 *   sent     202, queued for N devices
 *   skipped  202 for a user with NO devices (push-app answers 202, not 404,
 *            and records nothing), or PUSH_API_KEY unset
 *   failed   4xx: the request itself is wrong
 *   retry    5xx, timeout, connection refused, after `attempts` tries
 *
 * Safe to call twice for the same eventId: the push service keeps
 * (user, event, device) unique, so a retry cannot send a second push.
 */
@Injectable()
export class PushNotificationClient implements PushSender {
  private static readonly log = new Logger(PushNotificationClient.name);
  private readonly url = (
    process.env.PUSH_API_URL ?? 'http://push-app:3351'
  ).replace(/\/$/, '');
  private readonly key = process.env.PUSH_API_KEY ?? '';

  /**
   * `attempts` defaults to three quick tries, for a caller with no retry of
   * its own (PushListener). The reminder dispatcher passes 1: it retries with
   * backoff across claims, and three in-line tries per row would hold a whole
   * batch behind a push-app outage.
   */
  configured(): boolean {
    return this.key !== '';
  }

  async send(
    message: PushMessage,
    attempts: number = ATTEMPTS,
  ): Promise<ChannelOutcome> {
    if (this.key === '') {
      PushNotificationClient.log.warn(
        `PUSH_API_KEY is not set; skipped ${message.eventId}`,
      );
      return { kind: 'skipped', reason: 'push_not_configured' };
    }

    let lastError = '';
    for (let attempt = 1; attempt <= attempts; attempt++) {
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
        if (res.ok) return accepted(await readJson(res));

        // 4xx: the request itself is wrong. Sending it again will not fix it.
        if (res.status < 500) {
          PushNotificationClient.log.error(
            `push refused ${message.eventId}: HTTP ${res.status}`,
          );
          return { kind: 'failed', error: `HTTP ${res.status}` };
        }
        lastError = `HTTP ${res.status}`;
      } catch (e) {
        // Timeout or connection refused: worth another try.
        lastError = e instanceof Error ? e.message : String(e);
      }
      if (attempt < attempts) await sleep(attempt * 500);
    }

    PushNotificationClient.log.error(
      `push service unreachable for ${message.eventId} after ${attempts} tries: ${lastError}`,
    );
    return { kind: 'retry', error: `push-app unreachable: ${lastError}` };
  }
}

/**
 * 202 with zero devices is push-app saying "nobody to send to", and it keeps
 * no record of the attempt. That is not a delivery, so it is not reported as
 * one. A body we cannot read is still a 2xx: push-app took it.
 */
function accepted(body: AcceptedBody | null): ChannelOutcome {
  const devices = typeof body?.devices === 'number' ? body.devices : null;
  if (devices === 0) return { kind: 'skipped', reason: 'no_devices' };
  return { kind: 'sent', ref: devices === null ? null : `devices=${devices}` };
}

async function readJson(res: Response): Promise<AcceptedBody | null> {
  try {
    return (await res.json()) as AcceptedBody;
  } catch {
    return null;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

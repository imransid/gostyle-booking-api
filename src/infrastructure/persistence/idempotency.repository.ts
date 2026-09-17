import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PrismaService } from './prisma.service';
import { bookingError } from '@application/contract/errors';

/**
 * Idempotency for every route that must not happen twice.
 *
 * WHY THIS EXISTS RATHER THAN A SECOND COPY. `POST /v1/bookings` has replayed
 * correctly since confirm was written, and the mechanism lived inside that
 * one handler. `POST /v1/series` did not, so a retried series create made a
 * SECOND SERIES -- a standing weekly appointment duplicated for a year,
 * discovered by the customer. The fix is not a second implementation beside
 * the first; it is this, which both can call (CLAUDE.md 4).
 *
 * TWO GUARANTEES:
 *
 *   SAME KEY, SAME BODY   -> the stored response, with `replayed: true`.
 *                            Nothing runs a second time.
 *   SAME KEY, OTHER BODY  -> 409 IDEMPOTENCY_KEY_REUSED. A client reusing a
 *                            key for a different request has a bug, and
 *                            answering the first response would hide it.
 *
 * The request hash is what tells those apart, which is why `remember` takes
 * one and will not compute it for you from something vague.
 */

/** How long a key is honoured. Long enough for any retry, short enough to prune. */
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class IdempotencyRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Has this exact request already been answered?
   *
   * Returns null when the key is new. Throws when the key is known but the
   * body differs, because that is a caller bug rather than a retry.
   */
  async replay<T>(
    key: string,
    operation: string,
    requestHash: string,
  ): Promise<T | null> {
    const row = await this.prisma.idempotencyKey.findUnique({ where: { key } });
    if (row === null) return null;

    if (row.requestHash !== requestHash) {
      throw bookingError(
        'IDEMPOTENCY_KEY_REUSED',
        'That Idempotency-Key was already used for a different request.',
        { key, operation: row.operation },
      );
    }
    if (row.responseBody === null) return null;

    return { ...(row.responseBody as object), replayed: true } as T;
  }

  /** Record what was returned, so the next retry is answered from it. */
  async remember(input: {
    readonly key: string;
    readonly operation: string;
    readonly requestHash: string;
    readonly status: number;
    readonly body: unknown;
    readonly bookingId?: string | null;
  }): Promise<void> {
    await this.prisma.idempotencyKey.create({
      data: {
        key: input.key,
        operation: input.operation,
        requestHash: input.requestHash,
        responseStatus: input.status,
        responseBody: input.body as never,
        bookingId: input.bookingId ?? null,
        expiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_MS),
      },
    });
  }
}

/**
 * A stable fingerprint of whatever identifies this request.
 *
 * KEYS ARE SORTED, so two callers that serialise the same object in a
 * different field order are recognised as the same request. Without it a
 * retry from a different client build looks like a key collision and is
 * refused with 409 -- the exact opposite of what idempotency is for.
 */
export function hashRequestBody(value: unknown): string {
  return createHash('sha256').update(stable(value)).digest('hex');
}

function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(',')}}`;
}

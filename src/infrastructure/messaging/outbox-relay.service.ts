import { Inject, Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { PrismaService } from '../persistence/prisma.service';
import {
  EVENT_PUBLISHER,
  type DomainEvent,
  type EventPublisher,
} from '@application/ports/event-publisher.port';

export const RELAY_INTERVAL_MS = 1_000;
export const RELAY_BATCH_SIZE = 50;
/** After this many failures an event stops being retried and needs a human. */
export const MAX_ATTEMPTS = 10;

/** What the stats aggregate returns. Named, so no angle bracket ever
 *  ends a line and gets swallowed by a shell or moved by a formatter. */
interface OutboxStatsRow {
  readonly pending: bigint;
  readonly stuck: bigint;
  readonly oldest: Date | null;
}

interface OutboxRow {
  readonly id: string;
  readonly aggregate_type: string;
  readonly aggregate_id: string;
  readonly event_type: string;
  readonly payload: unknown;
  readonly created_at: Date;
  readonly attempts: number;
}

/**
 * Reads what the confirm transaction wrote and makes it happen.
 *
 * The outbox exists because a booking and its side effects cannot be written
 * atomically across two systems. Postgres commits the booking AND the event
 * together; this relay then moves the event out, at its own pace, retrying
 * until it lands.
 *
 * The result is at-least-once delivery. Never zero, occasionally twice, which
 * is why every consumer must be idempotent.
 */
@Injectable()
export class OutboxRelay {
  private static readonly log = new Logger(OutboxRelay.name);
  private running = false;
  /**
   * A database outage produces one identical error per second, forever,
   * burying anything useful. Log the first, then back off.
   */
  private consecutiveFailures = 0;
  private publishedTotal = 0;
  private failedTotal = 0;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(EVENT_PUBLISHER) private readonly publisher: EventPublisher,
  ) {}

  @Interval('outbox-relay', RELAY_INTERVAL_MS)
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.drain();
      this.consecutiveFailures = 0;
    } catch (e) {
      this.consecutiveFailures += 1;
      // First failure, then every thirtieth. Enough to see it started and
      // that it is still going, without 300 lines per five-minute outage.
      if (
        this.consecutiveFailures === 1 ||
        this.consecutiveFailures % 30 === 0
      ) {
        OutboxRelay.log.error(
          `Relay tick failed (${this.consecutiveFailures}x): ` +
            `${e instanceof Error ? e.message : String(e)}`,
        );
      }
      return;
    } finally {
      this.running = false;
    }
  }

  /** Publish one batch. Returns how many were delivered. */
  async drain(): Promise<number> {
    return this.prisma.$transaction(async (tx) => {
      // THE LINE THAT MAKES THIS SAFE WITH SEVERAL REPLICAS.
      //
      // SKIP LOCKED walks past rows another worker is already holding, so two
      // relays claim disjoint batches. Plain FOR UPDATE would make the second
      // worker WAIT and then hand it the same rows, and every customer would
      // get two reminders.
      const rows = await tx.$queryRaw<OutboxRow[]>`
        SELECT id, aggregate_type, aggregate_id, event_type, payload,
               created_at, attempts
          FROM event_outbox
         WHERE published_at IS NULL
           AND attempts < ${MAX_ATTEMPTS}
         ORDER BY created_at
         LIMIT ${RELAY_BATCH_SIZE}
         FOR UPDATE SKIP LOCKED`;

      let delivered = 0;

      for (const row of rows) {
        const event: DomainEvent = {
          id: row.id,
          aggregateType: row.aggregate_type,
          aggregateId: row.aggregate_id,
          eventType: row.event_type,
          payload: row.payload,
          createdAt: row.created_at,
          attempts: row.attempts,
        };

        try {
          await this.publisher.publish(event);
          await tx.eventOutbox.update({
            where: { id: row.id },
            data: { publishedAt: new Date(), lastError: null },
          });
          delivered += 1;
          this.publishedTotal += 1;
        } catch (e) {
          // One bad event must not stop the batch. Count the attempt, record
          // why, and move on; the next tick picks it up again.
          const message =
            e instanceof Error ? e.message.slice(0, 500) : String(e);
          await tx.eventOutbox.update({
            where: { id: row.id },
            data: { attempts: { increment: 1 }, lastError: message },
          });
          this.failedTotal += 1;
          OutboxRelay.log.warn(
            `${row.event_type} attempt ${row.attempts + 1} failed: ${message}`,
          );
        }
      }

      if (delivered > 0) {
        OutboxRelay.log.log(`Published ${delivered} event(s)`);
      }
      return delivered;
    });
  }

  /**
   * Queue depth, for the health endpoint.
   *
   * `oldestUnpublishedSeconds` is the number that actually matters: a backlog
   * of thousands is fine if it is draining, and a backlog of one is an
   * emergency if it has been stuck for an hour.
   */
  async stats(): Promise<{
    pending: number;
    stuck: number;
    oldestUnpublishedSeconds: number | null;
    publishedTotal: number;
    failedTotal: number;
  }> {
    const rows = await this.prisma.$queryRaw<OutboxStatsRow[]>`
      SELECT count(*) FILTER (WHERE attempts < ${MAX_ATTEMPTS}) AS pending,
             count(*) FILTER (WHERE attempts >= ${MAX_ATTEMPTS}) AS stuck,
             min(created_at) AS oldest
        FROM event_outbox
       WHERE published_at IS NULL`;

    const r = rows[0];
    const oldest = r?.oldest ?? null;

    return {
      pending: Number(r?.pending ?? 0),
      stuck: Number(r?.stuck ?? 0),
      oldestUnpublishedSeconds:
        oldest === null
          ? null
          : Math.round((Date.now() - oldest.getTime()) / 1000),
      publishedTotal: this.publishedTotal,
      failedTotal: this.failedTotal,
    };
  }
}

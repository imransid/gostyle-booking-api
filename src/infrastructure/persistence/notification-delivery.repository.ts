import { Injectable } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import {
  DISPATCH_LEASE_MS,
  type Settlement,
} from '@domain/booking/reminder-delivery';
import type { ReminderChannel } from '@domain/booking/reminders';

/** One delivery to create, from one reminder event and one channel. */
export interface NewDelivery {
  readonly sourceEventId: string;
  readonly channel: ReminderChannel;
  readonly eventType: string;
  readonly bookingId: string;
  readonly customerId: string;
  readonly scheduledFor: Date;
  readonly expiresAt: Date;
  readonly nextAttemptAt: Date;
}

/** A delivery this worker holds, for one attempt. */
export interface ClaimedDelivery {
  readonly id: string;
  readonly sourceEventId: string;
  readonly channel: ReminderChannel;
  readonly eventType: string;
  readonly bookingId: string;
  readonly customerId: string;
  readonly scheduledForMs: number;
  readonly expiresAtMs: number;
  /** This attempt's number, counting from 1. The write-back is keyed on it. */
  readonly attempt: number;
}

/** What a reminder needs to know about its booking at send time. */
export interface DeliveryBooking {
  readonly id: string;
  readonly status: string;
  readonly startAtMs: number;
  readonly code: string;
  readonly customerId: string;
  readonly paymentStatus: string;
  readonly durationMin: number;
  readonly services: readonly string[];
}

export interface DeliveryQueueStats {
  /** Every delivery not yet settled, including ones waiting for later. */
  readonly pending: number;
  /** Of those, due now. */
  readonly due: number;
  /** How long the oldest due one has waited. The number to alert on. */
  readonly oldestDueSeconds: number | null;
}

/** Named, so no angle bracket ends a line and gets swallowed by a heredoc. */
interface ClaimRow {
  readonly id: string;
  readonly source_event_id: string;
  readonly channel: ReminderChannel;
  readonly event_type: string;
  readonly booking_id: string;
  readonly customer_id: string;
  readonly scheduled_for: Date;
  readonly expires_at: Date;
  readonly attempts: number;
}

interface StatsRow {
  readonly pending: number;
  readonly due: number;
  readonly oldest_due: Date | null;
}

/**
 * notification_delivery: rows in, rows out. Nothing here sends anything or
 * asks any other service a question (CLAUDE.md 7); the dispatcher does that
 * and hands back what happened.
 */
@Injectable()
export class NotificationDeliveryRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Create a reminder's deliveries, or find them already there.
   *
   * ON CONFLICT DO NOTHING against UNIQUE (source_event_id, channel). The
   * outbox delivers at least once, so the same reminder event can arrive
   * twice; the second arrival creates nothing. Returns how many were new.
   */
  async enqueue(rows: readonly NewDelivery[]): Promise<number> {
    if (rows.length === 0) return 0;
    const out = await this.prisma.notificationDelivery.createMany({
      data: rows.map((r) => ({ ...r })),
      skipDuplicates: true,
    });
    return out.count;
  }

  /**
   * Take up to `limit` due deliveries for one attempt each.
   *
   * THE SAME SHAPE AS THE LADDER'S CLAIM: one UPDATE ... WHERE id IN (SELECT
   * ... FOR UPDATE SKIP LOCKED) RETURNING. Two replicas dispatching at once
   * get disjoint rows, so no reminder is sent by both.
   *
   * THE LEASE. A claim does not mark a row "in progress"; it moves its
   * next_attempt_at out by DISPATCH_LEASE_MS and counts the attempt. A worker
   * that finishes records the result. A worker that is killed mid-send never
   * does, and the row simply comes due again when the lease runs out -- no
   * stuck state, no reaper, and the attempt it burned still counts toward the
   * retry budget.
   */
  async claimDue(nowMs: number, limit: number): Promise<ClaimedDelivery[]> {
    const rows = await this.prisma.$queryRaw<ClaimRow[]>`
      UPDATE notification_delivery
         SET attempts = attempts + 1,
             next_attempt_at = ${new Date(nowMs + DISPATCH_LEASE_MS)},
             updated_at = now()
       WHERE id IN (
         SELECT id FROM notification_delivery
          WHERE status = 'pending'
            AND next_attempt_at <= ${new Date(nowMs)}
          ORDER BY next_attempt_at
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED
       )
      RETURNING id, source_event_id, channel::text AS channel, event_type,
                booking_id, customer_id, scheduled_for, expires_at, attempts`;

    return rows.map((r) => ({
      id: r.id,
      sourceEventId: r.source_event_id,
      channel: r.channel,
      eventType: r.event_type,
      bookingId: r.booking_id,
      customerId: r.customer_id,
      scheduledForMs: r.scheduled_for.getTime(),
      expiresAtMs: r.expires_at.getTime(),
      attempt: r.attempts,
    }));
  }

  /** The bookings behind a batch, read once for all of it. */
  async bookings(
    ids: readonly string[],
  ): Promise<Map<string, DeliveryBooking>> {
    if (ids.length === 0) return new Map();
    const rows = await this.prisma.booking.findMany({
      where: { id: { in: [...ids] } },
      select: {
        id: true,
        status: true,
        startAt: true,
        code: true,
        customerId: true,
        paymentStatus: true,
        durationMin: true,
        items: { select: { serviceName: true }, orderBy: { position: 'asc' } },
      },
    });
    return new Map(
      rows.map((b) => [
        b.id,
        {
          id: b.id,
          status: b.status,
          startAtMs: b.startAt.getTime(),
          code: b.code,
          customerId: b.customerId,
          paymentStatus: b.paymentStatus,
          durationMin: b.durationMin,
          services: b.items.map((i) => i.serviceName),
        },
      ]),
    );
  }

  /**
   * Write back what one attempt came to.
   *
   * ONLY THE CURRENT CLAIMANT MAY. The WHERE names the attempt number this
   * worker was handed: if its lease ran out and another worker has since
   * claimed the row (attempt + 1), or settled it, this updates nothing and
   * returns false. A slow worker can never overwrite a newer result, so a
   * kill -9, a pause or a network stall leaves the row either as the last
   * finished attempt wrote it, or due again.
   */
  async record(
    claim: Pick<ClaimedDelivery, 'id' | 'attempt'>,
    outcome: Settlement | { readonly status: 'superseded' },
    nowMs: number,
  ): Promise<boolean> {
    const out = await this.prisma.notificationDelivery.updateMany({
      where: { id: claim.id, status: 'pending', attempts: claim.attempt },
      data: dataFor(outcome, nowMs),
    });
    return out.count === 1;
  }

  /**
   * Queue depth for /health. Reads the partial index only, so polling it
   * every few seconds costs the same whether ten or ten million reminders
   * have ever been sent.
   */
  async stats(nowMs: number = Date.now()): Promise<DeliveryQueueStats> {
    const rows = await this.prisma.$queryRaw<StatsRow[]>`
      SELECT count(*)::int AS pending,
             (count(*) FILTER (WHERE next_attempt_at <= ${new Date(nowMs)}))::int AS due,
             min(next_attempt_at) FILTER (WHERE next_attempt_at <= ${new Date(nowMs)}) AS oldest_due
        FROM notification_delivery
       WHERE status = 'pending'`;
    const r = rows[0];
    return {
      pending: r?.pending ?? 0,
      due: r?.due ?? 0,
      oldestDueSeconds:
        r?.oldest_due == null
          ? null
          : Math.max(0, Math.round((nowMs - r.oldest_due.getTime()) / 1000)),
    };
  }
}

function dataFor(
  outcome: Settlement | { readonly status: 'superseded' },
  nowMs: number,
) {
  switch (outcome.status) {
    case 'sent':
      return {
        status: 'sent' as const,
        sentAt: new Date(nowMs),
        providerRef: outcome.ref,
        lastError: null,
      };
    case 'pending':
      return {
        nextAttemptAt: new Date(outcome.nextAttemptAtMs),
        lastError: outcome.error.slice(0, 500),
      };
    case 'failed':
      return {
        status: 'failed' as const,
        lastError: outcome.error.slice(0, 500),
      };
    case 'skipped':
      return { status: 'skipped' as const, skipReason: outcome.reason };
    case 'superseded':
      return { status: 'superseded' as const };
  }
}

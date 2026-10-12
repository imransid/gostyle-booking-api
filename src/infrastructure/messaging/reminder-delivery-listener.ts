import { Logger } from '@nestjs/common';
import type {
  DomainEvent,
  EventPublisher,
} from '@application/ports/event-publisher.port';
import { planDeliveries, rungOfEvent } from '@domain/booking/reminder-delivery';
import type { Rung } from '@domain/booking/reminders';
import type { NotificationDeliveryRepository } from '../persistence/notification-delivery.repository';

/**
 * Reminder delivery, on or off.
 *
 * OFF BY DEFAULT. `REMINDER_DELIVERY=true` turns it on. Off, a reminder event
 * goes down the chain exactly as before and nothing is sent, which is what
 * production does today. Read on every event, like the other flags, so a
 * restart is all a deploy needs.
 */
export const REMINDER_DELIVERY = (): boolean =>
  (process.env.REMINDER_DELIVERY ?? '').trim().toLowerCase() === 'true';

/** The fields a reminder event's payload is read for. */
interface ReminderPayload {
  readonly startAt?: unknown;
  readonly customerId?: unknown;
  readonly manual?: unknown;
  readonly queuedUntil?: unknown;
}

/**
 * One link in the outbox chain: turns a reminder.<rung> event into one
 * notification_delivery row per channel. It sends nothing.
 *
 * NO NETWORK CALL HAPPENS HERE, on purpose. This runs inside the relay's
 * transaction, which has Prisma's five-second budget and holds its batch's
 * rows locked; a slow push-app or SMTP server in here would stall every
 * event behind it. The dispatcher does the sending, outside any transaction.
 *
 * THE ONE LINK THAT THROWS. Every other link swallows its failures because a
 * throw re-delivers the event to all of them. For a reminder event that is
 * harmless -- the waitlist, walk-in and push links ignore it, and the group
 * link only re-derives a status -- and swallowing would lose the reminder.
 * So a failed insert throws, the relay counts the attempt and tries again,
 * and the unique (source_event_id, channel) makes the retry idempotent.
 */
export class ReminderDeliveryListener implements EventPublisher {
  private static readonly log = new Logger(ReminderDeliveryListener.name);

  constructor(
    private readonly next: EventPublisher,
    private readonly deliveries: NotificationDeliveryRepository,
    private readonly now: () => number = Date.now,
  ) {}

  async publish(event: DomainEvent): Promise<void> {
    const rung = rungOfEvent(event.eventType);
    if (rung !== null && REMINDER_DELIVERY()) {
      await this.enqueue(event, rung);
    }
    await this.next.publish(event);
  }

  private async enqueue(event: DomainEvent, rung: Rung): Promise<void> {
    const p = (event.payload ?? {}) as ReminderPayload;
    const startAtMs =
      typeof p.startAt === 'string' ? Date.parse(p.startAt) : NaN;
    const customerId = typeof p.customerId === 'string' ? p.customerId : '';

    if (Number.isNaN(startAtMs) || customerId === '') {
      // Retrying cannot add a field the event was written without, so this
      // is logged, not thrown. Every producer writes both (the ladder, the
      // desk's manual reminder); this line is for the one that forgets.
      ReminderDeliveryListener.log.error(
        `${event.eventType} ${event.id} carries no startAt or customerId; ` +
          'no delivery created',
      );
      return;
    }

    const queuedUntilMs =
      typeof p.queuedUntil === 'string' ? Date.parse(p.queuedUntil) : NaN;

    const planned = planDeliveries({
      rung,
      startAtMs,
      nowMs: this.now(),
      manual: p.manual === true,
      queuedUntilMs: Number.isNaN(queuedUntilMs) ? null : queuedUntilMs,
    });

    try {
      const created = await this.deliveries.enqueue(
        planned.map((d) => ({
          sourceEventId: event.id,
          channel: d.channel,
          eventType: event.eventType,
          bookingId: event.aggregateId,
          customerId,
          scheduledFor: new Date(d.scheduledForMs),
          expiresAt: new Date(d.expiresAtMs),
          nextAttemptAt: new Date(d.notBeforeMs),
        })),
      );
      if (created > 0) {
        ReminderDeliveryListener.log.log(
          `${event.eventType} ${event.aggregateId.slice(0, 8)}: ` +
            `${created} delivery(ies) queued (${planned.map((d) => d.channel).join(', ')})`,
        );
      }
    } catch (e) {
      ReminderDeliveryListener.log.error(
        `${event.eventType} ${event.id}: could not queue deliveries, the relay ` +
          `will retry: ${e instanceof Error ? e.message : String(e)}`,
      );
      throw e;
    }
  }
}

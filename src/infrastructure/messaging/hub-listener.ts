import type {
  DomainEvent,
  EventPublisher,
} from '@application/ports/event-publisher.port';
import { HUB_EVENTS } from '@domain/booking/hub-notification';
import { PrismaService } from '../persistence/prisma.service';
import { NotificationDeliveryRepository } from '../persistence/notification-delivery.repository';
import { MOBILE_NOTIFY_HUB } from './notify-hub.flag';

/**
 * How long a hand-over may keep trying. Past this, "your booking is
 * confirmed" is old news, and the row gives up.
 */
export const HUB_DELIVER_WITHIN_MS = 24 * 60 * 60 * 1000;

/**
 * One link in the outbox chain: turns a customer-facing booking event into
 * one notification_delivery row on channel `hub` (MOBILE_NOTIFY_HUB). The
 * dispatcher hands it to customer-api later, with the lease, retries and
 * fence every reminder row has.
 *
 * NO NETWORK HERE. The chain runs inside the relay's transaction; asking
 * another service from in here is what PushListener does, and what this
 * link replaces for these events.
 *
 * It THROWS when the row cannot be written, like ReminderDeliveryListener,
 * so the relay delivers the event again: a lost "your booking is
 * cancelled" is worse than a re-delivered event, and every link outside
 * this one is idempotent. The row itself is: UNIQUE (source_event_id,
 * channel), so a second delivery writes nothing.
 */
export class HubListener implements EventPublisher {
  constructor(
    private readonly next: EventPublisher,
    private readonly prisma: PrismaService,
    private readonly deliveries: NotificationDeliveryRepository,
  ) {}

  async publish(event: DomainEvent): Promise<void> {
    if (MOBILE_NOTIFY_HUB() && HUB_EVENTS.has(event.eventType)) {
      await this.enqueue(event);
    }
    await this.next.publish(event);
  }

  private async enqueue(event: DomainEvent): Promise<void> {
    const booking = await this.prisma.booking.findUnique({
      where: { id: event.aggregateId },
      select: { customerId: true, startAt: true },
    });
    if (booking === null) return;

    const nowMs = Date.now();
    // A reminder is about the start it was claimed FOR (its payload), not
    // whatever the booking says a second later: a move in between must read
    // as moved at send time. It is noise after that start; everything else
    // may keep trying for a day.
    const reminderStart = claimedStart(event);
    const scheduledFor = reminderStart ?? booking.startAt;
    const expiresAt =
      reminderStart !== null
        ? reminderStart
        : new Date(nowMs + HUB_DELIVER_WITHIN_MS);
    await this.deliveries.enqueue([
      {
        sourceEventId: event.id,
        channel: 'hub',
        eventType: event.eventType,
        bookingId: event.aggregateId,
        customerId: booking.customerId,
        scheduledFor,
        expiresAt,
        nextAttemptAt: new Date(nowMs),
      },
    ]);
  }
}

/** reminder.chosen's payload startAt, or null for any other event. */
function claimedStart(event: DomainEvent): Date | null {
  if (event.eventType !== 'reminder.chosen') return null;
  const raw = (event.payload as { startAt?: unknown } | null)?.startAt;
  const ms = typeof raw === 'string' ? Date.parse(raw) : NaN;
  return Number.isNaN(ms) ? null : new Date(ms);
}

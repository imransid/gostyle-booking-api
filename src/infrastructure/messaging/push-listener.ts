import { Logger } from '@nestjs/common';
import type {
  DomainEvent,
  EventPublisher,
} from '@application/ports/event-publisher.port';
import { PrismaService } from '../persistence/prisma.service';
import { PushNotificationClient } from './push-notification.client';

/** The booking events a customer hears about, and what they read. */
const MESSAGES = new Map<
  string,
  { title: string; body: (code: string) => string }
>([
  [
    'booking.confirmed',
    {
      title: 'Booking confirmed',
      body: (c) => `Your booking ${c} is confirmed.`,
    },
  ],
  [
    'booking.cancelled',
    {
      title: 'Booking cancelled',
      body: (c) => `Your booking ${c} was cancelled.`,
    },
  ],
  [
    'booking.rescheduled',
    {
      title: 'Booking moved',
      body: (c) => `Your booking ${c} has a new time.`,
    },
  ],
]);

/**
 * One link in the outbox chain: tells the customer about their booking.
 *
 * Best-effort, like the waitlist offer. It never throws, because a throw
 * would make the relay re-deliver the event to every other link too.
 */
export class PushListener implements EventPublisher {
  private static readonly log = new Logger(PushListener.name);

  constructor(
    private readonly next: EventPublisher,
    private readonly prisma: PrismaService,
    private readonly push: PushNotificationClient,
  ) {}

  async publish(event: DomainEvent): Promise<void> {
    const message = MESSAGES.get(event.eventType);
    if (message) {
      await this.tryPush(event, message);
    }
    // Whatever happened above, the event still goes where it was going.
    await this.next.publish(event);
  }

  private async tryPush(
    event: DomainEvent,
    message: { title: string; body: (code: string) => string },
  ): Promise<void> {
    try {
      const booking = await this.prisma.booking.findUnique({
        where: { id: event.aggregateId },
        select: { customerId: true, code: true },
      });
      if (!booking) return;

      await this.push.send({
        userId: booking.customerId,
        eventId: eventIdFor(event),
        title: message.title,
        body: message.body(booking.code),
        data: { type: event.eventType, bookingId: event.aggregateId },
      });
    } catch (e) {
      PushListener.log.error(
        `push for ${event.eventType} ${event.aggregateId} failed: ` +
          (e instanceof Error ? e.message : String(e)),
      );
    }
  }
}

/**
 * The push service sends at most once per eventId.
 *
 * Confirmed and cancelled happen once per booking, so the booking id is enough.
 * A booking can be moved many times, so each move adds its own outbox event id,
 * or the second move would be silently treated as a duplicate of the first.
 */
export function eventIdFor(event: DomainEvent): string {
  const status = event.eventType.slice('booking.'.length);
  const base = `booking:${event.aggregateId}:${status}`;
  return event.eventType === 'booking.rescheduled'
    ? `${base}:${event.id}`
    : base;
}

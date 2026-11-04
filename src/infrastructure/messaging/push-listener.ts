import { Logger } from '@nestjs/common';
import type {
  DomainEvent,
  EventPublisher,
} from '@application/ports/event-publisher.port';
import type {
  CustomerContact,
  CustomerContactReader,
} from '@application/ports/customer-contact.port';
import { PrismaService } from '../persistence/prisma.service';
import { PushNotificationClient } from './push-notification.client';
import { MOBILE_NOTIFY_HUB } from './notify-hub.flag';

/**
 * The customer's own switches, honoured or not.
 *
 * OFF BY DEFAULT. `MOBILE_PUSH_PREFS=true` makes this listener ask
 * customer-api before each push and stay quiet when the customer turned
 * push, "Booking confirmation" or "Booking changes" off. Off, every push goes
 * exactly as before. Read on every event, like the other flags.
 *
 * Turn it on only after customer-api answers booking_confirmation and
 * booking_changes; before that both read as on, so nothing breaks, but only
 * the push switch is honoured.
 */
export const MOBILE_PUSH_PREFS = (): boolean =>
  (process.env.MOBILE_PUSH_PREFS ?? '').trim().toLowerCase() === 'true';

/**
 * A preference lookup on this path waits at most this long, for the reason
 * the check-in push gives (CHECK_IN_PUSH_NAME_MS): the relay delivers events
 * one after another. No answer in time: the push goes, as it does today.
 */
export const PUSH_PREFS_LOOKUP_MS = 2_000;

interface Message {
  readonly title: string;
  readonly body: (code: string) => string;
  /** The customer-api switch that silences it (MOBILE_PUSH_PREFS). */
  readonly preference: keyof Pick<
    CustomerContact,
    'bookingConfirmation' | 'bookingChanges'
  >;
}

/** The booking events a customer hears about, and what they read. */
const MESSAGES = new Map<string, Message>([
  [
    'booking.confirmed',
    {
      title: 'Booking confirmed',
      body: (c) => `Your booking ${c} is confirmed.`,
      preference: 'bookingConfirmation',
    },
  ],
  [
    'booking.cancelled',
    {
      title: 'Booking cancelled',
      body: (c) => `Your booking ${c} was cancelled.`,
      preference: 'bookingChanges',
    },
  ],
  [
    'booking.rescheduled',
    {
      title: 'Booking moved',
      body: (c) => `Your booking ${c} has a new time.`,
      preference: 'bookingChanges',
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
    private readonly contacts: CustomerContactReader,
  ) {}

  async publish(event: DomainEvent): Promise<void> {
    const message = MESSAGES.get(event.eventType);
    // With MOBILE_NOTIFY_HUB on, customer-api's Notification Center tells
    // the customer (HubListener), so this one stays quiet: one push, not two.
    if (message && !MOBILE_NOTIFY_HUB()) {
      await this.tryPush(event, message);
    }
    // Whatever happened above, the event still goes where it was going.
    await this.next.publish(event);
  }

  private async tryPush(event: DomainEvent, message: Message): Promise<void> {
    try {
      const booking = await this.prisma.booking.findUnique({
        where: { id: event.aggregateId },
        select: { customerId: true, code: true },
      });
      if (!booking) return;
      if (
        MOBILE_PUSH_PREFS() &&
        !(await this.wanted(booking.customerId, message))
      ) {
        return;
      }

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

  /**
   * False only when customer-api says so: push off, or this message's own
   * switch off. Not found (a desk customer) and no answer both send, as
   * reminders do: push-app decides by the devices it holds.
   */
  private async wanted(customerId: string, message: Message): Promise<boolean> {
    const who = await this.contacts.lookup(customerId, {
      quickMs: PUSH_PREFS_LOOKUP_MS,
    });
    if (who.kind !== 'found') return true;
    return who.contact.pushEnabled && who.contact[message.preference];
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

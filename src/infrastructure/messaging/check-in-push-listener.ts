import { Logger } from '@nestjs/common';
import type {
  DomainEvent,
  EventPublisher,
} from '@application/ports/event-publisher.port';
import type { CustomerContactReader } from '@application/ports/customer-contact.port';
import type { PushSender } from '@application/ports/push-sender.port';
import {
  answerOfEvent,
  checkInPushCopy,
  checkInPushEventId,
  type CheckInAnswer,
  type CheckInPushSubject,
} from '@domain/booking/check-in-push';
import { PrismaService } from '../persistence/prisma.service';

/**
 * A name lookup on this path waits at most this long. The relay delivers
 * events one after another, so a slow customer-api must not hold the chain:
 * after this the push goes without the name ("A member of your party").
 */
export const CHECK_IN_PUSH_NAME_MS = 2_000;

/**
 * One link in the outbox chain: tells the customer the desk's answer to
 * their check-in request (CHECK_IN_PUSH_V1, written by the repository in the
 * answer's own transaction).
 *
 * TO WHOEVER TAPPED: the request's `raised_by_id`. A member who said "I am
 * here" hears about themselves; the booker who said "We are here" hears
 * about each member they asked for, guests included (a guest has no app),
 * one push per member, by name.
 *
 * Their push switch wins (customer-api's NotificationPreference.push). When
 * customer-api cannot be asked, the push goes at the default, as reminders
 * do: push-app decides by the devices it holds.
 *
 * Best effort, like PushListener: it never throws, because a throw would
 * make the relay re-deliver the event to every other link too. push-app's
 * eventId keeps a re-delivery from buzzing twice.
 */
export class CheckInPushListener implements EventPublisher {
  private static readonly log = new Logger(CheckInPushListener.name);

  constructor(
    private readonly next: EventPublisher,
    private readonly prisma: PrismaService,
    private readonly push: PushSender,
    private readonly contacts: CustomerContactReader,
  ) {}

  async publish(event: DomainEvent): Promise<void> {
    const answer = answerOfEvent(event.eventType);
    if (answer !== null) {
      await this.tryPush(event, answer);
    }
    // Whatever happened above, the event still goes where it was going.
    await this.next.publish(event);
  }

  private async tryPush(
    event: DomainEvent,
    answer: CheckInAnswer,
  ): Promise<void> {
    try {
      if (!this.push.configured()) return;

      const request = await this.prisma.checkInRequest.findUnique({
        where: { id: event.aggregateId },
        select: {
          id: true,
          raisedByKind: true,
          raisedById: true,
          booking: {
            select: { id: true, code: true, customerId: true, groupId: true },
          },
        },
      });
      // Only a customer taps; nobody else has an app to tell.
      if (request === null || request.raisedByKind !== 'customer') return;

      const to = request.raisedById;
      const who = await this.contacts.lookup(to, {
        quickMs: CHECK_IN_PUSH_NAME_MS,
      });
      if (who.kind === 'found' && !who.contact.pushEnabled) return;

      const subject: CheckInPushSubject =
        request.booking.customerId === to
          ? { kind: 'self' }
          : { kind: 'member', name: await this.nameOf(request.booking.id) };
      const copy = checkInPushCopy({
        answer,
        code: request.booking.code,
        subject,
      });

      const out = await this.push.send({
        userId: to,
        eventId: checkInPushEventId(request.id, answer),
        title: copy.title,
        body: copy.body,
        data: {
          type: event.eventType,
          bookingId: request.booking.id,
          code: request.booking.code,
          requestId: request.id,
          ...(request.booking.groupId === null
            ? {}
            : { groupId: request.booking.groupId }),
        },
      });
      if (out.kind === 'failed' || out.kind === 'retry') {
        CheckInPushListener.log.warn(
          `check-in push ${event.eventType} ${request.booking.code}: ${out.kind} (${out.error})`,
        );
      }
    } catch (e) {
      CheckInPushListener.log.error(
        `check-in push for ${event.eventType} ${event.aggregateId} failed: ` +
          (e instanceof Error ? e.message : String(e)),
      );
    }
  }

  /**
   * A party member's name, for the booker's push: a guest's as the booker
   * typed it, a registered member's as customer-api holds it. Null when
   * there is none, or customer-api did not answer in time.
   */
  private async nameOf(bookingId: string): Promise<string | null> {
    const member = await this.prisma.groupParticipant.findUnique({
      where: { bookingId },
      select: { guestName: true, customerId: true },
    });
    if (member === null) return null;
    if (member.guestName !== null) return member.guestName;
    if (member.customerId === null) return null;
    const found = await this.contacts.lookup(member.customerId, {
      quickMs: CHECK_IN_PUSH_NAME_MS,
    });
    return found.kind === 'found' ? found.contact.fullName : null;
  }
}

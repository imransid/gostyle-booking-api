import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  EVENT_PUBLISHER,
  type DomainEvent,
  type EventPublisher,
} from '@application/ports/event-publisher.port';
import { PrismaService } from '../persistence/prisma.service';
import {
  deriveGroupStatus,
  type ParticipantStatus,
} from '@domain/booking/group-status';

/** Named: a heredoc eats a line ending in `<`. */
interface MemberRow {
  group_id: string;
  status: string;
}

/**
 * The group's status follows its participants, without anyone remembering to
 * update it.
 *
 * Every participant is an ordinary booking, so every participant transition
 * already publishes an event. Listening to those means one cancel, one
 * check-in or one no-show moves the party's status as a consequence rather
 * than as a second thing somebody has to do.
 *
 * DECORATES the real publisher rather than replacing it, exactly as the
 * waitlist listener does. The event carries on afterwards.
 */
@Injectable()
export class GroupStatusListener implements EventPublisher {
  private static readonly log = new Logger(GroupStatusListener.name);

  constructor(
    @Inject(EVENT_PUBLISHER) private readonly next: EventPublisher,
    private readonly prisma: PrismaService,
  ) {}

  async publish(event: DomainEvent): Promise<void> {
    if (event.aggregateType === 'booking') {
      await this.rederive(event.aggregateId);
    }
    await this.next.publish(event);
  }

  /**
   * Recompute one group from its lanes.
   *
   * Best effort, like the waitlist offer: throwing would make the relay retry
   * the whole event and re-deliver a cancellation to every other consumer.
   * A stale group status is a display problem; a re-delivered cancellation is
   * a money problem.
   */
  private async rederive(bookingId: string): Promise<void> {
    try {
      // The group this booking belongs to, and every sibling's status, in one
      // question. Most bookings are not in a group, so this returns nothing
      // and costs one indexed lookup.
      const rows = await this.prisma.$queryRaw<MemberRow[]>`
        SELECT sibling.group_id, sibling.status::text AS status
          FROM booking me
          JOIN booking sibling ON sibling.group_id = me.group_id
         WHERE me.id = ${bookingId}::uuid
           AND me.group_id IS NOT NULL`;

      if (rows.length === 0) return;

      const groupId = rows[0]!.group_id;
      const derived = deriveGroupStatus(
        rows.map((r) => r.status as ParticipantStatus),
      );

      const updated = await this.prisma.bookingGroup.updateMany({
        // The WHERE is the claim: if NOTHING moved, nothing is written and
        // nothing is announced, so two participants cancelling in the same
        // second cannot produce two identical events.
        //
        // It compares the COUNT as well as the status, and that is the whole
        // fix. A party of three losing one is STILL CONFIRMED, so a claim on
        // status alone stayed silent at exactly the moment the party started
        // dropping toward a single booking.
        where: {
          id: groupId,
          OR: [
            { NOT: { status: derived.status } },
            { NOT: { activeCount: derived.activeCount } },
          ],
        },
        data: { status: derived.status, activeCount: derived.activeCount },
      });

      if (updated.count === 0) return;

      await this.prisma.eventOutbox.create({
        data: {
          aggregateType: 'group',
          aggregateId: groupId,
          eventType: `group.${derived.status}`,
          payload: {
            status: derived.status,
            activeCount: derived.activeCount,
            explanation: derived.explanation,
            // The organiser is notified BEFORE the change applies, so this
            // says the conversion is due rather than that it happened.
            conversionDue: derived.shouldConvertToSingle,
          },
        },
      });

      GroupStatusListener.log.log(
        `Group ${groupId} is now ${derived.status}: ${derived.explanation}`,
      );

      if (derived.shouldConvertToSingle) {
        // The doc requires the organiser be told BEFORE the change applies,
        // so the event goes out and the conversion itself is a separate,
        // audited act. Doing it silently here would surprise the one person
        // who is still coming.
        GroupStatusListener.log.log(
          `Group ${groupId} has fallen to one participant and should convert to a single booking`,
        );
      }
    } catch (e) {
      GroupStatusListener.log.error(
        `Could not re-derive the group for booking ${bookingId}, event delivered anyway: ` +
          `${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
}

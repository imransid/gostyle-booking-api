import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  EVENT_PUBLISHER,
  type DomainEvent,
  type EventPublisher,
} from '@application/ports/event-publisher.port';
import { WalkInRepository } from '../persistence/walk-in.repository';

/**
 * A confirmed booking empties the queue entry it came from.
 *
 * Matched on the HOLD, so the ordinary confirm path never learns that
 * walk-ins exist. Seating produces a hold and confirming it is a separate
 * call; without this the person would sit in a chair and go on appearing in
 * the waiting room, and the desk would have to tell us twice.
 */
@Injectable()
export class WalkInSeatedListener implements EventPublisher {
  private static readonly log = new Logger(WalkInSeatedListener.name);

  constructor(
    @Inject(EVENT_PUBLISHER) private readonly next: EventPublisher,
    private readonly walkIns: WalkInRepository,
  ) {}

  async publish(event: DomainEvent): Promise<void> {
    if (event.eventType === 'booking.confirmed') {
      await this.clearQueueEntry(event);
    }
    await this.next.publish(event);
  }

  private async clearQueueEntry(event: DomainEvent): Promise<void> {
    try {
      const payload = (event.payload ?? {}) as {
        holdId?: string;
        code?: string;
      };
      if (payload.holdId === undefined) return;

      const seated = await this.walkIns.markSeatedByHold(
        payload.holdId,
        event.aggregateId,
      );
      if (seated) {
        WalkInSeatedListener.log.log(
          `Walk-in seated as ${payload.code ?? event.aggregateId}`,
        );
      }
    } catch (e) {
      // The booking is confirmed either way. A queue row that lingers is a
      // cosmetic problem; refusing the event would be a real one.
      WalkInSeatedListener.log.error(
        `Could not clear the walk-in queue entry, event delivered anyway: ` +
          `${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
}

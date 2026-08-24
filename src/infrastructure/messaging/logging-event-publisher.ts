import { Injectable, Logger } from '@nestjs/common';
import type {
  DomainEvent,
  EventPublisher,
} from '@application/ports/event-publisher.port';

/**
 * Stands in for BullMQ until the queue is wired.
 *
 * Not a throwaway: keeping it means the whole relay can be tested and demoed
 * with no Redis at all, which is worth having in CI forever.
 */
@Injectable()
export class LoggingEventPublisher implements EventPublisher {
  private static readonly log = new Logger('Events');

  publish(event: DomainEvent): Promise<void> {
    LoggingEventPublisher.log.log(
      `${event.eventType} ${event.aggregateId.slice(0, 8)} ` +
        JSON.stringify(event.payload),
    );
    return Promise.resolve();
  }
}

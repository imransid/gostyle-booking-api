import { Logger } from '@nestjs/common';
import type {
  DomainEvent,
  EventPublisher,
} from '@application/ports/event-publisher.port';
import {
  posTicketSyncEnabled,
  posTicketSyncTenants,
} from '@application/commands/pos-ticket-sync.flag';
import { posSyncOf } from '@domain/pos/pos-ticket-request';
import type { PosTicketSyncRepository } from '../persistence/pos-ticket-sync.repository';

/**
 * One link in the outbox chain: turns a booking event the till cares about
 * (check-in, start, completion, undo, a cancel or no-show after arrival)
 * into one pos_ticket_sync row. It sends nothing.
 *
 * NO NETWORK CALL HAPPENS HERE, on purpose. The chain runs inside the
 * relay's batch; a slow platform in here would stall every event behind it,
 * and a failure would re-deliver every push. The worker does the sending
 * (pos-ticket-sync-worker.service.ts), in order, with backoff.
 *
 * OFF, IT IS FREE. The switch is read before any database work, so with
 * POS_TICKET_SYNC_ENABLED unset every event goes straight down the chain.
 *
 * IT THROWS, like the hub and reminder links: a lost row is a ticket that
 * never opens, or one that is never voided. The relay retries the event,
 * every other link's work is idempotent, and the unique event_id makes the
 * retry write nothing twice.
 */
export class PosTicketSyncEnqueuer implements EventPublisher {
  private static readonly log = new Logger(PosTicketSyncEnqueuer.name);

  constructor(
    private readonly next: EventPublisher,
    private readonly rows: PosTicketSyncRepository,
  ) {}

  async publish(event: DomainEvent): Promise<void> {
    if (event.aggregateType === 'booking' && posTicketSyncEnabled()) {
      await this.enqueue(event);
    }
    await this.next.publish(event);
  }

  private async enqueue(event: DomainEvent): Promise<void> {
    const intent = posSyncOf(event.eventType, event.payload);
    if (intent === null) return;

    try {
      const written = await this.rows.enqueue(
        {
          eventId: event.id,
          eventAt: event.createdAt,
          bookingId: event.aggregateId,
          kind: intent.kind,
          bookingStatus: intent.bookingStatus,
        },
        posTicketSyncTenants(),
      );
      if (written) {
        PosTicketSyncEnqueuer.log.log(
          `${event.eventType} ${event.aggregateId.slice(0, 8)}: queued for ` +
            `the till (${intent.kind} ${intent.bookingStatus})`,
        );
      }
    } catch (e) {
      PosTicketSyncEnqueuer.log.error(
        `${event.eventType} ${event.id}: could not queue for the till, the ` +
          `relay will retry: ${e instanceof Error ? e.message : String(e)}`,
      );
      throw e;
    }
  }
}

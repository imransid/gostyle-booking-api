import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  EVENT_PUBLISHER,
  type DomainEvent,
  type EventPublisher,
} from '@application/ports/event-publisher.port';
import { WaitlistRepository } from '../persistence/waitlist.repository';

const FREES_A_SLOT = new Set([
  'booking.cancelled',
  'booking.no_show',
  'booking.expired',
  'booking.skipped',
  'booking.rescheduled',
]);

/** What a freeing event carries, as far as this listener needs. */
interface FreedPayload {
  code?: string;
  branchId?: string;
  serviceId?: string;
  tradingDay?: string;
  startMin?: number;
  durationMin?: number;
  staffId?: string;
  releasedCapacity?: boolean;
}

@Injectable()
export class WaitlistListener implements EventPublisher {
  private static readonly log = new Logger(WaitlistListener.name);

  constructor(
    @Inject(EVENT_PUBLISHER) private readonly next: EventPublisher,
    private readonly waitlist: WaitlistRepository,
  ) {}

  async publish(event: DomainEvent): Promise<void> {
    if (FREES_A_SLOT.has(event.eventType)) {
      await this.tryOffer(event);
    }
    // Whatever happened above, the event still goes where it was going.
    await this.next.publish(event);
  }

  /**
   * A waitlist offer must never block the event.
   *
   * Throwing here would make the relay retry the whole event, which would
   * re-deliver the cancellation to every other consumer as well. The offer is
   * best-effort; the cancellation is not.
   *
   * The claim inside offerFreedSlot is idempotent (status = 'waiting' in the
   * WHERE), so a retry that does reach here twice offers the slot once.
   */
  private async tryOffer(event: DomainEvent): Promise<void> {
    const p = event.payload as FreedPayload;

    // Not every freeing event carries enough to match on yet. A cancel knows
    // its booking; it does not currently publish the service or the staff.
    // Skipping quietly is right: the alternative is a log line per cancel
    // saying nothing anyone can act on.
    if (
      p.code === undefined ||
      p.branchId === undefined ||
      p.serviceId === undefined ||
      p.tradingDay === undefined ||
      p.startMin === undefined ||
      p.durationMin === undefined ||
      p.staffId === undefined
    ) {
      return;
    }

    try {
      const result = await this.waitlist.offerFreedSlot(p.branchId, {
        bookingCode: p.code,
        serviceId: p.serviceId,
        tradingDay: p.tradingDay,
        startMin: p.startMin,
        durationMin: p.durationMin,
        staffId: p.staffId,
      });
      if (result.offered) {
        WaitlistListener.log.log(
          `${event.eventType} freed ${p.code}, offered to ${result.customerId ?? '?'}`,
        );
      }
    } catch (e) {
      WaitlistListener.log.error(
        `Waitlist offer for ${p.code} failed, event delivered anyway: ` +
          `${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
}

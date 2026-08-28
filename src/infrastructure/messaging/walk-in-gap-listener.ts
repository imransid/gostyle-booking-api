import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  EVENT_PUBLISHER,
  type DomainEvent,
  type EventPublisher,
} from '@application/ports/event-publisher.port';
import { PrismaService } from '../persistence/prisma.service';
import { toUuid } from '../persistence/hold.repository';

/**
 * A freed slot reaches the walk-in queue and the waitlist TOGETHER.
 *
 * Walk-ins are the first consumer of any slot a no-show gives back, which is
 * why the no-show path offers the gap to both at once rather than waiting for
 * the waitlist to decline it. Somebody is standing in the salon; the person on
 * the waitlist is at home.
 *
 * THE TWO OFFERS ARE DIFFERENT SHAPES and that is deliberate. A waitlist
 * offer is a push with a TTL, because the customer is elsewhere and has to be
 * reached. The walk-in queue recomputes its options from live availability on
 * every read, so the gap is simply THERE the moment capacity comes back. What
 * this listener adds is the nudge: an event the desk screen can highlight, so
 * a gap does not sit unnoticed until somebody refreshes.
 */
const FREES_A_SLOT = new Set([
  'booking.cancelled',
  'booking.no_show',
  'booking.expired',
  'booking.skipped',
  'booking.rescheduled',
]);

interface FreedPayload {
  code?: string;
  branchId?: string;
  tradingDay?: string;
  startMin?: number;
  durationMin?: number;
}

@Injectable()
export class WalkInGapListener implements EventPublisher {
  private static readonly log = new Logger(WalkInGapListener.name);

  constructor(
    @Inject(EVENT_PUBLISHER) private readonly next: EventPublisher,
    private readonly prisma: PrismaService,
  ) {}

  async publish(event: DomainEvent): Promise<void> {
    if (FREES_A_SLOT.has(event.eventType)) {
      await this.nudgeQueue(event);
    }
    await this.next.publish(event);
  }

  /**
   * Never block the event.
   *
   * A queue nudge is the least important thing happening on this path. If it
   * fails, the no-show still happened, the waitlist offer still went out, and
   * the queue still shows the gap on its next read.
   */
  private async nudgeQueue(event: DomainEvent): Promise<void> {
    try {
      const payload = (event.payload ?? {}) as FreedPayload;
      const branchId = payload.branchId;
      const tradingDay = payload.tradingDay;
      if (branchId === undefined || tradingDay === undefined) return;

      const waiting = await this.prisma.walkInEntry.count({
        where: {
          branchId: toUuid(branchId),
          tradingDay: new Date(`${tradingDay}T00:00:00Z`),
          status: 'waiting',
        },
      });
      if (waiting === 0) return;

      await this.prisma.eventOutbox.create({
        data: {
          aggregateType: 'walk_in_queue',
          aggregateId: toUuid(branchId),
          eventType: 'walk_in.gap_available',
          payload: {
            tradingDay,
            startMin: payload.startMin ?? null,
            durationMin: payload.durationMin ?? null,
            freedBy: event.eventType,
            code: payload.code ?? null,
            waiting,
          },
        },
      });

      WalkInGapListener.log.log(
        `${event.eventType} freed a gap on ${tradingDay}; ${waiting} walk-in(s) waiting`,
      );
    } catch (e) {
      WalkInGapListener.log.error(
        `Could not nudge the walk-in queue, event delivered anyway: ` +
          `${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
}

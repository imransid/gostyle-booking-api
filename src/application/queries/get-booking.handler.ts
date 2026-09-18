import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { BookingRepository } from '@infrastructure/persistence/booking.repository';
import {
  BOOKING_CONTEXT,
  type BookingContextReader,
} from '@application/ports/booking-context.port';
import { SlugIndex } from '@infrastructure/persistence/slug-uuid';
import { branchInstant } from '@infrastructure/persistence/hold.repository';
import { formatMinute } from '@domain/availability/grid';
import { Money } from '@domain/shared/money';
import { shout, type Shouted } from '@application/contract/wire';
import type { BookingStatus, ActorKind } from '@domain/booking/lifecycle';
import type { PaymentStatus } from '../../generated/prisma/enums';

export interface BookingDetailView {
  readonly bookingId: string;
  readonly code: string;
  readonly branchId: string;
  readonly customerId: string;
  readonly status: Shouted<BookingStatus>;
  readonly paymentStatus: Shouted<PaymentStatus>;
  readonly tradingDay: string;
  readonly start: string;
  readonly end: string;
  readonly startMin: number;
  readonly durationMin: number;
  readonly startAt: string;
  readonly endAt: string;
  readonly priceMinor: number;
  readonly price: string;
  readonly depositMinor: number;
  readonly deposit: string;
  readonly requirementSource: string | null;
  /**
   * How the booking was made: DESK, ONLINE, RECURRING, WALK_IN, GROUP.
   * Shouted like every other enum the front end receives.
   */
  readonly channel: string;
  readonly moveCount: number;
  readonly overbooked: boolean;
  readonly overbookReason: string | null;
  readonly linkExpiresAt: string | null;
  readonly tenantId: string | null;
  readonly createdAt: string;
  readonly items: readonly {
    readonly position: number;
    /** The STORED id. Frozen at the booking; not what the engine answers to. */
    readonly serviceId: string;
    /**
     * THE SAME SERVICE, spelled the way /availability and /eligible-staff
     * take it.
     *
     * The stored id 404'd on both -- "Unknown service: 8eb9c038-…" -- so the
     * reschedule drawer had to round-trip the service NAME through the
     * catalogue to recover a usable id, which breaks the first time a
     * service is renamed. The list row for the same booking has published
     * the engine's spelling all along.
     */
    readonly serviceRef: string;
    readonly serviceName: string;
    readonly staffId: string | null;
    /** The professional, spelled the way the engine takes them. */
    readonly staffRef: string | null;
    /** And their name, which no detail payload carried at all. */
    readonly staffName: string | null;
    readonly resourceType: string;
    readonly requiredSkill: string;
    readonly priceMinor: number;
    readonly durationMin: number;
  }[];
  /** The money, append-only, oldest first. */
  readonly ledger: readonly {
    readonly entryType: string;
    readonly amountMinor: number;
    readonly rail: string | null;
    readonly at: string;
  }[];
  /** The trail §17.4 describes, as far as the rows actually go. */
  readonly history: readonly {
    readonly from: string | null;
    readonly to: Shouted<BookingStatus>;
    readonly reason: string | null;
    readonly actorKind: Shouted<ActorKind>;
    readonly at: string;
  }[];
}

/**
 * One booking, read back.
 *
 * The audit found there was no read surface at all: a booking could be
 * created, moved, settled and refunded, and never looked at again through the
 * API. This is that endpoint, and it returns the drawer's contents in one
 * round trip -- the visit, its items, its ledger and its history -- because a
 * front end that has to make three calls to render one panel will make them
 * in the wrong order eventually.
 */
@Injectable()
export class GetBookingHandler {
  constructor(
    private readonly bookings: BookingRepository,
    /**
     * The handler owns the port, per the layering rule. It is here only to
     * translate ids and names -- the drawer is a read and must never fail
     * because the roster blinked, so every lookup below degrades to the
     * stored value.
     */
    @Inject(BOOKING_CONTEXT) private readonly context: BookingContextReader,
  ) {}

  async execute(bookingId: string): Promise<BookingDetailView> {
    const b = await this.bookings.detail(bookingId);
    if (b === null) throw new NotFoundException('No such booking');

    const day = b.tradingDay.toISOString().slice(0, 10);
    const endMin = b.startMinute + b.durationMin;
    const names = await this.namesFor(b.branchId, day);

    return {
      bookingId: b.id,
      code: b.code,
      branchId: b.branchId,
      customerId: b.customerId,
      status: shout(b.status),
      paymentStatus: shout(b.paymentStatus),
      tradingDay: day,
      start: formatMinute(b.startMinute),
      end: formatMinute(endMin),
      startMin: b.startMinute,
      durationMin: b.durationMin,
      startAt: branchInstant(day, b.startMinute).toISOString(),
      endAt: branchInstant(day, endMin).toISOString(),
      priceMinor: b.priceFils,
      price: Money.fils(b.priceFils).toString(),
      depositMinor: b.depositFils,
      deposit: Money.fils(b.depositFils).toString(),
      requirementSource: b.requirementSource,
      channel: shout(b.channel),
      moveCount: b.moveCount,
      overbooked: b.overbooked,
      overbookReason: b.overbookReason,
      linkExpiresAt:
        b.linkExpiresAt === null ? null : b.linkExpiresAt.toISOString(),
      tenantId: b.tenantId,
      createdAt: b.createdAt.toISOString(),
      items: b.items.map((i) => ({
        position: i.position,
        serviceId: i.serviceId,
        serviceRef: names.index.toSlug(i.serviceId),
        serviceName: i.serviceName,
        staffId: i.staffId,
        staffRef: i.staffId === null ? null : names.index.toSlug(i.staffId),
        staffName:
          i.staffId === null
            ? null
            : (names.staff.get(names.index.toSlug(i.staffId)) ?? null),
        resourceType: i.resourceType,
        requiredSkill: i.requiredSkill,
        priceMinor: i.priceFils,
        durationMin: i.durationMin,
      })),
      ledger: b.ledger.map((l) => ({
        entryType: l.entryType,
        amountMinor: l.amountFils,
        rail: l.rail,
        at: l.createdAt.toISOString(),
      })),
      history: b.statusHistory.map((h) => ({
        from: h.fromStatus === null ? null : shout(h.fromStatus),
        to: shout(h.toStatus),
        reason: h.reason,
        actorKind: shout(h.actorKind),
        at: h.createdAt.toISOString(),
      })),
    };
  }

  /**
   * The branch's roster and catalogue, as an id index and a name map.
   *
   * ONE index over both, exactly as the board reads do (`slugIndex` in
   * read-models.handler). An unreachable roster leaves every id as it was
   * stored and every name null: decoration, never a refusal.
   */
  private async namesFor(
    branchId: string,
    day: string,
  ): Promise<{ index: SlugIndex; staff: ReadonlyMap<string, string> }> {
    try {
      const [ctx, catalogue] = await Promise.all([
        this.context.loadDay(branchId, day),
        this.context.loadCatalogue(branchId),
      ]);
      return {
        index: new SlugIndex([
          ...ctx.professionals.map((p) => p.id),
          ...catalogue.map((c) => c.id),
        ]),
        staff: new Map(ctx.professionals.map((p) => [p.id, p.name])),
      };
    } catch {
      return { index: new SlugIndex([]), staff: new Map() };
    }
  }
}

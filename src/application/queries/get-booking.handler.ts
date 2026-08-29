import { Injectable, NotFoundException } from '@nestjs/common';
import { BookingRepository } from '@infrastructure/persistence/booking.repository';
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
  readonly channel: string;
  readonly moveCount: number;
  readonly overbooked: boolean;
  readonly overbookReason: string | null;
  readonly linkExpiresAt: string | null;
  readonly tenantId: string | null;
  readonly createdAt: string;
  readonly items: readonly {
    readonly position: number;
    readonly serviceId: string;
    readonly serviceName: string;
    readonly staffId: string | null;
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
  constructor(private readonly bookings: BookingRepository) {}

  async execute(bookingId: string): Promise<BookingDetailView> {
    const b = await this.bookings.detail(bookingId);
    if (b === null) throw new NotFoundException('No such booking');

    const day = b.tradingDay.toISOString().slice(0, 10);
    const endMin = b.startMinute + b.durationMin;

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
      channel: b.channel,
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
        serviceName: i.serviceName,
        staffId: i.staffId,
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
}

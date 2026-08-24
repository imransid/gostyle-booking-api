import {
  ConflictException,
  GoneException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import {
  BOOKING_CONTEXT,
  type BookingContextReader,
} from '@application/ports/booking-context.port';
import {
  BookingRepository,
  type ConfirmItem,
  type PaymentRail,
} from '@infrastructure/persistence/booking.repository';
import { PrismaService } from '@infrastructure/persistence/prisma.service';
import { Money } from '@domain/shared/money';
import { formatMinute } from '@domain/availability/grid';

export interface ConfirmBookingCommand {
  readonly holdId: string;
  readonly branchId: string;
  readonly customerId: string;
  readonly tradingDay: string;
  readonly serviceIds: readonly string[];
  readonly channel: string;
  /** Omit when the requirement was "none". */
  readonly payment?: {
    readonly amountFils: number;
    readonly rail: PaymentRail;
    readonly gatewayRef?: string;
  };
  readonly actorId?: string;
  readonly idempotencyKey?: string;
}

export interface BookingView {
  readonly code: string;
  readonly bookingId: string;
  readonly status: string;
  readonly paymentStatus: string;
  readonly start: string;
  readonly end: string;
  readonly durationMin: number;
  readonly totalFils: number;
  readonly total: string;
  readonly depositFils: number;
  readonly deposit: string;
  readonly dueAtCheckoutFils: number;
  readonly dueAtCheckout: string;
  readonly requirementSource: string | null;
  /** True when the same Idempotency-Key was seen before. Nothing was charged twice. */
  readonly replayed: boolean;
}

@Injectable()
export class ConfirmBookingHandler {
  constructor(
    @Inject(BOOKING_CONTEXT) private readonly context: BookingContextReader,
    private readonly bookings: BookingRepository,
    private readonly prisma: PrismaService,
  ) {}

  async execute(cmd: ConfirmBookingCommand): Promise<BookingView> {
    // A retry is answered from what was stored, never re-derived. The first
    // confirm re-pointed the reservation to the booking and deleted the hold,
    // so every lookup below would fail on a replay and throw 410 instead of
    // returning the original booking.
    if (cmd.idempotencyKey !== undefined) {
      const replay = await this.replayFor(cmd.idempotencyKey);
      if (replay !== null) return replay;
    }

    const services = await this.context.loadServices(
      cmd.branchId,
      cmd.serviceIds,
    );
    if (services.length !== cmd.serviceIds.length) {
      throw new NotFoundException('One or more services do not exist');
    }

    // The professional was decided when the hold was placed. Reading it back
    // rather than trusting the request is what stops a client confirming a
    // slot it never held.
    const reservation = await this.prisma.staffReservation.findFirst({
      where: { holdId: cmd.holdId },
      orderBy: { startMinute: 'asc' },
      select: { staffId: true, startMinute: true },
    });
    if (reservation === null) {
      throw new GoneException(
        'That hold no longer exists. Re-check availability before continuing.',
      );
    }

    const items: ConfirmItem[] = services.map((s) => ({
      serviceId: s.id,
      serviceName: s.name,
      resourceType: s.resourceType,
      requiredSkill: s.skill,
      priceFils: priceOf(s.id),
      durationMin: s.durationMin,
      staffId: reservation.staffId,
    }));

    const total = Money.sum(items.map((i) => Money.fils(i.priceFils)));
    const deposit =
      cmd.payment === undefined
        ? Money.ZERO
        : Money.fils(cmd.payment.amountFils);

    const outcome = await this.bookings.confirm({
      holdId: cmd.holdId,
      branchId: cmd.branchId,
      customerId: cmd.customerId,
      tradingDay: cmd.tradingDay,
      channel: cmd.channel,
      items,
      priceFils: total.fils,
      depositFils: deposit.fils,
      requirementSource:
        cmd.payment === undefined ? null : describeRequirement(deposit, total),
      payment:
        cmd.payment === undefined
          ? null
          : {
              amountFils: cmd.payment.amountFils,
              rail: cmd.payment.rail,
              gatewayRef: cmd.payment.gatewayRef ?? null,
            },
      actorId: cmd.actorId ?? null,
      idempotencyKey: cmd.idempotencyKey ?? null,
      requestHash: hashRequest(cmd),
    });

    // Both refusals mean the same thing to the customer: nothing was charged.
    if (outcome.kind === 'hold_expired') {
      throw new GoneException(
        'This hold expired. Money is never taken against a dead hold. Re-check availability before continuing.',
      );
    }
    if (outcome.kind === 'slot_taken') {
      throw new ConflictException(
        'Someone took this while you were paying. Nothing was charged. Offers have refreshed.',
      );
    }

    const b = outcome.booking;
    const due = total.minus(deposit);

    const view: BookingView = {
      code: b.code,
      bookingId: b.bookingId,
      status: b.status,
      paymentStatus: b.paymentStatus,
      start: formatMinute(b.startMin),
      end: formatMinute(b.startMin + b.durationMin),
      durationMin: b.durationMin,
      totalFils: total.fils,
      total: total.toString(),
      depositFils: deposit.fils,
      deposit: deposit.toString(),
      dueAtCheckoutFils: due.fils,
      dueAtCheckout: due.toString(),
      requirementSource:
        cmd.payment === undefined ? null : describeRequirement(deposit, total),
      replayed: outcome.kind === 'replayed',
    };

    // Overwrite the stored body with the shape a client actually receives.
    // Cheap, outside the transaction, and it makes a retry byte-identical
    // to the original answer instead of a near-miss.
    if (cmd.idempotencyKey !== undefined && outcome.kind === 'confirmed') {
      await this.prisma.idempotencyKey.update({
        where: { key: cmd.idempotencyKey },
        data: { responseBody: { ...view, replayed: true } },
      });
    }

    return view;
  }
  private async replayFor(key: string): Promise<BookingView | null> {
    const row = await this.prisma.idempotencyKey.findUnique({ where: { key } });
    if (row === null || row.responseBody === null) return null;
    const stored = row.responseBody as unknown as BookingView;
    return { ...stored, replayed: true };
  }
}

/**
 * The catalogue in the fixture carries no prices yet, so they live here until
 * the real catalogue service lands. Fils, never decimals.
 */
const PRICE_FILS: Record<string, number> = {
  'haircut-finish': 16000,
  'blow-dry': 14000,
  'fringe-trim': 6000,
  'hair-colour': 48000,
  'full-colour': 48000,
  balayage: 72000,
  keratin: 85000,
  'gel-manicure': 18000,
  'mani-pedi': 22000,
  'luxury-facial': 38000,
  'brow-lamination': 22000,
  'hair-wash': 4000,
};

function priceOf(serviceId: string): number {
  return PRICE_FILS[serviceId] ?? 0;
}

/**
 * Stored on the booking so support can answer "why was I charged this" months
 * later, without anyone re-deriving February's rules from memory.
 */
function describeRequirement(deposit: Money, total: Money): string {
  if (deposit.isZero()) return 'No deposit required';
  if (deposit.equals(total)) return 'Paid in full at booking';
  const pct = Math.round((deposit.fils / total.fils) * 100);
  return `Deposit ${pct}% of ${total.toString()}`;
}

/**
 * Same key with a DIFFERENT body is a client bug, not a retry. Storing the
 * hash lets a later version answer 422 instead of silently returning someone
 * else's booking.
 */
function hashRequest(cmd: ConfirmBookingCommand): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        holdId: cmd.holdId,
        services: [...cmd.serviceIds].sort(),
        payment: cmd.payment ?? null,
      }),
    )
    .digest('hex');
}

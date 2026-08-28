import {
  ConflictException,
  GoneException,
  UnprocessableEntityException,
  HttpException,
  HttpStatus,
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
  CUSTOMER_CONTEXT,
  type CustomerContextReader,
} from '@application/ports/customer-context.port';
import {
  requirementFor,
  DEFAULT_BRANCH,
  type Requirement,
} from '@domain/booking/customer';
import { quote } from '@domain/booking/quote';
import {
  shout,
  toWireQuoteLine,
  type Shouted,
  type WireQuoteLine,
} from '@application/contract/wire';
import type {
  BookingStatus,
  PaymentStatus,
} from '../../generated/prisma/enums';
import { linkWindow } from '@domain/booking/payment-link';
import {
  BookingRepository,
  type ConfirmItem,
  type PaymentRail,
} from '@infrastructure/persistence/booking.repository';
import { PrismaService } from '@infrastructure/persistence/prisma.service';
import { branchInstant } from '@infrastructure/persistence/hold.repository';
import { Money } from '@domain/shared/money';
import { formatMinute } from '@domain/availability/grid';
import { resolveSelection } from '@domain/booking/package';
import { PACKAGES } from '@infrastructure/fixtures/fixture-booking-context';

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
  readonly status: Shouted<BookingStatus>;
  readonly paymentStatus: Shouted<PaymentStatus>;
  readonly start: string;
  readonly end: string;
  readonly durationMin: number;
  /** Net, exclusive of VAT. Prices are STORED net; tax is computed here. */
  readonly totalNetMinor: number;
  readonly totalNet: string;
  readonly vatMinor: number;
  readonly vat: string;
  /** Inclusive of VAT. The number on the receipt. */
  readonly totalMinor: number;
  readonly total: string;
  readonly depositMinor: number;
  readonly deposit: string;
  readonly dueAtCheckoutMinor: number;
  readonly dueAtCheckout: string;
  readonly requirementSource: string | null;
  /** The quote pipeline, line by line, so nothing at checkout surprises. */
  readonly quote: readonly WireQuoteLine[];
  /** True when the same Idempotency-Key was seen before. Nothing was charged twice. */
  readonly replayed: boolean;
}

@Injectable()
export class ConfirmBookingHandler {
  constructor(
    @Inject(BOOKING_CONTEXT) private readonly context: BookingContextReader,
    private readonly bookings: BookingRepository,
    private readonly prisma: PrismaService,
    @Inject(CUSTOMER_CONTEXT)
    private readonly customers: CustomerContextReader,
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

    // A PACKAGE STOPS EXISTING HERE. It expands into the services the branch
    // already sells, and everything below this line sees a plain selection:
    // same chain, same skills, same buffers, same chair demand. What survives
    // is one line in the quote.
    const selection = resolveSelection(cmd.serviceIds, PACKAGES, priceOf);

    const services = await this.context.loadServices(
      cmd.branchId,
      selection.serviceIds,
    );
    if (services.length !== selection.serviceIds.length) {
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

    // THE SERVER DECIDES WHAT IS OWED. The request only says what was
    // TENDERED. Before this, a client could send amountFils: 1 against a
    // AED 480 colour and the booking was confirmed with a one-fil deposit,
    // which protects nothing at all.
    const customer = await this.customers.load(cmd.customerId);
    const first = services[0];
    const requirement = requirementFor({
      totalFils: total.fils,
      risk: customer.risk,
      riskScore: customer.riskScore,
      requireDepositFlag: customer.requireDepositFlag,
      service: {
        name: first?.name ?? 'service',
        percent: first?.depositPercent ?? null,
        fixedFils: first?.depositFixedFils ?? null,
      },
      isNewCustomer: customer.isNewCustomer,
      channel: cmd.channel === 'online' ? 'online' : 'desk',
      startMin: reservation.startMinute,
      branch: DEFAULT_BRANCH,
    });

    const tendered =
      cmd.payment === undefined
        ? Money.ZERO
        : Money.fils(cmd.payment.amountFils);
    const required = Money.fils(requirement.amountFils);

    // Short of the requirement, nothing is charged and the desk is told the
    // figure AND why, so "why was I charged this" is answered before the
    // customer has to ask.
    if (tendered.lessThan(required)) {
      throw new HttpException(
        {
          statusCode: HttpStatus.PAYMENT_REQUIRED,
          error: 'Payment Required',
          message: `${required.toString()} is required before this booking can be confirmed.`,
          requiredMinor: required.fils,
          tenderedMinor: tendered.fils,
          requirement: describeFully(requirement),
        },
        HttpStatus.PAYMENT_REQUIRED,
      );
    }

    // A LINK THAT IS ALREADY DEAD IS WORSE THAN NO LINK.
    //
    // The window is the shorter of six hours and the time until two hours
    // before the start, and inside that last two hours it has already closed.
    // Issuing one anyway gives the customer a broken payment page and holds
    // the slot until a sweeper notices, so the desk is told to take payment
    // now instead.
    let linkExpiresAt: Date | null = null;
    if (cmd.payment?.rail === 'link') {
      const window = linkWindow(
        Date.now(),
        branchInstant(cmd.tradingDay, reservation.startMinute).getTime(),
      );
      if (window.kind === 'too_late') {
        throw new UnprocessableEntityException(
          `That start is too close for a payment link: the window closed ${window.minutesPastCutoff} minutes ago. Take payment now instead.`,
        );
      }
      linkExpiresAt = new Date(window.expiresAtMs);
    }

    // Never bank more than the price, whatever a desk types in.
    const deposit = Money.min(tendered, total);

    // The quote is what the customer actually owes. `total` above is NET,
    // exclusive of VAT, and it stays that way because the deposit is
    // resolved on the pre-discount net figure. The booking stores the
    // VAT-inclusive total, because that is the number on the receipt.
    const priced = quote({
      serviceFils: total.fils,
      addOnFils: 0,
      // The sum of the package parts minus the package price, which is what
      // the customer is actually being given.
      bundleDiscountFils: selection.bundleDiscountFils,
      tier: customer.tier,
      requirementFils: deposit.fils,
    });

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
        requirement.kind === 'none' ? null : requirement.source,
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
      linkExpiresAt,
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

    const view: BookingView = {
      code: b.code,
      bookingId: b.bookingId,
      status: shout(b.status),
      paymentStatus: shout(b.paymentStatus),
      start: formatMinute(b.startMin),
      end: formatMinute(b.startMin + b.durationMin),
      durationMin: b.durationMin,
      totalNetMinor: priced.subtotalNetFils,
      totalNet: Money.fils(priced.subtotalNetFils).toString(),
      vatMinor: priced.vatFils,
      vat: Money.fils(priced.vatFils).toString(),
      totalMinor: priced.totalFils,
      total: Money.fils(priced.totalFils).toString(),
      depositMinor: deposit.fils,
      deposit: deposit.toString(),
      // The balance owed at the register INCLUDES the tax. Reporting the
      // net balance here would have the desk collect 5% too little on every
      // booking, and nobody would notice until a reconciliation.
      dueAtCheckoutMinor: priced.dueAtCheckoutFils,
      dueAtCheckout: Money.fils(priced.dueAtCheckoutFils).toString(),
      requirementSource:
        requirement.kind === 'none' ? null : requirement.source,
      quote: priced.lines.map(toWireQuoteLine),
      replayed: outcome.kind === 'replayed',
    };

    // Overwrite the stored body with the shape a client actually receives.
    // Cheap, outside the transaction, and it makes a retry byte-identical
    // to the original answer instead of a near-miss.
    if (cmd.idempotencyKey !== undefined && outcome.kind === 'confirmed') {
      await this.prisma.idempotencyKey.update({
        where: { key: cmd.idempotencyKey },
        data: {
          // Prisma's JSON input type wants mutable arrays, and the view's
          // quote lines are readonly. A structural copy satisfies it without
          // loosening the type the client actually receives.
          responseBody: JSON.parse(
            JSON.stringify({ ...view, replayed: true }),
          ) as object,
        },
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
/**
 * The catalogue, until a catalogue service answers over gRPC.
 *
 * Exported rather than copied. A second table would have been two
 * sources of truth for what things cost, and the group path would have
 * priced parties on different numbers than the single path used for the
 * bookings inside them: correct-looking in every test that checked shape.
 */
export const PRICE_FILS: Record<string, number> = {
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
  'hot-stone': 34000,
  'hair-wash': 4000,
};

export function priceOf(serviceId: string): number {
  return PRICE_FILS[serviceId] ?? 0;
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

/** The full trace, for the 402 body and for support months later. */
function describeFully(r: Requirement): {
  kind: string;
  source: string;
  clampNote?: string;
  trace: readonly { rung: string; evaluation: string; fired: boolean }[];
} {
  return {
    kind: r.kind,
    source: r.source,
    ...(r.clampNote !== undefined ? { clampNote: r.clampNote } : {}),
    trace: r.trace,
  };
}

import { Inject, Injectable, NotFoundException } from '@nestjs/common';
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
  type RequirementKind,
  type Tier,
} from '@domain/booking/customer';
import { quote } from '@domain/booking/quote';
import { linkWindow } from '@domain/booking/payment-link';
import { branchInstant } from '@infrastructure/persistence/hold.repository';
import { Money } from '@domain/shared/money';
import { resolveSelection } from '@domain/booking/package';
import { PACKAGES } from '@infrastructure/fixtures/fixture-booking-context';
import { priceOf } from '@application/commands/confirm-booking.handler';
import {
  shout,
  toWireQuoteLine,
  type Shouted,
  type WireQuoteLine,
} from '@application/contract/wire';

export interface QuoteQuery {
  readonly branchId: string;
  readonly tradingDay: string;
  /** Service ids, package ids, or a mix. Packages expand. */
  readonly serviceIds: readonly string[];
  readonly customerId: string;
  readonly channel: 'desk' | 'online';
  /** Drives the peak-window rung. Defaults to an off-peak start. */
  readonly startMin: number;
}

/**
 * The full arithmetic, before anything is held or charged.
 *
 * A SUPERSET ON PURPOSE. The front-end contract asks for three of these
 * figures; every one of them is returned, and so is every intermediate the
 * arithmetic passes through. An extra field costs a reader one line of
 * scrolling. A missing one costs a support conversation about a number
 * nobody can reconstruct -- and the two most-asked questions in any booking
 * product are "why is this the total" and "why was I charged this", which
 * need the intermediates and the trace respectively.
 *
 * THE TWO BASES ARE DIFFERENT, AND THAT IS THE POINT:
 *   VAT     sits on the DISCOUNTED subtotal -- taxing the gross would tax
 *           money nobody paid.
 *   DEPOSIT sits on the PRE-DISCOUNT total -- a tier discount is a reward,
 *           and a deposit protects the slot, which is worth what it is worth.
 * Returning both bases is what lets a reader check that.
 */
export interface QuoteView {
  readonly branchId: string;
  readonly tradingDay: string;
  readonly startMin: number;
  readonly channel: string;
  readonly tier: Shouted<Tier>;
  /** After any package expanded, in chain order. */
  readonly serviceIds: readonly string[];
  readonly packages: readonly {
    readonly packageId: string;
    readonly name: string;
    readonly serviceIds: readonly string[];
  }[];
  readonly durationMin: number;

  /** Net, exclusive of VAT, before any discount. */
  readonly subtotalMinor: number;
  readonly subtotal: string;
  readonly addOnMinor: number;
  /** The sum of a package's parts, less the package price. */
  readonly bundleDiscountMinor: number;
  readonly bundleDiscount: string;
  readonly tierDiscountMinor: number;
  readonly tierDiscount: string;
  /** What VAT is actually charged on. */
  readonly discountedSubtotalMinor: number;
  readonly discountedSubtotal: string;
  readonly vatMinor: number;
  readonly vat: string;
  /** Inclusive of VAT. The number on the receipt. */
  readonly totalMinor: number;
  readonly total: string;

  /** The requirement, computed on the PRE-discount total. */
  readonly depositMinor: number;
  readonly deposit: string;
  readonly dueAtCheckoutMinor: number;
  readonly dueAtCheckout: string;
  /**
   * The resolved requirement source, at the top level as well as in the
   * trace. It is the string the booking stores and the one support quotes
   * back months later, so it should not need digging out of a nested object.
   */
  readonly requirementSource: string;

  /**
   * Can this booking be paid by link at all?
   *
   * False inside the last two hours before the start: §8.4.1's window is the
   * shorter of six hours and start-minus-two, and inside that it has already
   * closed. Confirm REFUSES the link rail there with a 422
   * (confirm-booking.handler.ts:212), so a front end that offers the option
   * anyway is offering a button that cannot work. Better it knows here, while
   * it is still drawing the rail choices, than after the customer picks one.
   */
  readonly linkAvailable: boolean;
  /** Why not, when it is not. Null when the link is available. */
  readonly linkUnavailableReason: string | null;
  /** When the link would close, if one were issued now. */
  readonly linkExpiresAt: string | null;

  readonly requirement: {
    readonly kind: Shouted<RequirementKind>;
    readonly source: string;
    readonly clampNote?: string;
    /** Every rung, fired or not. The answer to "why was I charged this". */
    readonly trace: readonly {
      readonly rung: string;
      readonly evaluation: string;
      readonly fired: boolean;
    }[];
  };

  readonly quote: readonly WireQuoteLine[];
}

@Injectable()
export class GetQuoteHandler {
  constructor(
    @Inject(BOOKING_CONTEXT) private readonly context: BookingContextReader,
    @Inject(CUSTOMER_CONTEXT)
    private readonly customers: CustomerContextReader,
  ) {}

  async execute(q: QuoteQuery): Promise<QuoteView> {
    // Packages expand into real services here, exactly as they do at hold and
    // confirm: §15.4's "never a special case in the engine" holds for the
    // quote too, or the figure quoted would not be the figure charged.
    const selection = resolveSelection(q.serviceIds, PACKAGES, priceOf);

    const services = await this.context.loadServices(
      q.branchId,
      selection.serviceIds,
    );
    if (services.length !== selection.serviceIds.length) {
      const known = new Set(services.map((s) => s.id));
      const missing = selection.serviceIds.filter((id) => !known.has(id));
      throw new NotFoundException(`Unknown service: ${missing.join(', ')}`);
    }

    const customer = await this.customers.load(q.customerId);

    const serviceFils = services.reduce((n, s) => n + priceOf(s.id), 0);
    const first = services[0];

    // Computed on the PRE-DISCOUNT total, and passed to quote() as a
    // finished figure so there is exactly one requirement engine.
    const requirement = requirementFor({
      totalFils: serviceFils,
      risk: customer.risk,
      riskScore: customer.riskScore,
      requireDepositFlag: customer.requireDepositFlag,
      service: {
        name: first?.name ?? 'service',
        percent: first?.depositPercent ?? null,
        fixedFils: first?.depositFixedFils ?? null,
      },
      isNewCustomer: customer.isNewCustomer,
      channel: q.channel,
      startMin: q.startMin,
      branch: DEFAULT_BRANCH,
    });

    // THE SAME linkWindow() confirm runs, against the same start, so the
    // answer here and the 422 there cannot disagree. A quote is asked for
    // before a slot is held, so this uses the start the caller is asking
    // about rather than a reservation.
    const window = linkWindow(
      Date.now(),
      branchInstant(q.tradingDay, q.startMin).getTime(),
    );

    // THE SAME quote() the wizard and the till run. A second pipeline here
    // would be a second answer, and the one that disagrees with the register
    // is the one the customer is looking at.
    const q1 = quote({
      serviceFils,
      addOnFils: 0,
      bundleDiscountFils: selection.bundleDiscountFils,
      tier: customer.tier,
      requirementFils: requirement.amountFils,
    });

    return {
      branchId: q.branchId,
      tradingDay: q.tradingDay,
      startMin: q.startMin,
      channel: q.channel,
      tier: shout(customer.tier),
      serviceIds: selection.serviceIds,
      packages: selection.expansions.map((e) => ({
        packageId: e.packageId,
        name: e.name,
        serviceIds: e.serviceIds,
      })),
      durationMin: services.reduce((n, s) => n + s.durationMin, 0),

      subtotalMinor: q1.subtotalNetFils,
      subtotal: Money.fils(q1.subtotalNetFils).toString(),
      addOnMinor: q1.addOnFils,
      bundleDiscountMinor: q1.bundleDiscountFils,
      bundleDiscount: Money.fils(q1.bundleDiscountFils).toString(),
      tierDiscountMinor: q1.tierDiscountFils,
      tierDiscount: Money.fils(q1.tierDiscountFils).toString(),
      discountedSubtotalMinor: q1.discountedSubtotalFils,
      discountedSubtotal: Money.fils(q1.discountedSubtotalFils).toString(),
      vatMinor: q1.vatFils,
      vat: Money.fils(q1.vatFils).toString(),
      totalMinor: q1.totalFils,
      total: Money.fils(q1.totalFils).toString(),

      depositMinor: q1.dueNowFils,
      deposit: Money.fils(q1.dueNowFils).toString(),
      dueAtCheckoutMinor: q1.dueAtCheckoutFils,
      dueAtCheckout: Money.fils(q1.dueAtCheckoutFils).toString(),
      requirementSource: requirement.source,
      linkAvailable: window.kind === 'open',
      linkUnavailableReason:
        window.kind === 'open'
          ? null
          : `The start is too close for a payment link: the window closed ` +
            `${window.minutesPastCutoff} minutes ago. Take payment now instead.`,
      linkExpiresAt:
        window.kind === 'open'
          ? new Date(window.expiresAtMs).toISOString()
          : null,

      requirement: {
        kind: shout(requirement.kind),
        source: requirement.source,
        ...(requirement.clampNote !== undefined
          ? { clampNote: requirement.clampNote }
          : {}),
        trace: requirement.trace,
      },

      quote: q1.lines.map(toWireQuoteLine),
    };
  }
}

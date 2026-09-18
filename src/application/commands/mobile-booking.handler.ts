import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PlaceHoldHandler } from './place-hold.handler';
import { ConfirmBookingHandler } from './confirm-booking.handler';
import { PaymentLinkHandler } from './payment-link.handler';
import { GetQuoteHandler } from '@application/queries/get-quote.handler';
import {
  BOOKING_CONTEXT,
  type BookingContextReader,
} from '@application/ports/booking-context.port';
import { BookingRepository } from '@infrastructure/persistence/booking.repository';
import {
  BRANCH_UTC_OFFSET_MIN,
  branchInstant,
} from '@infrastructure/persistence/hold.repository';
import { SlugIndex } from '@infrastructure/persistence/slug-uuid';
import {
  aedToFils,
  amountsAgree,
  dateAgreesWithStart,
  filsToAed,
  refuseUnsupported,
  stylistsLineUp,
  toBranchMoment,
  toMobilePaymentStatus,
  toMobileStatus,
  toOffsetIso,
} from '@domain/booking/mobile-contract';
import {
  MobileContractError,
  isMobileContractError,
} from './mobile-booking.error';
import { isBookingError } from '@application/contract/errors';

/**
 * One call for the mobile app: hold, confirm, and issue the payment link.
 *
 * ORCHESTRATION ONLY. Every rule this touches already exists and is proven
 * somewhere else -- capacity in PlaceHoldHandler, the nine-write transaction
 * and the deposit ladder in ConfirmBookingHandler, the link window in
 * PaymentLinkHandler. Nothing here re-decides any of them, and nothing here
 * opens a transaction. If this file ever computes a price or a free slot,
 * that is the bug.
 *
 * WHY THREE CALLS AND NOT ONE ENDPOINT THE APP DRIVES. The desk flow is
 * deliberately three round trips, because a desk agent reads the offers,
 * talks to the customer, and then commits. A phone has already collected all
 * three answers on one screen before it submits, so making it replay the
 * conversation adds two round trips over mobile data and two more chances to
 * lose a slot between them.
 *
 * THE HOLD IS RELEASED IF ANYTHING AFTER IT FAILS. A hold that outlives its
 * request holds a chair against a booking that will never exist, until a
 * sweeper notices fifteen minutes later. That is a real slot the salon
 * cannot sell, caused by our error rather than the customer's.
 */

export interface MobileBookingCommand {
  readonly salonId: string;
  readonly services: readonly {
    readonly id: string;
    readonly amount: number;
  }[];
  readonly products:
    readonly { readonly id: string; readonly amount: number }[] | undefined;
  readonly stylists: readonly string[];
  readonly date: string;
  readonly startTime: string;
  readonly endTime: string;
  readonly amountWithoutTax: number;
  readonly taxAmount: number;
  readonly discount: number;
  readonly promoCode: string | null;
  readonly total: number;
  readonly advancePaidAmount: number;
  readonly dueAmount: number;
  readonly paymentStatus: string;
  readonly status: string;
  readonly bookingType: string;
  /** From the verified token. Never from the payload (§1). */
  readonly customerId: string;
  readonly idempotencyKey: string | undefined;
}

@Injectable()
export class MobileBookingHandler {
  private static readonly log = new Logger(MobileBookingHandler.name);

  constructor(
    private readonly holds: PlaceHoldHandler,
    private readonly confirms: ConfirmBookingHandler,
    private readonly links: PaymentLinkHandler,
    private readonly quotes: GetQuoteHandler,
    private readonly bookings: BookingRepository,
    @Inject(BOOKING_CONTEXT) private readonly context: BookingContextReader,
  ) {}

  async execute(cmd: MobileBookingCommand): Promise<unknown> {
    const serviceIds = cmd.services.map((s) => s.id);

    // ---- 1. What this service cannot honour, refused up front -----------
    const unsupported = refuseUnsupported({
      products: cmd.products,
      bookingType: cmd.bookingType,
      stylists: cmd.stylists,
    });
    if (unsupported !== null) {
      throw MobileContractError.of(
        unsupported.field,
        unsupported.code,
        unsupported.message,
      );
    }

    if (cmd.services.length === 0) {
      throw MobileContractError.of(
        'services',
        'no_services',
        'Pick at least one service.',
      );
    }
    if (cmd.status !== 'BOOKED') {
      throw MobileContractError.of(
        'status',
        'invalid_status',
        'Only BOOKED may be sent on create.',
      );
    }
    if (cmd.paymentStatus !== 'DRAFT') {
      throw MobileContractError.of(
        'payment_status',
        'invalid_payment_status',
        'Only DRAFT may be sent on create.',
      );
    }
    if (!stylistsLineUp(cmd.stylists, cmd.services)) {
      throw MobileContractError.of(
        'stylists',
        'invalid_stylists',
        'Send one stylist for the whole visit, or exactly one per service in the same order.',
      );
    }

    // ---- 2. Time ---------------------------------------------------------
    const start = toBranchMoment(cmd.startTime, BRANCH_UTC_OFFSET_MIN);
    const end = toBranchMoment(cmd.endTime, BRANCH_UTC_OFFSET_MIN);
    if (start === null || end === null) {
      throw MobileContractError.of(
        'start_time',
        'invalid_window',
        'start_time and end_time must be ISO 8601 instants.',
      );
    }
    if (!dateAgreesWithStart(cmd.date, start)) {
      throw MobileContractError.of(
        'date',
        'date_mismatch',
        `date says ${cmd.date} and start_time is ${start.tradingDay} in salon time.`,
      );
    }

    // ---- 3. The services must exist at this salon ------------------------
    const known = await this.context.loadServices(cmd.salonId, serviceIds);
    if (known.length !== serviceIds.length) {
      const found = new Set(known.map((s) => s.id));
      throw MobileContractError.of(
        'services',
        'unknown_service',
        `Not sold at this salon: ${serviceIds.filter((i) => !found.has(i)).join(', ')}.`,
      );
    }

    // ---- 4. Money is VERIFIED, never trusted (§3) ------------------------
    //
    // Recomputed by the same handler the desk quote uses, so the figure the
    // app is checked against is the figure the booking will actually charge.
    const quote = await this.quotes.execute({
      branchId: cmd.salonId,
      tradingDay: start.tradingDay,
      serviceIds,
      customerId: cmd.customerId,
      channel: 'online',
      startMin: start.minuteOfDay,
    });

    this.verifyMoney(cmd, quote);

    const declaredEnd = start.minuteOfDay + quote.durationMin;
    if (end.minuteOfDay !== declaredEnd) {
      throw MobileContractError.of(
        'end_time',
        'invalid_window',
        `These services run ${quote.durationMin} minutes, so the visit ends at ` +
          `${branchInstant(start.tradingDay, declaredEnd).toISOString()}.`,
      );
    }

    // ---- 5. Hold, confirm, link -- releasing the hold if anything fails --
    // THE HOLD IS TRANSLATED TOO. It was not, at first, and every refusal
    // the engine raises BEFORE the booking exists -- an unavailable stylist,
    // a taken slot, a missing skill -- escaped in this service's envelope
    // instead of the contract's. The app would have received a shape it does
    // not parse for the most common failure of all.
    //
    // No release in this catch: there is no hold to give back.
    let hold;
    try {
      hold = await this.holds.execute({
        branchId: cmd.salonId,
        customerId: cmd.customerId,
        tradingDay: start.tradingDay,
        serviceIds,
        startMin: start.minuteOfDay,
        channel: 'online',
        preferredStaffId: cmd.stylists[0] ?? null,
      });
    } catch (e) {
      throw translate(e);
    }

    try {
      const booking = await this.confirms.execute({
        holdId: hold.holdId,
        branchId: cmd.salonId,
        customerId: cmd.customerId,
        tradingDay: start.tradingDay,
        serviceIds,
        channel: 'online',
        // LINK is what puts the booking at PENDING_PAYMENT with a window on
        // it, which is the contract's DRAFT: created, slot held, nothing
        // settled, and released if nobody pays (§4).
        payment: { amountFils: quote.depositMinor, rail: 'link' },
        actorId: cmd.customerId,
        /**
         * NAMESPACED, and it has to be.
         *
         * The interceptor stores this request's response under the bare
         * key; confirm stores ITS response under whatever it is given. Hand
         * confirm the same string and the two collide on a unique column:
         * confirm wins the row, the interceptor's write is swallowed, and
         * the retry then finds a row whose fingerprint is confirm's rather
         * than ours and answers 409 IDEMPOTENCY_KEY_REUSED -- a client bug
         * that was really ours.
         *
         * Two namespaces, two rows, and both layers stay protected: confirm
         * still refuses to run its transaction twice even if the
         * interceptor's bookkeeping fails.
         */
        ...(cmd.idempotencyKey === undefined
          ? {}
          : { idempotencyKey: `mobile:${cmd.idempotencyKey}` }),
      });

      const link = await this.links.execute(booking.bookingId, {
        kind: 'customer',
        id: cmd.customerId,
      });

      return this.present(cmd, booking.bookingId, link.expiresAt, quote);
    } catch (e) {
      // The hold is ours and the booking is not going to exist. Give the
      // slot back now rather than leaving it dark until the sweeper runs.
      await this.holds.release(hold.holdId).catch(() => undefined);
      MobileBookingHandler.log.warn(
        `mobile create failed after hold ${hold.holdId}; slot released`,
      );
      throw translate(e);
    }
  }

  /**
   * §3, figure by figure.
   *
   * Reported as a FIELD error carrying the correct number, because the app's
   * job on a mismatch is to show the customer what changed -- "prices moved"
   * with no new price is a dead end.
   */
  private verifyMoney(
    cmd: MobileBookingCommand,
    quote: Awaited<ReturnType<GetQuoteHandler['execute']>>,
  ): void {
    const claim = (field: string, value: number): number => {
      const fils = aedToFils(value);
      if (fils === null) {
        throw MobileContractError.of(
          field,
          'amount_mismatch',
          'Amounts are decimal with at most two places.',
        );
      }
      return fils;
    };

    const checks: readonly [string, number, number][] = [
      [
        'amount_without_tax',
        claim('amount_without_tax', cmd.amountWithoutTax),
        quote.subtotalMinor,
      ],
      ['tax_amount', claim('tax_amount', cmd.taxAmount), quote.vatMinor],
      [
        'discount',
        claim('discount', cmd.discount),
        quote.tierDiscountMinor + quote.bundleDiscountMinor,
      ],
      ['total', claim('total', cmd.total), quote.totalMinor],
    ];

    for (const [field, claimed, expected] of checks) {
      if (!amountsAgree(expected, claimed)) {
        throw MobileContractError.of(
          field,
          'amount_mismatch',
          'Prices changed since this booking was started.',
          filsToAed(expected),
        );
      }
    }

    // §2: nothing is paid until the gateway answers.
    if (claim('advance_paid_amount', cmd.advancePaidAmount) !== 0) {
      throw MobileContractError.of(
        'advance_paid_amount',
        'amount_mismatch',
        'Nothing is paid on create; record the payment with PATCH once the gateway answers.',
        0,
      );
    }
    if (!amountsAgree(quote.totalMinor, claim('due_amount', cmd.dueAmount))) {
      throw MobileContractError.of(
        'due_amount',
        'amount_mismatch',
        'due_amount is total minus advance_paid_amount, so it equals total on create.',
        filsToAed(quote.totalMinor),
      );
    }
  }

  /** §8, read back from what was actually stored. */
  async present(
    cmd: Pick<MobileBookingCommand, 'salonId' | 'promoCode'>,
    bookingId: string,
    linkExpiresAt: string | null,
    /**
     * THE MONEY COMES FROM THE QUOTE, not the booking row.
     *
     * `booking.price_fils` is the NET total and the only money on the row;
     * tax and discount are computed, not stored. Re-deriving them here from
     * the price would be a second copy of the arithmetic that could disagree
     * with what was charged, so the figures the app receives are the ones
     * the quote produced and the confirm was checked against.
     */
    quote: Awaited<ReturnType<GetQuoteHandler['execute']>>,
  ): Promise<unknown> {
    const b = await this.bookings.detail(bookingId);
    if (b === null) throw new NotFoundException('No such booking');

    const day = b.tradingDay.toISOString().slice(0, 10);
    const endMin = b.startMinute + b.durationMin;

    // The roster speaks slugs and the columns hold the folded uuid, so every
    // id going back out is spelled the way the app sent it in (CLAUDE.md 8).
    let names = new Map<string, { name: string; avatar: string | null }>();
    let index = new SlugIndex([]);
    try {
      const [ctx, catalogue] = await Promise.all([
        this.context.loadDay(cmd.salonId, day),
        this.context.loadCatalogue(cmd.salonId),
      ]);
      // Staff AND services: the app sent "haircut-finish" and must get
      // "haircut-finish" back, not the folded uuid the column holds
      // (CLAUDE.md 8).
      index = new SlugIndex([
        ...ctx.professionals.map((p) => p.id),
        ...catalogue.map((c) => c.id),
      ]);
      names = new Map(
        ctx.professionals.map((p) => [p.id, { name: p.name, avatar: null }]),
      );
    } catch {
      // A name is decoration; the booking is real either way.
    }

    const stylistIds = [
      ...new Set(
        b.items
          .map((i) => i.staffId)
          .filter((x): x is string => x !== null)
          .map((id) => index.toSlug(id)),
      ),
    ];

    return {
      id: b.id,
      salon_id: cmd.salonId,
      status: toMobileStatus(b.status),
      /**
       * OUR OWN WORD, ALONGSIDE. `BOOKED` covers both states that mean
       * "waiting", so the app can render one pill while support can still
       * tell which of the two a booking is actually in.
       */
      status_detail: b.status.toUpperCase(),
      date: day,
      start_time: toOffsetIso(
        branchInstant(day, b.startMinute),
        BRANCH_UTC_OFFSET_MIN,
      ),
      end_time: toOffsetIso(branchInstant(day, endMin), BRANCH_UTC_OFFSET_MIN),
      services: b.items.map((i) => ({
        id: index.toSlug(i.serviceId),
        name: i.serviceName,
        amount: filsToAed(i.priceFils),
      })),
      // Refused on the way in, so always empty on the way out.
      products: [],
      stylists: stylistIds.map((id) => ({
        id,
        name: names.get(id)?.name ?? null,
        avatar_url: names.get(id)?.avatar ?? null,
      })),
      amount_without_tax: filsToAed(quote.subtotalMinor),
      tax_amount: filsToAed(quote.vatMinor),
      discount: filsToAed(quote.tierDiscountMinor + quote.bundleDiscountMinor),
      total: filsToAed(quote.totalMinor),
      promo_code: cmd.promoCode,
      advance_paid_amount: 0,
      due_amount: filsToAed(quote.totalMinor),
      payment_status: toMobilePaymentStatus(b.paymentStatus),
      payment_status_detail: b.paymentStatus.toUpperCase(),
      payment_method: null,
      /** §6: the server issues it, and it is the booking's own code. */
      pass_qr_code: b.code,
      /** §10.3: present while the draft hold is running, gone once paid. */
      expires_at:
        linkExpiresAt === null
          ? null
          : toOffsetIso(new Date(linkExpiresAt), BRANCH_UTC_OFFSET_MIN),
      created_at: toOffsetIso(b.createdAt, BRANCH_UTC_OFFSET_MIN),
    };
  }
}

/**
 * Engine refusals, in the app's vocabulary.
 *
 * The engine answers with OUR codes and prose written for a desk operator.
 * §9 gives this endpoint its own list, and `slot_taken` in particular has to
 * be distinguishable: it is a RACE, not a mistake, and the app's response is
 * to send the customer back to the picker rather than highlight a field.
 *
 * Anything unrecognised is rethrown untouched. A refusal nobody mapped
 * should surface as itself rather than as a plausible-looking
 * `validation_error` that sends the app down the wrong branch.
 */
function translate(e: unknown): unknown {
  if (isMobileContractError(e)) return e;

  const code = isBookingError(e) ? e.code : null;
  const message = e instanceof Error ? e.message : String(e);

  switch (code) {
    case 'BOOKING_SLOT_TAKEN':
    case 'BOOKING_CAPACITY_BLOCKED':
    case 'BOOKING_HOLD_EXPIRED':
      return MobileContractError.slotTaken(message);
    case 'BOOKING_SKILL_MISSING':
      return MobileContractError.of(
        'stylists',
        'stylist_missing_skill',
        message,
      );
    case 'BOOKING_STAFF_UNAVAILABLE':
      return MobileContractError.of('stylists', 'stylist_unavailable', message);
    default:
      return e;
  }
}

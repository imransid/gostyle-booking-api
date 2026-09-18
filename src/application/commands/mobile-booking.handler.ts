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
  toUuid,
} from '@infrastructure/persistence/hold.repository';
import { MobilePaymentRepository } from '@infrastructure/persistence/mobile-payment.repository';
import { TenantContext } from '@infrastructure/tenancy/tenant-context';
import { SlugIndex } from '@infrastructure/persistence/slug-uuid';
import { DEFAULT_BRANCH_ID } from '@infrastructure/tenancy/branch-context';
import {
  aedToFils,
  amountsAgree,
  checkPatch,
  methodToRail,
  paymentStatusAfterPatch,
  type MobilePaymentMethod,
  type PatchTarget,
  dateAgreesWithStart,
  filsToAed,
  createIntentOf,
  refuseUnsupported,
  stylistsLineUp,
  toBranchMoment,
  toMobilePaymentStatus,
  toMobileStatus,
  toOffsetIso,
  railToMethod,
} from '@domain/booking/mobile-contract';
import {
  MobileContractError,
  isMobileContractError,
} from './mobile-booking.error';
import { isBookingError } from '@application/contract/errors';
import type { ListFilter } from '@domain/booking/booking-shelf';
import { storedTotalFils } from '@domain/booking/stored-money';

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

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * What `quoteFor` actually reads off a booking.
 *
 * Structural, not `detail()`'s row type: the list fetches the same booking
 * WITHOUT `statusHistory`, which no quote has ever looked at, and typing the
 * parameter to the drawer's query would force the list to fetch an unbounded
 * relation to satisfy the compiler.
 */
interface QuotableBooking {
  readonly branchId: string;
  readonly tradingDay: Date;
  readonly customerId: string;
  readonly startMinute: number;
  readonly items: readonly { readonly serviceId: string }[];
}

/**
 * The contract's three badges, from the repository's two shelves.
 *
 * ONE PLACE, because every response carries this object and a second spot
 * that built it would be the one that forgot a key. `recurring` is 0 until
 * series are wired -- a real count of a real, empty shelf.
 */
function withRecurring(counts: {
  readonly upcoming: number;
  readonly archive: number;
}): { upcoming: number; recurring: number; archive: number } {
  return { upcoming: counts.upcoming, recurring: 0, archive: counts.archive };
}

/** The money columns a booking carries when the catalogue cannot price it. */
interface StoredMoney {
  readonly id: string;
  /** The tenant the booking was written under. Scopes its own catalogue. */
  readonly tenantId: string | null;
  readonly netFils: number | null;
  readonly taxFils: number | null;
  readonly discountFils: number | null;
  readonly depositFils: number;
}

/**
 * A booking's figures, however they were arrived at.
 *
 * `priced` says WHICH: true when the live quote produced them, false when
 * they came off the row because the catalogue could not price the booking.
 * Callers that must not act on a stale figure check it; §8's read simply
 * reports what it has.
 */
interface BookingMoney {
  readonly subtotalFils: number | null;
  readonly vatFils: number;
  readonly discountFils: number;
  readonly totalFils: number | null;
  readonly depositFils: number;
  readonly priced: boolean;
}

/** One branch's names, resolved once per page rather than once per row. */
interface BranchNames {
  readonly index: SlugIndex;
  readonly staff: ReadonlyMap<string, { name: string; avatar: string | null }>;
}

/** What a branch looks like when platform could not be reached. */
const EMPTY_BRANCH: BranchNames = {
  index: new SlugIndex([]),
  staff: new Map(),
};

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
    private readonly payments: MobilePaymentRepository,
    private readonly tenants: TenantContext,
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
    /**
     * Two arrangements, decided here and carried to the end of the method.
     *
     * PARTIALLY and FULLY_PAID stay out: money that has already moved is
     * recorded through §11 against a booking that exists, not declared as
     * a fact at creation time by the client.
     */
    const intent = createIntentOf(cmd.paymentStatus);
    if (intent === null) {
      throw MobileContractError.of(
        'payment_status',
        'invalid_payment_status',
        'Only DRAFT or PAY_AFTER_CHECK_IN may be sent on create. ' +
          'PARTIALLY and FULLY_PAID are recorded later, through PATCH.',
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
      const missing = serviceIds.filter((i) => !found.has(i));

      /**
       * SAY WHICH CATALOGUE SAID NO.
       *
       * This was reported as "ListServices returns that service, so why is
       * the booking API refusing it" -- and the answer is that this path
       * never calls ListServices. BOOKING_CONTEXT resolves services from the
       * FIXTURE (DbBookingContext.loadServices delegates straight to it),
       * while the gRPC services directory is wired only to
       * GET /v1/services-directory/services. Two catalogues, and the one
       * that refuses is invisible from outside.
       *
       * Logging what was asked for against what the resolver actually holds
       * turns a day of comparing grpcurl output into one line.
       */
      const catalogue = await this.context
        .loadCatalogue(cmd.salonId)
        .catch(() => [] as { id: string }[]);
      MobileBookingHandler.log.warn(
        `unknown_service at salon ${cmd.salonId}: asked for ` +
          `[${serviceIds.join(', ')}]; BOOKING_CONTEXT knows ` +
          `${catalogue.length} service(s) [${catalogue
            .map((c) => c.id)
            .join(', ')}]. This resolver is NOT the gRPC services ` +
          'directory -- ListServices is not consulted on this path.',
      );

      throw MobileContractError.of(
        'services',
        'unknown_service',
        `Not sold at this salon: ${missing.join(', ')}.`,
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
        /**
         * LINK is what puts the booking at PENDING_PAYMENT with a window on
         * it, which is the contract's DRAFT: created, slot held, nothing
         * settled, and released if nobody pays (§4).
         *
         * PAY_AFTER_CHECK_IN OMITS `payment` ENTIRELY, and that is not a
         * shortcut -- it is the existing no-requirement path. Table 8.8 in
         * booking.repository already answers a null payment with
         * { confirmed, none_required }, which is exactly what this
         * arrangement means: nothing collected, slot held outright, no
         * window, nothing for the PaymentLinkSweeper to find (it takes
         * only status = 'pending_payment' AND link_expires_at IS NOT NULL,
         * and this booking fails both).
         *
         * IT DOES NOT BYPASS THE DEPOSIT LADDER. Omitting payment tenders
         * zero, and confirm refuses with 402 when the ladder asked for
         * more. A customer cannot waive a required deposit by asking for
         * this status; only a service that requires nothing can use it.
         */
        ...(intent.kind === 'link'
          ? {
              payment: {
                amountFils: quote.depositMinor,
                rail: 'link' as const,
              },
            }
          : {}),
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

      /**
       * NO LINK FOR AN ON-ARRIVAL BOOKING. There is nothing to pay now, so
       * a payment page would be a page asking for zero, and the
       * `expires_at` it returned would tell the app the slot is about to
       * lapse when it is confirmed and permanent.
       */
      const expiresAt =
        intent.kind === 'link'
          ? (
              await this.links.execute(booking.bookingId, {
                kind: 'customer',
                id: cmd.customerId,
              })
            ).expiresAt
          : null;

      // A freshly quoted booking, so the figures are the quote's own.
      return this.present(cmd, booking.bookingId, expiresAt, {
        subtotalFils: quote.subtotalMinor,
        vatFils: quote.vatMinor,
        discountFils: quote.tierDiscountMinor + quote.bundleDiscountMinor,
        totalFils: quote.totalMinor,
        depositFils: quote.depositMinor,
        priced: true,
      });
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

  /**
   * §10: read one booking.
   *
   * 404, NEVER 403, for a booking the caller may not see. §10.1 is explicit
   * and the reason is worth keeping: a 403 confirms that a booking id
   * exists, which is exactly what someone enumerating ids is trying to
   * learn. "No" and "not yours" have to be indistinguishable from outside.
   */
  async read(input: {
    readonly bookingId: string;
    readonly actorId: string;
    readonly actorKind: string;
    readonly actorBranchId: string | null;
  }): Promise<unknown> {
    const b = await this.visibleOrNotFound(input);

    const money = await this.moneyFor(b);

    // Scoped too: `present` resolves the staff and service names, and both
    // of those lookups are tenant-scoped exactly as the catalogue is.
    return this.inBookingTenant(b, () =>
      this.present(
        { salonId: b.branchId, promoCode: null },
        b.id,
        // §10.3: present while the draft hold is still running, gone once
        // the booking is paid -- exactly when the column is cleared.
        b.linkExpiresAt === null ? null : b.linkExpiresAt.toISOString(),
        money,
      ),
    );
  }

  /**
   * booking-list.md §1: one shelf of the caller's own bookings.
   *
   * THE CUSTOMER COMES FROM THE TOKEN. There is no customerId parameter and
   * there must never be one -- a list endpoint that takes whose list to show
   * is an enumeration of every booking in the system behind one valid login.
   *
   * ROWS ARE SUMMARIES (§3), but the two figures on them are not summaries
   * of anything: `total` and `due_amount` are the numbers the customer is
   * about to pay, and they go through the SAME quote the drawer does. A
   * cheaper total read off `price_fils` would be the NET figure while the
   * drawer showed the one with VAT in it, and the customer would be looking
   * at two prices for one haircut. The page is capped at 50 for that reason
   * -- each row costs a quote.
   *
   * `salon`, `can_cancel` and `can_reschedule` are NOT here. See
   * booking-list.md §9: a booking stores `branch_id` and nothing else, and
   * the cancellation policy lives in platform. `salon_id` is returned so the
   * caller can resolve all three; gostyle-customer-api does exactly that on
   * the way out, because it reads the platform tables directly.
   */
  async list(input: {
    readonly customerId: string;
    readonly filter: ListFilter;
    readonly page: number;
    readonly pageSize: number;
  }): Promise<unknown> {
    /**
     * NOTHING CAN LAND ON `recurring` YET, and this answers it without
     * touching the database. The tab exists in the app; a booking only
     * reaches it by belonging to a series, and the mobile create path
     * refuses ROUTINE outright (`refuseUnsupported`). An empty page is the
     * true answer, and it is a different answer from 422.
     */
    if (input.filter === 'recurring') {
      return {
        count: 0,
        page: input.page,
        page_size: input.pageSize,
        counts: await this.shelfCounts(input.customerId),
        results: [],
      };
    }

    const { rows, count, counts } = await this.bookings.customerPage({
      customerId: input.customerId,
      shelf: input.filter,
      // §2.4 measures "past" against the salon's clock. The instant is the
      // same one either way -- branchInstant and endAt are both absolute --
      // so a customer abroad sees the same shelf as one standing outside.
      now: new Date(),
      page: input.page,
      pageSize: input.pageSize,
    });

    /**
     * THE CATALOGUE AND ROSTER ARE LOADED ONCE PER BRANCH, not once per
     * row. A customer's page is usually one or two salons, and loading the
     * day for each of twenty rows separately is twenty round trips to
     * render one screen.
     */
    /**
     * ONE LOOKUP PER (BRANCH, DAY), and BOTH halves of that key were bugs.
     *
     * TENANT: `moneyFor` was scoped to the booking's tenant and the names
     * were not, so a list came back fully priced with every stylist called
     * `null` -- the roster lookup found nothing without a tenant, exactly as
     * the catalogue did.
     *
     * DAY: the roster is resolved per trading day (`rosterFor` asks platform
     * who is bookable ON that date), and this loaded TODAY for every row. A
     * list is mostly future bookings, so the stylist working next Monday was
     * absent from today's roster and came back nameless anyway.
     *
     * Keyed rather than per row: a page is a handful of days at one or two
     * salons, and loading per booking would be twenty round trips to draw
     * one screen.
     */
    const byDay = new Map<
      string,
      { branchId: string; day: string; tenantId: string | null }
    >();
    for (const b of rows) {
      const day = b.tradingDay.toISOString().slice(0, 10);
      const key = `${b.branchId}|${day}`;
      if (!byDay.has(key)) {
        byDay.set(key, { branchId: b.branchId, day, tenantId: b.tenantId });
      }
    }
    const context = new Map(
      await Promise.all(
        [...byDay].map(
          async ([key, { branchId, day, tenantId }]) =>
            [
              key,
              await this.inBookingTenant({ tenantId }, () =>
                this.branchNames(branchId, day),
              ),
            ] as const,
        ),
      ),
    );

    const results = await Promise.all(
      rows.map(async (b) => {
        const totalFils = (await this.moneyFor(b)).totalFils;
        const captured = b.ledger
          .filter((l) => l.entryType === 'captured')
          .reduce((n, l) => n + l.amountFils, 0);

        const day = b.tradingDay.toISOString().slice(0, 10);
        const names = context.get(`${b.branchId}|${day}`) ?? EMPTY_BRANCH;
        const stylistIds = [
          ...new Set(
            b.items
              .map((i) => i.staffId)
              .filter((x): x is string => x !== null)
              .map((id) => names.index.toSlug(id)),
          ),
        ];

        return {
          id: b.id,
          /** The slug the app sent in, never the folded uuid (CLAUDE.md 8). */
          salon_id: names.index.toSlug(b.branchId),
          status: toMobileStatus(b.status),
          payment_status: toMobilePaymentStatus(b.paymentStatus),
          booking_type: b.bookingType.toUpperCase(),
          date: day,
          start_time: toOffsetIso(
            branchInstant(day, b.startMinute),
            BRANCH_UTC_OFFSET_MIN,
          ),
          end_time: toOffsetIso(
            branchInstant(day, b.startMinute + b.durationMin),
            BRANCH_UTC_OFFSET_MIN,
          ),
          /** §3: `{ id, name }` only. The amounts are the drawer's job. */
          services: b.items.map((i) => ({
            id: names.index.toSlug(i.serviceId),
            name: i.serviceName,
          })),
          stylists: stylistIds.map((id) => ({
            id,
            name: names.staff.get(id)?.name ?? null,
            avatar_url: names.staff.get(id)?.avatar ?? null,
          })),
          total: totalFils === null ? null : filsToAed(totalFils),
          due_amount:
            totalFils === null
              ? null
              : filsToAed(Math.max(0, totalFils - captured)),
          created_at: toOffsetIso(b.createdAt, BRANCH_UTC_OFFSET_MIN),
        };
      }),
    );

    return {
      count,
      page: input.page,
      page_size: input.pageSize,
      /**
       * ALL THREE BADGES, ALWAYS. The repository knows two shelves; the app
       * draws three chips and reads this object by key. Returning
       * `{upcoming, archive}` here left the third one `undefined`, which
       * renders as an empty badge rather than a zero -- caught by calling
       * the endpoint, not by a test that mocked this body.
       */
      counts: withRecurring(counts),
      results,
    };
  }

  /**
   * The badge numbers alone, for the one filter that never queries a page.
   *
   * Counted through the same `customerPage` the list uses rather than a
   * second set of predicates -- the badge and the tab it opens have to
   * agree, and two queries for one question is how they stop agreeing.
   */
  private async shelfCounts(
    customerId: string,
  ): Promise<{ upcoming: number; recurring: number; archive: number }> {
    const { counts } = await this.bookings.customerPage({
      customerId,
      shelf: 'upcoming',
      now: new Date(),
      page: 1,
      // Nothing reads the rows; asking for none keeps this two COUNTs.
      pageSize: 0,
    });
    return withRecurring(counts);
  }

  /**
   * Staff names and the slug index for one branch.
   *
   * A NAME IS DECORATION AND THE BOOKING IS REAL EITHER WAY -- the same
   * bargain `present` makes. A platform that is down must not empty a
   * customer's booking history; it may only leave the names off it.
   */
  private async branchNames(
    branchId: string,
    /**
     * THE BOOKING'S OWN DAY, not today. `rosterFor` asks platform who is
     * bookable ON this date, so today's roster does not contain the stylist
     * working next Monday -- and a list is mostly future bookings.
     */
    tradingDay: string,
  ): Promise<BranchNames> {
    try {
      const [roster, catalogue] = await Promise.all([
        this.context.loadDay(branchId, tradingDay),
        this.context.loadCatalogue(branchId),
      ]);
      return {
        index: new SlugIndex([
          ...roster.professionals.map((p) => p.id),
          ...catalogue.map((c) => c.id),
          DEFAULT_BRANCH_ID,
        ]),
        staff: new Map(
          roster.professionals.map((p) => [
            p.id,
            { name: p.name, avatar: null },
          ]),
        ),
      };
    } catch {
      return EMPTY_BRANCH;
    }
  }

  /**
   * §11: record what the gateway took.
   *
   * The rules are in `checkPatch`; this resolves the inputs they need and
   * turns the outcome into the contract's words.
   */
  async recordPayment(input: {
    readonly bookingId: string;
    readonly actorId: string;
    readonly actorKind: string;
    readonly actorBranchId: string | null;
    readonly paymentStatus: string;
    readonly paymentMethod: MobilePaymentMethod | null;
    readonly advancePaidAmount: number;
    readonly dueAmount: number | null;
    readonly paymentReference: string | null;
  }): Promise<unknown> {
    const b = await this.visibleOrNotFound(input);

    const advance = aedToFils(input.advancePaidAmount);
    if (advance === null) {
      throw MobileContractError.of(
        'advance_paid_amount',
        'amount_mismatch',
        'Amounts are decimal with at most two places.',
      );
    }
    const due = input.dueAmount === null ? null : aedToFils(input.dueAmount);
    if (input.dueAmount !== null && due === null) {
      throw MobileContractError.of(
        'due_amount',
        'amount_mismatch',
        'Amounts are decimal with at most two places.',
      );
    }

    const money = await this.moneyFor(b);

    /**
     * MONEY IS NEVER CHECKED AGAINST A FIGURE WE DO NOT HAVE.
     *
     * `moneyFor` falls back to the stored breakdown, which is what the
     * customer agreed to, and that is a sound bar to check a payment
     * against. But a booking with NO stored breakdown and no quote has no
     * total at all, and accepting a payment against an unknown total would
     * record whatever the client claimed. Refused as a field error the app
     * can show, not as a 404 naming a service.
     */
    if (money.totalFils === null) {
      throw MobileContractError.of(
        'advance_paid_amount',
        'amount_mismatch',
        'This booking cannot be priced right now, so a payment cannot be ' +
          'checked against it. Please try again shortly.',
      );
    }

    const refusal = checkPatch({
      target: input.paymentStatus,
      method: input.paymentMethod,
      advancePaidFils: advance,
      dueFils: due,
      reference: input.paymentReference,
      totalFils: money.totalFils,
      // The bar the ladder set for THIS booking, not a global minimum.
      requiredDepositFils: money.depositFils,
    });
    if (refusal !== null) {
      throw MobileContractError.of(
        refusal.field,
        refusal.code,
        refusal.message,
        refusal.expected,
      );
    }

    const target = input.paymentStatus as PatchTarget;
    const outcome = await this.payments.record({
      bookingId: b.id,
      customerId: input.actorId,
      amountFils: advance,
      rail: (input.paymentMethod === null
        ? 'internal'
        : methodToRail(input.paymentMethod)) as never,
      reference: input.paymentReference,
      paymentStatus: paymentStatusAfterPatch(target),
    });

    switch (outcome.kind) {
      case 'not_found':
        throw MobileContractError.notFoundBooking();
      case 'already_paid':
        /**
         * The code stays `already_paid` because §11 defines it as "not in
         * DRAFT", and a PAY_AFTER_CHECK_IN booking is not in DRAFT. The
         * MESSAGE must not, though: "this booking is already
         * none_required" is not English and tells nobody what to do next.
         */
        throw MobileContractError.alreadyPaid(
          outcome.paymentStatus === 'none_required'
            ? 'This booking pays on arrival, so there is nothing to record ' +
                'here. Take the money at the desk, which writes it to the ' +
                'ledger against this booking.'
            : `This booking is already ${outcome.paymentStatus}. Refunds ` +
                'and top-ups are their own endpoints.',
        );
      case 'expired':
        throw MobileContractError.bookingExpired(
          'The draft hold expired before the payment was recorded.',
        );
      case 'replayed':
      case 'recorded':
        break;
    }

    return this.inBookingTenant(b, () =>
      this.present(
        { salonId: b.branchId, promoCode: null },
        b.id,
        // Paid, so the draft window is gone (§10.3, §11.4).
        null,
        // The same figures the payment was just checked against, so the
        // response cannot report a total the check did not use.
        money,
      ),
    );
  }

  /**
   * §10.1: the customer who owns it, or staff of the salon it belongs to.
   *
   * EVERYTHING ELSE IS 404, INCLUDING "not yours". A 403 confirms the id
   * exists, which is exactly what someone walking the id space is trying to
   * learn -- so "no such booking" and "not yours" have to be
   * indistinguishable from outside.
   *
   * A malformed id is 404 for the same reason, and because the alternative
   * is a 500 from the uuid cast.
   *
   * THE BRANCH IS CHECKED, not just the actor kind. The first version let
   * ANY staff token read ANY booking, which is a different salon's diary.
   * A null branchId on the token means all branches -- that is what a
   * company owner carries, and it is deliberate.
   */
  private async visibleOrNotFound(input: {
    readonly bookingId: string;
    readonly actorId: string;
    readonly actorKind: string;
    readonly actorBranchId: string | null;
  }): Promise<NonNullable<Awaited<ReturnType<BookingRepository['detail']>>>> {
    const b = UUID_RE.test(input.bookingId)
      ? await this.bookings.detail(input.bookingId)
      : null;
    if (b === null) throw MobileContractError.notFoundBooking();

    const visible =
      input.actorKind === 'customer'
        ? b.customerId === toUuid(input.actorId)
        : input.actorBranchId === null ||
          b.branchId === toUuid(input.actorBranchId);

    if (!visible) throw MobileContractError.notFoundBooking();
    return b;
  }

  /**
   * The money a booking is worth, recomputed.
   *
   * The row stores a NET price and nothing else; tax, discount and the
   * deposit requirement are computed. Re-deriving them from the price here
   * would be a second copy of the arithmetic that could disagree with what
   * was charged, so both reads go back through the quote handler.
   */
  private async quoteFor(
    b: QuotableBooking,
  ): Promise<Awaited<ReturnType<GetQuoteHandler['execute']>>> {
    return this.quotes.execute({
      branchId: b.branchId,
      tradingDay: b.tradingDay.toISOString().slice(0, 10),
      serviceIds: b.items.map((i) => i.serviceId),
      customerId: b.customerId,
      channel: 'online',
      startMin: b.startMinute,
    });
  }

  /**
   * What a booking is worth, from the quote if it can be had and from the
   * booking's own columns if it cannot.
   *
   * THE BUG THIS EXISTS FOR. `read` and `recordPayment` both asked the quote
   * handler to price the booking again, and that handler resolves every
   * service against the LIVE catalogue and throws `Unknown service` for one
   * it cannot find. So a booking that already exists, with money owed on it,
   * answered `404 BOOKING_NOT_FOUND` to both "show me my booking" and "here
   * is the payment" — the customer could neither see it nor pay for it, and
   * the message named a service rather than saying the price could not be
   * worked out.
   *
   * A service stops resolving for ordinary reasons: it is retired, renamed,
   * moved between branches, or the request reached us without the tenant the
   * catalogue lookup needs. None of those should make a booking unreadable.
   *
   * THE FALLBACK IS WHAT THE CUSTOMER AGREED TO. `net/tax/discount` are the
   * breakdown stored at creation, and create verified them against the quote
   * before writing them, so the two agree wherever both exist. The deposit
   * comes from `deposit_fils`, which is the bar the ladder set for THIS
   * booking — better than a fresh quote's, which could have moved since.
   *
   * NULL WHEN EVEN THAT IS ABSENT, never a guess. `price_fils` is the NET
   * total with no VAT in it; reporting it as the total would understate
   * every figure by the tax, and understating what someone owes is worse
   * than admitting the number is unavailable.
   */
  private async moneyFor(
    b: StoredMoney & QuotableBooking,
  ): Promise<BookingMoney> {
    try {
      const quote = await this.inBookingTenant(b, () => this.quoteFor(b));
      return {
        subtotalFils: quote.subtotalMinor,
        vatFils: quote.vatMinor,
        discountFils: quote.tierDiscountMinor + quote.bundleDiscountMinor,
        totalFils: quote.totalMinor,
        depositFils: quote.depositMinor,
        priced: true,
      };
    } catch (e) {
      const net = b.netFils;
      // The arithmetic lives in the domain with its own spec, not inline
      // here: it decides what a customer is told they owe (CLAUDE.md 1, 4).
      const total = storedTotalFils(b);

      MobileBookingHandler.log.warn(
        `Booking ${b.id}: no quote (${
          e instanceof Error ? e.message : String(e)
        }); ${total === null ? 'and no stored breakdown either' : 'falling back to the stored breakdown'}.`,
      );

      return {
        subtotalFils: net,
        vatFils: b.taxFils ?? 0,
        discountFils: b.discountFils ?? 0,
        totalFils: total,
        // The row's own requirement, which is what confirm actually enforced.
        depositFils: b.depositFils,
        priced: false,
      };
    }
  }

  /**
   * Run something with the BOOKING's tenant in scope, not the request's.
   *
   * WHY A READ SHOULD NOT NEED A HEADER. The service catalogue is
   * tenant-scoped, and `TenantContext` is filled from `X-Tenant-Id` on the
   * way in. On a create that is fine — the caller names the salon, so the
   * tenant can be derived from it. On `GET /booking/:id` and `PATCH` the
   * caller holds only a booking id, and there is no way to know a tenant
   * from one. Without the header the catalogue lookup found nothing and
   * every service looked retired, so a booking that existed answered
   * `404 Unknown service` to both reading and paying.
   *
   * The booking itself records the tenant it was written under, which is a
   * better answer than a header the caller had to guess. Used only when the
   * request carried none: a header that IS present belongs to a caller who
   * knows their own tenancy, and overriding it here would let this method
   * decide whose catalogue a booking is priced against.
   */
  private inBookingTenant<T>(
    b: { readonly tenantId: string | null },
    fn: () => Promise<T>,
  ): Promise<T> {
    if (this.tenants.current() !== null || b.tenantId === null) return fn();
    return this.tenants.run(b.tenantId, fn);
  }

  /** §8, read back from what was actually stored. */
  async present(
    cmd: Pick<MobileBookingCommand, 'salonId' | 'promoCode'>,
    bookingId: string,
    linkExpiresAt: string | null,
    /**
     * THE MONEY, however it was arrived at.
     *
     * Was a raw quote. It is now `moneyFor`'s shape, because a booking whose
     * service the catalogue can no longer price must still be readable: this
     * endpoint used to answer 404 for one, naming the service, which left a
     * customer unable to see or pay a booking that plainly existed.
     */
    money: BookingMoney,
  ): Promise<unknown> {
    const b = await this.bookings.detail(bookingId);
    if (b === null) throw new NotFoundException('No such booking');

    const day = b.tradingDay.toISOString().slice(0, 10);
    const endMin = b.startMinute + b.durationMin;

    /**
     * The captures, and the rail the last one came in on.
     *
     * `captured` only -- a refund or a forfeit is money leaving again, and
     * `advance_paid_amount` is what the customer HANDED OVER. The two are
     * different questions and the ledger keeps both.
     */
    const captures = b.ledger.filter((l) => l.entryType === 'captured');
    const captured = captures.reduce((n, l) => n + l.amountFils, 0);
    const paidRail = captures[captures.length - 1]?.rail ?? null;

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
      /**
       * THE SALON IS IN HERE TOO.
       *
       * `booking.branch_id` holds toUuid('marina-walk'), and the read was
       * publishing that hash while `services[].id` and `stylists[].id` came
       * back as slugs -- three ids on one payload, two spellings, which is
       * the trap CLAUDE.md 8 is about.
       *
       * DEFAULT_BRANCH_ID is the only branch that exists (see
       * get-settings.handler: there is no branch table yet). SlugIndex
       * passes through anything it does not recognise, so this resolves the
       * one real salon today and is harmless the day there are more.
       */
      index = new SlugIndex([
        ...ctx.professionals.map((p) => p.id),
        ...catalogue.map((c) => c.id),
        DEFAULT_BRANCH_ID,
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
      salon_id: index.toSlug(cmd.salonId),
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
      amount_without_tax:
        money.subtotalFils === null ? null : filsToAed(money.subtotalFils),
      tax_amount: filsToAed(money.vatFils),
      discount: filsToAed(money.discountFils),
      total: money.totalFils === null ? null : filsToAed(money.totalFils),
      promo_code: cmd.promoCode,
      /**
       * WHAT WAS ACTUALLY TAKEN, from the ledger.
       *
       * These were hardcoded to 0 / total / null, which is right on create
       * and wrong on every read after a payment: §11 responds in the §8
       * shape, so a booking the customer had just paid AED 54.07 for came
       * back saying nothing was paid and the full amount was due. The
       * ledger is the only record of what moved, so it is what these are
       * derived from.
       */
      advance_paid_amount: filsToAed(captured),
      due_amount:
        money.totalFils === null
          ? null
          : filsToAed(Math.max(0, money.totalFils - captured)),
      payment_status: toMobilePaymentStatus(b.paymentStatus),
      payment_status_detail: b.paymentStatus.toUpperCase(),
      payment_method: railToMethod(paidRail),
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
    /**
     * BUSY AND UNKNOWN BOTH LAND ON `stylist_unavailable`, and only the
     * MESSAGE separates them.
     *
     * §9's code list is closed, and an unknown code is worse for the app than
     * a slightly broad one: it falls through whatever switch the app wrote
     * and renders nothing at all. The FIELD is right in both cases -- the
     * customer's next move is to pick a different stylist -- and the sentence
     * now says which of the two happened rather than blaming the time. The
     * engine's own `BOOKING_STAFF_UNKNOWN` stays precise for the desk and for
     * anything reading `code` off our own envelope.
     */
    case 'BOOKING_STAFF_UNAVAILABLE':
    case 'BOOKING_STAFF_UNKNOWN':
      return MobileContractError.of('stylists', 'stylist_unavailable', message);
    default:
      return e;
  }
}

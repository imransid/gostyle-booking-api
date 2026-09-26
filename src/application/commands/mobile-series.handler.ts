import { Inject, Injectable, Logger } from '@nestjs/common';
import { MobileBookingHandler } from './mobile-booking.handler';
import {
  MobileContractError,
  isMobileContractError,
} from './mobile-booking.error';
import {
  GetAvailabilityHandler,
  type AvailabilityView,
} from '@application/queries/get-availability.handler';
import { GetQuoteHandler } from '@application/queries/get-quote.handler';
import {
  MobileSeriesReadHandler,
  type MobileSeriesView,
} from '@application/queries/mobile-series-read.handler';
import {
  BOOKING_CONTEXT,
  type BookingContextReader,
} from '@application/ports/booking-context.port';
import { LifecycleRepository } from '@infrastructure/persistence/lifecycle.repository';
import { MobileSeriesRepository } from '@infrastructure/persistence/mobile-series.repository';
import { PlatformProductCatalogue } from '@infrastructure/persistence/platform-product-catalogue';
import {
  BRANCH_UTC_OFFSET_MIN,
  branchInstant,
  branchToday,
} from '@infrastructure/persistence/hold.repository';
import {
  DAY_END_MIN,
  DAY_START_MIN,
  formatMinute,
} from '@domain/availability/grid';
import { filsToAed, toOffsetIso } from '@domain/booking/mobile-contract';
import {
  NO_PRODUCTS,
  checkProducts,
  type MoneyFigures,
  type ProductMoney,
} from '@domain/booking/mobile-products';
import { oneCurrency } from '@domain/booking/service-resolution';
import { addDays } from '@domain/booking/recurrence';
import {
  PAYMENT_PLANS,
  ROUTINE_RULES,
  applyPicks,
  beyondHorizon,
  customDays,
  frequencyColumn,
  pickAlternatives,
  planDays,
  routineMoney,
  timesFreeOnAll,
  type Frequency,
  type PaymentPlan,
  type PlanMoney,
  type PlannedDay,
  type RoutineMoney,
  type SessionSlot,
  type SlotChoice,
} from '@domain/booking/mobile-series';
import {
  checkRoutine,
  checkRoutineMoney,
  refusalStatus,
  type CheckedRoutine,
  type RoutineClaim,
  type RoutineMoneyClaims,
  type SeriesRefusal,
} from '@domain/booking/mobile-series-contract';

/** POST /v1/mobile-booking/series, in our words. */
export interface MobileSeriesCommand {
  readonly salonId: string;
  /** From the verified token. Never from the payload. */
  readonly customerId: string;
  readonly claim: RoutineClaim;
  readonly products: readonly {
    readonly id: string;
    readonly amount: number;
    readonly quantity?: number;
  }[];
  /** The app's four figures. Null when it sent none (a dry_run may not). */
  readonly money: RoutineMoneyClaims | null;
  /** MOBILE_SERIES_DEPOSIT_PERCENT, read by the controller. */
  readonly depositPercent: number;
  /** Test hook: the clock. */
  readonly nowMs?: number;
}

export interface AlternativeView {
  readonly date: string;
  readonly time: string;
  readonly start_time: string;
  readonly stylist_id: string;
}

export interface PlannedSessionView {
  readonly index: number;
  readonly date: string;
  readonly start_time: string | null;
  readonly end_time: string | null;
  readonly stylist_id: string | null;
  /** Null past the 90 day horizon, where nothing is checked yet. */
  readonly free: boolean | null;
  /** Past the 90 day horizon: stored as planned, booked later. */
  readonly later: boolean;
  /** The customer chose this one from the alternatives (D4). */
  readonly picked: boolean;
  readonly moved_from_day_of_month: number | null;
  readonly alternatives: readonly AlternativeView[];
}

export interface PlanMoneyView {
  readonly available: boolean;
  readonly amount_without_tax: number;
  readonly discount: number;
  readonly tax_amount: number;
  readonly total: number;
  readonly pay_now: number;
  readonly percent: number | null;
  readonly sessions: readonly {
    readonly total: number;
    readonly pay_now: number;
    readonly at_visit: number;
  }[];
}

/** What a dry_run answers. Nothing was written. */
export interface MobileSeriesPreview {
  readonly dry_run: true;
  readonly frequency: Frequency;
  readonly time: string | null;
  readonly stylist_id: string;
  readonly payment_plan: PaymentPlan;
  readonly sessions: readonly PlannedSessionView[];
  /** dry_run without a time: the times free on every day. */
  readonly available_times: readonly string[] | null;
  /** With a time: is every bookable session free? */
  readonly all_free: boolean | null;
  readonly money: {
    readonly plans: Readonly<Record<PaymentPlan, PlanMoneyView>>;
  } | null;
  readonly rules: Readonly<Record<string, number>>;
}

/** How far DAILY looks for open days before it refuses. */
const DAILY_SEARCH_DAYS = 60;
/** D4: the days either side of a busy session searched for alternatives. */
const ALTERNATIVE_DAYS = [-2, -1, 0, 1, 2];
const RELEASE_REASON =
  'The routine could not be booked in full, so this session was released.';

const snake = (key: string): string =>
  key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const RULES_VIEW: Readonly<Record<string, number>> = Object.fromEntries(
  Object.entries(ROUTINE_RULES).map(([k, v]) => [snake(k), v]),
);

function refused(r: SeriesRefusal): MobileContractError {
  return new MobileContractError(
    [
      {
        field: r.field,
        code: r.code,
        message: r.message,
        ...(r.expected === undefined ? {} : { expected: r.expected }),
      },
    ],
    refusalStatus(r.code),
  );
}

const iso = (day: string, minute: number): string =>
  toOffsetIso(branchInstant(day, minute), BRANCH_UTC_OFFSET_MIN);

/** One request's availability, one engine call per day at most. */
class DayOffers {
  private readonly seen = new Map<string, Promise<AvailabilityView>>();

  constructor(
    private readonly availability: GetAvailabilityHandler,
    private readonly branchId: string,
    private readonly serviceIds: readonly string[],
  ) {}

  get(day: string): Promise<AvailabilityView> {
    let view = this.seen.get(day);
    if (view === undefined) {
      view = this.availability.execute({
        branchId: this.branchId,
        tradingDay: day,
        serviceIds: this.serviceIds,
        // The single mobile create holds on the online channel; a routine
        // must be checked against the same one or the preview promises a
        // slot the create then refuses.
        channel: 'online',
        preferredStaffId: null,
        fromMin: DAY_START_MIN,
        toMin: DAY_END_MIN,
      });
      this.seen.set(day, view);
    }
    return view;
  }

  /** Every free start with every stylist who could take it. */
  async choices(day: string): Promise<SlotChoice[]> {
    const view = await this.get(day);
    if (view.closureReason !== undefined) return [];
    return view.offers.flatMap((o) =>
      o.staff.map((s) => ({ day, startMin: o.startMin, staffId: s.id })),
    );
  }

  async isFree(slot: SlotChoice): Promise<boolean> {
    const view = await this.get(slot.day);
    return (
      view.closureReason === undefined &&
      view.offers.some(
        (o) =>
          o.startMin === slot.startMin &&
          o.staff.some((s) => s.id === slot.staffId),
      )
    );
  }
}

/**
 * A mobile routine: preview (dry_run) and create.
 *
 * ORCHESTRATION ONLY, as the single create is. Every session is an ORDINARY
 * mobile booking made by MobileBookingHandler.execute, UNCHANGED: the same
 * services, the same stylist, the same quote, VAT and products, paid at the
 * salon (D2). Availability is GetAvailabilityHandler's, the money is
 * GetQuoteHandler's, and the routine's own rules are the pure
 * domain/booking/mobile-series.ts. Nothing here decides a price or a slot.
 *
 * STRICT (D4): a session is booked at its day, time and stylist, or at the
 * alternative the customer picked. Never moved silently, and the desk's
 * repair ladder is never used.
 *
 * ALL OR NOTHING: if session 4 fails, sessions 1 to 3 are cancelled again
 * (salon-initiated, so fully refunded; nothing was taken anyway) and the
 * routine is never written.
 */
@Injectable()
export class MobileSeriesHandler {
  private static readonly log = new Logger(MobileSeriesHandler.name);

  constructor(
    private readonly single: MobileBookingHandler,
    private readonly availability: GetAvailabilityHandler,
    private readonly quotes: GetQuoteHandler,
    private readonly lifecycle: LifecycleRepository,
    private readonly repo: MobileSeriesRepository,
    private readonly reads: MobileSeriesReadHandler,
    @Inject(BOOKING_CONTEXT) private readonly context: BookingContextReader,
    private readonly productCatalogue: PlatformProductCatalogue,
  ) {}

  async execute(
    cmd: MobileSeriesCommand,
  ): Promise<MobileSeriesPreview | MobileSeriesView> {
    const nowMs = cmd.nowMs ?? Date.now();
    const today = branchToday(nowMs);

    // ---- 1. The request on its own ---------------------------------------
    const checked = checkRoutine(cmd.claim, today);
    if (checked.kind === 'refused') throw refused(checked.refusal);
    const routine = checked.value;
    const stylistId = cmd.claim.stylistId!.trim();
    const serviceIds = cmd.claim.serviceIds;

    // ---- 2. The services must exist at this salon ------------------------
    const known = await this.context.loadServices(cmd.salonId, serviceIds);
    if (known.length !== serviceIds.length) {
      const found = new Set(known.map((s) => s.id));
      throw MobileContractError.of(
        'services',
        'unknown_service',
        `Not sold at this salon: ${serviceIds.filter((i) => !found.has(i)).join(', ')}.`,
      );
    }

    // ---- 3. Products (D7: the first session only) ------------------------
    const products = await this.productFigures(cmd, known);

    // ---- 4. The days -----------------------------------------------------
    const offers = new DayOffers(this.availability, cmd.salonId, serviceIds);
    const planned = await this.plan(routine, offers);
    if (planned.length < routine.count) {
      throw MobileContractError.of(
        'start_date',
        'date_out_of_range',
        `The salon is not open on ${routine.count} days in the ${DAILY_SEARCH_DAYS} days from the first one.`,
      );
    }

    // ---- 5. No time yet: which times are free on every day ---------------
    if (routine.startMin === null) {
      return this.timesPreview(cmd, routine, planned, today, offers, stylistId);
    }

    // ---- 6. The slots, with the customer's picks (D4) --------------------
    const slots = applyPicks(
      planned.map((p, index) => ({
        index,
        day: p.day,
        startMin: routine.startMin!,
        staffId: stylistId,
        picked: false,
      })),
      routine.picks,
    );
    if (slots.kind === 'refused') throw refused(slots.refusal);

    const money = await this.money(cmd, slots.slots, products);
    const views = await this.check(
      slots.slots,
      planned,
      today,
      offers,
      money.quotes.map((q) => q.durationMin),
    );

    if (routine.dryRun) {
      return {
        dry_run: true,
        frequency: routine.frequency,
        time: formatMinute(routine.startMin),
        stylist_id: stylistId,
        payment_plan: routine.paymentPlan,
        sessions: views,
        available_times: null,
        all_free: views.every((v) => v.free !== false),
        money: { plans: this.plansView(money.routine) },
        rules: RULES_VIEW,
      };
    }

    // ---- 7. Create: every session free, the money agreed -----------------
    const busy = views.find((v) => v.free === false);
    if (busy !== undefined) {
      throw new MobileContractError(
        [
          {
            field: `sessions[${busy.index}]`,
            code: 'session_not_free',
            message:
              `Session ${busy.index + 1} on ${busy.date} is not free. Nothing ` +
              'was booked. Run the preview again to see the alternatives.',
          },
        ],
        409,
      );
    }
    const moneyRefusal = checkRoutineMoney(
      cmd.money ?? {
        amountWithoutTax: Number.NaN,
        taxAmount: Number.NaN,
        discount: Number.NaN,
        total: Number.NaN,
      },
      money.routine.plans[routine.paymentPlan],
    );
    if (moneyRefusal !== null) throw refused(moneyRefusal);

    // ---- 8. Book each session, all or nothing ----------------------------
    const booked = await this.bookAll(cmd, slots.slots, views, money, today);

    // ---- 9. The routine's rows, in one transaction -----------------------
    let seriesId: string;
    try {
      ({ seriesId } = await this.repo.create({
        branchId: cmd.salonId,
        customerId: cmd.customerId,
        frequency: frequencyColumn(routine.frequency),
        serviceIds,
        stylistId,
        startMin: routine.startMin,
        // The contract let only PAY_AT_SALON through to a create (D2).
        paymentPlan: 'pay_at_salon',
        baselinePriceFils: money.quotes[0]!.subtotalFils,
        sessions: slots.slots.map((s) => ({
          index: s.index,
          day: s.day,
          startMin: s.startMin,
          movedFromDayOfMonth: planned[s.index]!.movedFromDayOfMonth,
          bookingId: booked.get(s.index) ?? null,
        })),
      }));
    } catch (e) {
      await this.release([...booked.values()], cmd.customerId);
      throw e;
    }

    return this.reads.afterCreate(seriesId, nowMs);
  }

  // ------------------------------------------------------------ steps

  /**
   * The days. DAILY needs to know which days are open (D3), so it loads a
   * window, plans inside it, and widens it until the plan fits inside what
   * was loaded. Every other frequency keeps its cadence whatever the salon
   * does that day: a closed day is a session that is not free (D4).
   */
  private async plan(
    routine: CheckedRoutine,
    offers: DayOffers,
  ): Promise<PlannedDay[]> {
    if (routine.frequency === 'CUSTOM') return customDays(routine.days!);
    const first = routine.first!;
    if (routine.frequency !== 'DAILY') {
      return planDays({
        frequency: routine.frequency,
        first,
        count: routine.count,
        isOpen: () => true,
      });
    }

    let window = routine.count + 7;
    for (;;) {
      const days = Array.from({ length: window }, (_, i) => addDays(first, i));
      const views = await Promise.all(days.map((d) => offers.get(d)));
      const open = new Map(
        days.map((d, i) => [d, views[i]!.closureReason === undefined]),
      );
      const plan = planDays({
        frequency: 'DAILY',
        first,
        count: routine.count,
        isOpen: (d) => open.get(d) ?? false,
      });
      // The walk stops at the last session, so a full plan only ever read
      // days that were loaded.
      if (plan.length === routine.count || window >= DAILY_SEARCH_DAYS) {
        return plan;
      }
      window = Math.min(window * 2, DAILY_SEARCH_DAYS);
    }
  }

  private async timesPreview(
    cmd: MobileSeriesCommand,
    routine: CheckedRoutine,
    planned: readonly PlannedDay[],
    today: string,
    offers: DayOffers,
    stylistId: string,
  ): Promise<MobileSeriesPreview> {
    const bookable = planned.filter((p) => !beyondHorizon(p.day, today));
    const perDay = await Promise.all(
      bookable.map(async (p) =>
        (await offers.choices(p.day))
          .filter((c) => c.staffId === stylistId)
          .map((c) => c.startMin),
      ),
    );
    return {
      dry_run: true,
      frequency: routine.frequency,
      time: null,
      stylist_id: stylistId,
      payment_plan: routine.paymentPlan,
      sessions: planned.map((p, index) => ({
        index,
        date: p.day,
        start_time: null,
        end_time: null,
        stylist_id: stylistId,
        free: null,
        later: beyondHorizon(p.day, today),
        picked: false,
        moved_from_day_of_month: p.movedFromDayOfMonth,
        alternatives: [],
      })),
      available_times: timesFreeOnAll(perDay).map(formatMinute),
      all_free: null,
      money: null,
      rules: RULES_VIEW,
    };
  }

  /** Each session: free or not, and up to 3 alternatives when not (D4). */
  private async check(
    slots: readonly SessionSlot[],
    planned: readonly PlannedDay[],
    today: string,
    offers: DayOffers,
    durations: readonly number[],
  ): Promise<PlannedSessionView[]> {
    return Promise.all(
      slots.map(async (s): Promise<PlannedSessionView> => {
        const later = beyondHorizon(s.day, today);
        const free = later ? null : await offers.isFree(s);
        const alternatives =
          free === false
            ? await this.alternativesFor(s, slots, today, offers)
            : [];
        return {
          index: s.index,
          date: s.day,
          start_time: iso(s.day, s.startMin),
          end_time: iso(s.day, s.startMin + durations[s.index]!),
          stylist_id: s.staffId,
          free,
          later,
          picked: s.picked,
          moved_from_day_of_month: planned[s.index]!.movedFromDayOfMonth,
          alternatives: alternatives.map((a) => ({
            date: a.day,
            time: formatMinute(a.startMin),
            start_time: iso(a.day, a.startMin),
            stylist_id: a.staffId,
          })),
        };
      }),
    );
  }

  private async alternativesFor(
    slot: SessionSlot,
    slots: readonly SessionSlot[],
    today: string,
    offers: DayOffers,
  ): Promise<SlotChoice[]> {
    const days = ALTERNATIVE_DAYS.map((n) => addDays(slot.day, n)).filter(
      (d) => d >= today && !beyondHorizon(d, today),
    );
    const free = (await Promise.all(days.map((d) => offers.choices(d)))).flat();
    return pickAlternatives({
      wanted: slot,
      free,
      otherSessionDays: slots
        .filter((x) => x.index !== slot.index)
        .map((x) => x.day),
    });
  }

  /**
   * Each session priced by the quote the single create checks against (tier
   * discount and all), then the routine's plans on top (D2, D7, D8).
   */
  private async money(
    cmd: MobileSeriesCommand,
    slots: readonly SessionSlot[],
    products: ProductMoney,
  ): Promise<{
    readonly quotes: readonly (MoneyFigures & { durationMin: number })[];
    readonly routine: RoutineMoney;
  }> {
    const quotes = await Promise.all(
      slots.map(async (s) => {
        const q = await this.quotes.execute({
          branchId: cmd.salonId,
          tradingDay: s.day,
          serviceIds: cmd.claim.serviceIds,
          customerId: cmd.customerId,
          channel: 'online',
          startMin: s.startMin,
        });
        return {
          subtotalFils: q.subtotalMinor,
          vatFils: q.vatMinor,
          discountFils: q.tierDiscountMinor + q.bundleDiscountMinor,
          totalFils: q.totalMinor,
          durationMin: q.durationMin,
        };
      }),
    );
    return {
      quotes,
      routine: routineMoney({
        sessions: quotes,
        products,
        depositPercent: cmd.depositPercent,
      }),
    };
  }

  /** Products are priced and checked exactly as the single create does. */
  private async productFigures(
    cmd: MobileSeriesCommand,
    known: readonly { readonly currency?: string | undefined }[],
  ): Promise<ProductMoney> {
    if (cmd.products.length === 0) return NO_PRODUCTS;
    if (!this.productCatalogue.enabled()) {
      throw MobileContractError.of(
        'products',
        'products_not_supported',
        'Products cannot be sold with a booking yet: there is no product ' +
          'catalogue to price against, so the line could not be verified.',
      );
    }
    const offers = await this.productCatalogue.resolve(
      cmd.salonId,
      cmd.products.map((p) => p.id),
    );
    const basket = oneCurrency(known);
    const checked = checkProducts({
      lines: cmd.products,
      offers,
      currency: basket.kind === 'ok' ? basket.currency : '',
    });
    if (checked.kind === 'refused')
      throw new MobileContractError(checked.errors);
    return checked.money;
  }

  /**
   * Every bookable session through the single create, in order. If one
   * fails, the ones already made are cancelled again and the error says
   * which session it was.
   */
  private async bookAll(
    cmd: MobileSeriesCommand,
    slots: readonly SessionSlot[],
    views: readonly PlannedSessionView[],
    money: {
      readonly quotes: readonly (MoneyFigures & { durationMin: number })[];
      readonly routine: RoutineMoney;
    },
    today: string,
  ): Promise<Map<number, string>> {
    const booked = new Map<number, string>();
    for (const s of slots) {
      if (beyondHorizon(s.day, today)) continue;
      const figures = money.routine.sessions[s.index]!;
      const durationMin = money.quotes[s.index]!.durationMin;
      try {
        const made = (await this.single.execute({
          salonId: cmd.salonId,
          services: cmd.claim.serviceIds.map((id) => ({ id, amount: 0 })),
          products:
            s.index === 0 && cmd.products.length > 0 ? cmd.products : undefined,
          stylists: [s.staffId],
          date: s.day,
          startTime: iso(s.day, s.startMin),
          endTime: iso(s.day, s.startMin + durationMin),
          amountWithoutTax: filsToAed(figures.subtotalFils),
          taxAmount: filsToAed(figures.vatFils),
          discount: filsToAed(figures.discountFils),
          promoCode: null,
          total: filsToAed(figures.totalFils),
          advancePaidAmount: 0,
          dueAmount: filsToAed(figures.totalFils),
          // D2: v1 is paid at the salon. Confirmed, none_required, no link,
          // nothing for the payment link sweeper to expire.
          paymentStatus: 'PAY_AFTER_CHECK_IN',
          status: 'BOOKED',
          bookingType: 'SINGLE',
          customerId: cmd.customerId,
          // No key per session. The route's interceptor replays the whole
          // routine; a per-session key would replay a session this very
          // handler cancelled after a part-way failure.
          idempotencyKey: undefined,
        })) as { id: string };
        booked.set(s.index, made.id);
      } catch (e) {
        await this.release([...booked.values()], cmd.customerId);
        throw this.failure(e, s, views);
      }
    }
    return booked;
  }

  /**
   * Cancel what a failed routine already booked. Salon-initiated, so the
   * refund band is "in full" and it never counts as a late cancel against
   * the customer; nothing was taken anyway (pay at salon). A customer
   * cancel, because a confirmed booking may be cancelled by its customer or
   * staff, not by `system`.
   */
  private async release(
    bookingIds: readonly string[],
    customerId: string,
  ): Promise<void> {
    for (const bookingId of [...bookingIds].reverse()) {
      const out = await this.lifecycle
        .transition({
          bookingId,
          to: 'cancelled',
          actor: 'customer',
          actorId: customerId,
          reason: RELEASE_REASON,
          initiatedBy: 'salon',
        })
        .catch(() => null);
      if (out === null || out.kind !== 'transitioned') {
        MobileSeriesHandler.log.error(
          `routine rollback: booking ${bookingId} could NOT be released`,
        );
      }
    }
  }

  /** A session that lost its slot is session_not_free; anything else as is. */
  private failure(
    e: unknown,
    s: SessionSlot,
    views: readonly PlannedSessionView[],
  ): unknown {
    if (!isMobileContractError(e)) return e;
    const code = e.errors[0]?.code;
    if (code !== 'slot_taken' && code !== 'stylist_unavailable') return e;
    return new MobileContractError(
      [
        {
          field: `sessions[${s.index}]`,
          code: 'session_not_free',
          message:
            `Session ${s.index + 1} on ${views[s.index]?.date ?? s.day} was ` +
            'taken while booking. Nothing was booked. Run the preview again ' +
            'to see the alternatives.',
        },
      ],
      409,
    );
  }

  private plansView(money: RoutineMoney): Record<PaymentPlan, PlanMoneyView> {
    const view = (p: PlanMoney): PlanMoneyView => ({
      available: p.available,
      amount_without_tax: filsToAed(p.subtotalFils),
      discount: filsToAed(p.discountFils),
      tax_amount: filsToAed(p.vatFils),
      total: filsToAed(p.totalFils),
      pay_now: filsToAed(p.payNowFils),
      percent: p.percent,
      sessions: p.sessions.map((s) => ({
        total: filsToAed(s.totalFils),
        pay_now: filsToAed(s.payNowFils),
        at_visit: filsToAed(s.atVisitFils),
      })),
    });
    return Object.fromEntries(
      PAYMENT_PLANS.map((plan) => [plan, view(money.plans[plan])]),
    ) as Record<PaymentPlan, PlanMoneyView>;
  }
}

import { Injectable } from '@nestjs/common';
import { MobileBookingHandler } from '@application/commands/mobile-booking.handler';
import { GetQuoteHandler } from '@application/queries/get-quote.handler';
import {
  MobileSeriesReadHandler,
  type MobileSeriesView,
  type SeriesReader,
  type SeriesRowLoaded,
  type SessionView,
} from '@application/queries/mobile-series-read.handler';
import {
  branchUtcOffsetMin,
  branchInstant,
  toUuid,
} from '@infrastructure/persistence/hold.repository';
import { TenantContext } from '@infrastructure/tenancy/tenant-context';
import { filsToAed, toOffsetIso } from '@domain/booking/mobile-contract';
import {
  addsNothing,
  priceToday,
  sumVisits,
  type VisitFigures,
  type VisitMoney,
} from '@domain/booking/mobile-series-booking-view';

/** One session, in the booking shape (draft §5). */
export interface RoutineBookingSession {
  readonly id: string;
  readonly index: number;
  readonly date: string;
  readonly start_time: string;
  readonly end_time: string | null;
  readonly state: SessionView['state'];
  readonly stylist: SessionView['stylist'];
  readonly booking_id: string | null;
  readonly pass_qr_code: string | null;
  readonly total: number | null;
  readonly locked: boolean;
  readonly can_skip: boolean;
  readonly can_reschedule: boolean;
}

/**
 * A routine as ONE booking (draft §3 response and §5), on booking-api's own
 * words and clock (frequency, +06:00): customer-api renames and converts.
 */
export interface RoutineBookingView {
  readonly id: string;
  readonly booking_type: 'ROUTINE';
  readonly salon_id: string;
  readonly status: MobileSeriesView['status'];
  readonly frequency: MobileSeriesView['frequency'];
  readonly date: string | null;
  readonly start_time: string | null;
  readonly end_time: string | null;
  readonly services: readonly {
    readonly id: string;
    readonly name: string | null;
    readonly amount: number | null;
  }[];
  readonly products: readonly never[];
  readonly stylists: readonly {
    readonly id: string;
    readonly name: string | null;
    readonly avatar_url: null;
  }[];
  readonly amount_without_tax: number | null;
  readonly tax_amount: number;
  readonly discount: number;
  readonly total: number | null;
  readonly promo_code: null;
  readonly advance_paid_amount: number;
  readonly due_amount: number | null;
  readonly payment_status: 'PAY_AFTER_CHECK_IN';
  readonly payment_method: null;
  readonly pass_qr_code: string | null;
  readonly counts: MobileSeriesView['counts'];
  readonly pause: MobileSeriesView['pause'];
  readonly can: MobileSeriesView['can'];
  readonly sessions: readonly RoutineBookingSession[];
  readonly created_at: string;
}

/** What one session is, for the booking shape. */
interface SessionMoney {
  readonly session: SessionView;
  /** The single read's figures of its booking, when it has one. */
  readonly visit: VisitMoney | null;
  /** What it adds to the routine; null for nothing. */
  readonly adds: VisitFigures | null;
  /** Its own total, as its own read (or today's price) says. */
  readonly totalFils: number | null;
  readonly endTime: string | null;
}

const aedOrNull = (fils: number | null): number | null =>
  fils === null ? null : filsToAed(fils);

/**
 * A session that adds nothing (skipped, cancelled or missed) is not charged
 * and has nothing to show at the salon: no pass on its line, and no total
 * (shape). It keeps its booking_id, so the visit can still be opened.
 */
const passOf = (m: SessionMoney): string | null =>
  m.adds === null ? null : (m.visit?.code ?? null);

/**
 * Step B7 (gostyle-customer-api docs/ROUTINE_FE_CONTRACT_AUDIT.md): the
 * routine in the booking shape, for GET .../series/:id?view=booking and the
 * Recurring rows with view=booking, only behind MOBILE_ROUTINE_CONTRACT.
 *
 * READS ONLY, built on the hub (MobileSeriesReadHandler: the same states,
 * the same 404) and on the single read's own money (MobileBookingHandler
 * .moneyView): a routine's figures are the sum of its visits exactly as
 * each visit reads, so the two can never disagree (the money rule in
 * domain/booking/mobile-series-booking-view.ts).
 */
@Injectable()
export class MobileRoutineBookingViewHandler {
  constructor(
    private readonly reads: MobileSeriesReadHandler,
    private readonly single: MobileBookingHandler,
    private readonly quotes: GetQuoteHandler,
    private readonly tenants: TenantContext,
  ) {}

  async read(
    seriesId: string,
    who: SeriesReader,
    nowMs = Date.now(),
  ): Promise<RoutineBookingView> {
    const { view, series } = await this.reads.readWithRow(seriesId, who, nowMs);
    return this.shape(view, series);
  }

  /** The Recurring tab, each row the same object as `read`. */
  async list(
    customerId: string,
    paging: { readonly page: number; readonly pageSize: number },
    nowMs = Date.now(),
  ): Promise<{ count: number; results: RoutineBookingView[] }> {
    const page = await this.reads.pageWithRows(customerId, paging, nowMs);
    return {
      count: page.count,
      results: await Promise.all(
        page.items.map(({ view, series }) => this.shape(view, series)),
      ),
    };
  }

  private async shape(
    view: MobileSeriesView,
    series: SeriesRowLoaded,
  ): Promise<RoutineBookingView> {
    const sessions = await Promise.all(
      view.sessions.map((s) => this.sessionMoney(s, series)),
    );
    const figures = sumVisits(sessions.map((m) => m.adds));

    // The top of the booking: the next session still to come, else the
    // last one of the routine.
    const byDay = [...sessions].sort((a, b) =>
      a.session.date === b.session.date
        ? a.session.index - b.session.index
        : a.session.date < b.session.date
          ? -1
          : 1,
    );
    const top =
      (view.next_session === null
        ? undefined
        : sessions.find((m) => m.session.id === view.next_session!.id)) ??
      byDay[byDay.length - 1] ??
      null;

    // One session's price of each service, before tax: the top session's
    // own booking, else the latest session that has one.
    const priced =
      (top?.visit ? top : undefined) ??
      [...sessions].reverse().find((m) => m.visit !== null) ??
      null;
    const amountOf = (serviceId: string): number | null => {
      const item = priced?.visit?.items.find(
        (i) => i.serviceId === toUuid(serviceId),
      );
      return item === undefined ? null : filsToAed(item.priceFils);
    };

    return {
      id: view.id,
      booking_type: 'ROUTINE',
      salon_id: view.salon_id,
      status: view.status,
      frequency: view.frequency,
      date: top?.session.date ?? null,
      start_time: top?.session.start_time ?? null,
      end_time: top?.endTime ?? null,
      services: view.services.map((s) => ({
        id: s.id,
        name: s.name,
        amount: amountOf(s.id),
      })),
      products: [],
      stylists:
        view.stylist === null
          ? []
          : [
              {
                id: view.stylist.id,
                name: view.stylist.name,
                avatar_url: null,
              },
            ],
      amount_without_tax: aedOrNull(figures.subtotalFils),
      tax_amount: filsToAed(figures.vatFils),
      discount: filsToAed(figures.discountFils),
      total: aedOrNull(figures.totalFils),
      promo_code: null,
      advance_paid_amount: filsToAed(figures.capturedFils),
      due_amount: aedOrNull(figures.dueFils),
      // v1 is paid at the salon (D2, draft §4).
      payment_status: 'PAY_AFTER_CHECK_IN',
      payment_method: null,
      // The pass of a session that adds nothing is never shown (see below).
      pass_qr_code: top === null ? null : passOf(top),
      counts: view.counts,
      pause: view.pause,
      can: view.can,
      sessions: sessions.map((m) => ({
        id: m.session.id,
        index: m.session.index,
        date: m.session.date,
        start_time: m.session.start_time,
        end_time: m.endTime,
        state: m.session.state,
        stylist: m.session.stylist,
        booking_id: m.session.booking_id,
        pass_qr_code: passOf(m),
        total: m.adds === null ? null : aedOrNull(m.totalFils),
        locked: m.session.locked,
        can_skip: m.session.can_skip,
        can_reschedule: m.session.can_reschedule,
      })),
      created_at: view.created_at,
    };
  }

  /**
   * One session's money. With a booking: the single read's own figures
   * (moneyView), adding nothing when skipped or CANCELLED in the single
   * read's words. Without one: nothing when skipped, else today's price,
   * fully due (a PLANNED or NEEDS_ACTION session).
   */
  private async sessionMoney(
    session: SessionView,
    series: SeriesRowLoaded,
  ): Promise<SessionMoney> {
    const occurrence = series.occurrences.find((o) => o.id === session.id);
    const skipped = occurrence?.state === 'skipped';

    if (session.booking_id !== null) {
      const visit = await this.single.moneyView(session.booking_id);
      const nothing =
        visit === null || addsNothing({ skipped, bookingStatus: visit.status });
      return {
        session,
        visit,
        adds: nothing || visit === null ? null : visit,
        totalFils: visit?.totalFils ?? null,
        endTime: session.end_time,
      };
    }

    if (skipped || occurrence === undefined) {
      return {
        session,
        visit: null,
        adds: null,
        totalFils: null,
        endTime: session.end_time,
      };
    }

    const quote = await this.inRoutineTenant(series, () =>
      this.quotes.execute({
        branchId: series.branchId,
        tradingDay: session.date,
        serviceIds:
          series.serviceIds !== null && series.serviceIds.length > 0
            ? series.serviceIds
            : [series.serviceId],
        customerId: series.customerId,
        channel: 'online',
        startMin: occurrence.plannedStartMin,
      }),
    ).catch(() => null);
    if (quote === null) {
      // Today's price cannot be worked out: the figure is unknown, never 0.
      return {
        session,
        visit: null,
        adds: {
          subtotalFils: null,
          vatFils: 0,
          discountFils: 0,
          totalFils: null,
          capturedFils: 0,
          dueFils: null,
        },
        totalFils: null,
        endTime: session.end_time,
      };
    }
    const adds = priceToday({
      subtotalFils: quote.subtotalMinor,
      vatFils: quote.vatMinor,
      discountFils: quote.tierDiscountMinor + quote.bundleDiscountMinor,
      totalFils: quote.totalMinor,
    });
    return {
      session,
      visit: null,
      adds,
      totalFils: adds.totalFils,
      endTime: toOffsetIso(
        branchInstant(
          session.date,
          occurrence.plannedStartMin + quote.durationMin,
        ),
        branchUtcOffsetMin(),
      ),
    };
  }

  /** The routine's own tenant when the request carried none (the catalogue is tenant-scoped). */
  private inRoutineTenant<T>(
    series: SeriesRowLoaded,
    fn: () => Promise<T>,
  ): Promise<T> {
    if (this.tenants.current() !== null || series.tenantId === null) {
      return fn();
    }
    return this.tenants.run(series.tenantId, fn);
  }
}

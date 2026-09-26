import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '@infrastructure/persistence/prisma.service';
import {
  BRANCH_UTC_OFFSET_MIN,
  branchInstant,
  toUuid,
} from '@infrastructure/persistence/hold.repository';
import { SlugIndex } from '@infrastructure/persistence/slug-uuid';
import { TenantContext } from '@infrastructure/tenancy/tenant-context';
import { DEFAULT_BRANCH_ID } from '@infrastructure/tenancy/branch-context';
import {
  BOOKING_CONTEXT,
  type BookingContextReader,
} from '@application/ports/booking-context.port';
import { MobileContractError } from '@application/commands/mobile-booking.error';
import { filsToAed, toOffsetIso } from '@domain/booking/mobile-contract';
import { formatMinute } from '@domain/availability/grid';
import { productMoney } from '@domain/booking/mobile-products';
import { storedTotalFils } from '@domain/booking/stored-money';
import type { BookingStatus } from '@domain/booking/lifecycle';
import {
  ROUTINE_RULES,
  changeRefusal,
  effectivePause,
  frequencyFromColumn,
  routineCan,
  sessionWord,
  tally,
  type Frequency,
  type OccurrenceState,
  type PaymentPlan,
  type RoutineCan,
  type RoutineStatus,
  type SessionFacts,
  type SessionWord,
} from '@domain/booking/mobile-series';
import {
  pauseReasonFromColumn,
  toRoutineStatus,
  type RoutineWireStatus,
} from '@domain/booking/mobile-series-contract';
import { routineRow, sortRoutines } from '@domain/booking/mobile-series-list';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Who is asking. The same three facts the group read takes. */
export interface SeriesReader {
  readonly actorId: string;
  readonly actorKind: string;
  /** Staff only: null means every branch. */
  readonly actorBranchId: string | null;
}

export interface SessionView {
  /** series_occurrence.id: what SKIP and RESCHEDULE take. */
  readonly id: string;
  readonly index: number;
  readonly date: string;
  readonly start_time: string;
  readonly end_time: string | null;
  readonly state: SessionWord;
  readonly booking_id: string | null;
  readonly booking_code: string | null;
  readonly stylist: {
    readonly id: string;
    readonly name: string | null;
  } | null;
  /** This session's total, decimal AED. Null until it is booked. */
  readonly total: number | null;
  /** Inside the 24h lock: no skip, no move. */
  readonly locked: boolean;
  readonly can_skip: boolean;
  readonly can_reschedule: boolean;
}

/** GET /v1/mobile-booking/series/:id, and what create answers. */
export interface MobileSeriesView {
  readonly id: string;
  readonly booking_type: 'ROUTINE';
  readonly salon_id: string;
  readonly status: RoutineWireStatus;
  readonly frequency: Frequency | null;
  /** The routine's own time, HH:MM. A picked session may differ. */
  readonly time: string;
  readonly stylist: {
    readonly id: string;
    readonly name: string | null;
  } | null;
  readonly services: readonly {
    readonly id: string;
    readonly name: string | null;
  }[];
  readonly payment_plan: PaymentPlan | null;
  /** Null unless the routine is paused (effectivePause). */
  readonly pause: {
    readonly until: string | null;
    readonly reason: string | null;
    readonly note: string | null;
  } | null;
  readonly counts: {
    readonly total: number;
    readonly done: number;
    readonly remaining: number;
    readonly skipped: number;
    readonly cancelled: number;
  };
  readonly next_session: SessionView | null;
  readonly sessions: readonly SessionView[];
  readonly money: {
    /** What the sessions booked so far add up to, decimal AED. */
    readonly total: number;
    /** v1 pays at the salon: nothing is taken in the app. */
    readonly pay_now: number;
  };
  readonly can: RoutineCan;
  readonly rules: Readonly<Record<string, number>>;
  readonly created_at: string;
}

/** The rows the hub needs, as Prisma answers them. */
interface SeriesRowLoaded {
  readonly id: string;
  readonly tenantId: string | null;
  readonly branchId: string;
  readonly customerId: string;
  readonly startMin: number;
  readonly status: RoutineStatus;
  readonly serviceId: string;
  readonly preferredStaffId: string | null;
  readonly source: string | null;
  readonly frequency: string | null;
  readonly serviceIds: readonly string[] | null;
  readonly paymentPlan: string | null;
  readonly pausedUntil: Date | null;
  readonly pauseReason: string | null;
  readonly pauseNote: string | null;
  readonly createdAt: Date;
  readonly occurrences: readonly {
    readonly id: string;
    readonly index: number;
    readonly plannedDay: Date;
    readonly plannedStartMin: number;
    readonly state: OccurrenceState;
    readonly bookingId: string | null;
  }[];
}

interface BookingLoaded {
  readonly id: string;
  readonly code: string;
  readonly status: BookingStatus;
  readonly tradingDay: Date;
  readonly startMinute: number;
  readonly durationMin: number;
  readonly priceFils: number;
  readonly netFils: number | null;
  readonly taxFils: number | null;
  readonly discountFils: number | null;
  readonly items: readonly {
    readonly serviceId: string;
    readonly serviceName: string;
    readonly staffId: string | null;
  }[];
  readonly products: readonly {
    readonly priceFils: number;
    readonly quantity: number;
  }[];
}

const day = (d: Date): string => d.toISOString().slice(0, 10);

const snake = (key: string): string =>
  key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

/** The rules, in the app's snake case. */
const RULES_VIEW: Readonly<Record<string, number>> = Object.fromEntries(
  Object.entries(ROUTINE_RULES).map(([k, v]) => [snake(k), v]),
);

/**
 * The routine hub.
 *
 * READS ONLY, and every state is DERIVED from the rows on this read (booking
 * status, occurrence state, the clock), never stored (CLAUDE.md 4). So a
 * session the desk cancelled shows as cancelled, a desk skip as skipped and
 * a desk pause as paused, with no mobile code involved in any of them.
 */
@Injectable()
export class MobileSeriesReadHandler {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenants: TenantContext,
    @Inject(BOOKING_CONTEXT) private readonly context: BookingContextReader,
  ) {}

  /**
   * 404, NEVER 403, for a routine the caller may not see: "no such routine"
   * and "not yours" must look the same from outside. A desk series (`source`
   * null) is 404 too: this answers for the routines the app made.
   */
  async read(
    seriesId: string,
    who: SeriesReader,
    nowMs = Date.now(),
  ): Promise<MobileSeriesView> {
    const series = await this.load(seriesId);
    if (series === null || !this.visible(series, who)) {
      throw MobileContractError.notFoundBooking();
    }
    return this.present(series, nowMs);
  }

  /** The same shape, for a routine this request just made. */
  async afterCreate(
    seriesId: string,
    nowMs = Date.now(),
  ): Promise<MobileSeriesView> {
    const series = await this.load(seriesId);
    if (series === null) throw MobileContractError.notFoundBooking();
    return this.present(series, nowMs);
  }

  /**
   * The Recurring tab (step 5): every routine this customer made in the
   * app, as list rows. The same routines `read` shows this customer (theirs,
   * source 'mobile'), each built by the same `present`, so a row and the hub
   * it opens never disagree.
   *
   * ALL of them are read, then sorted and paged here, not in SQL: a customer
   * has a handful, and the order (live ones by their next visit, then ended
   * ones newest first) needs each routine's next visit, which only `present`
   * works out.
   */
  async listForCustomer(
    customerId: string,
    paging: { readonly page: number; readonly pageSize: number },
    nowMs = Date.now(),
  ): Promise<{ count: number; results: unknown[] }> {
    const rows = await this.prisma.bookingSeries.findMany({
      where: { source: 'mobile', customerId: toUuid(customerId) },
      include: { occurrences: { orderBy: { index: 'asc' } } },
    });
    const views = await Promise.all(
      rows.map((row) => this.present(row, nowMs)),
    );
    const start = (paging.page - 1) * paging.pageSize;
    return {
      count: views.length,
      results: sortRoutines(views)
        .slice(start, start + paging.pageSize)
        .map((view) => routineRow(view)),
    };
  }

  /** The Recurring badge: exactly the routines `listForCustomer` pages. */
  countForCustomer(customerId: string): Promise<number> {
    return this.prisma.bookingSeries.count({
      where: { source: 'mobile', customerId: toUuid(customerId) },
    });
  }

  /**
   * Upcoming and Archive (step 5): which of these bookings are visits of an
   * app routine, as booking id to routine id. A desk series is left out:
   * the hub answers only for routines the app made, so its id would open
   * a 404.
   */
  async appRoutinesOf(
    bookingIds: readonly string[],
  ): Promise<Map<string, string>> {
    if (bookingIds.length === 0) return new Map();
    const bookings = await this.prisma.booking.findMany({
      where: { id: { in: [...bookingIds] }, seriesId: { not: null } },
      select: { id: true, seriesId: true },
    });
    const seriesIds = [
      ...new Set(bookings.flatMap((b) => (b.seriesId ? [b.seriesId] : []))),
    ];
    if (seriesIds.length === 0) return new Map();
    const app = await this.prisma.bookingSeries.findMany({
      where: { id: { in: seriesIds }, source: 'mobile' },
      select: { id: true },
    });
    const appIds = new Set(app.map((s) => s.id));
    return new Map(
      bookings.flatMap((b) =>
        b.seriesId && appIds.has(b.seriesId)
          ? [[b.id, b.seriesId] as [string, string]]
          : [],
      ),
    );
  }

  private async load(seriesId: string): Promise<SeriesRowLoaded | null> {
    // A malformed id is 404, not a 500 from the uuid cast.
    if (!UUID_RE.test(seriesId)) return null;
    const row = await this.prisma.bookingSeries.findUnique({
      where: { id: seriesId },
      include: { occurrences: { orderBy: { index: 'asc' } } },
    });
    if (row === null || row.source !== 'mobile') return null;
    return row;
  }

  /** The customer who made it, or staff of its salon. */
  private visible(series: SeriesRowLoaded, who: SeriesReader): boolean {
    if (who.actorKind === 'customer') {
      return series.customerId === toUuid(who.actorId);
    }
    if (who.actorKind === 'staff' || who.actorKind === 'manager') {
      return (
        who.actorBranchId === null ||
        series.branchId === toUuid(who.actorBranchId)
      );
    }
    return false;
  }

  private async present(
    series: SeriesRowLoaded,
    nowMs: number,
  ): Promise<MobileSeriesView> {
    const bookingIds = series.occurrences
      .map((o) => o.bookingId)
      .filter((id): id is string => id !== null);

    const [bookings, noShows] = await Promise.all([
      bookingIds.length === 0
        ? Promise.resolve([] as BookingLoaded[])
        : (this.prisma.booking.findMany({
            where: { id: { in: bookingIds } },
            select: {
              id: true,
              code: true,
              status: true,
              tradingDay: true,
              startMinute: true,
              durationMin: true,
              priceFils: true,
              netFils: true,
              taxFils: true,
              discountFils: true,
              items: {
                orderBy: { position: 'asc' },
                select: { serviceId: true, serviceName: true, staffId: true },
              },
              products: { select: { priceFils: true, quantity: true } },
            },
          }) as unknown as Promise<BookingLoaded[]>),
      bookingIds.length === 0
        ? Promise.resolve([] as { bookingId: string; actorKind: string }[])
        : this.prisma.bookingStatusHistory.findMany({
            where: { bookingId: { in: bookingIds }, toStatus: 'no_show' },
            select: { bookingId: true, actorKind: true },
          }),
    ]);
    const byId = new Map(bookings.map((b) => [b.id, b]));
    const noShowBy = new Map(
      noShows.map((h) => [
        h.bookingId,
        h.actorKind === 'system' ? ('system' as const) : ('staff' as const),
      ]),
    );

    const facts: SessionFacts[] = series.occurrences.map((o) => {
      const b = o.bookingId === null ? undefined : byId.get(o.bookingId);
      const d = b === undefined ? day(o.plannedDay) : day(b.tradingDay);
      const minute = b === undefined ? o.plannedStartMin : b.startMinute;
      return {
        id: o.id,
        index: o.index,
        day: d,
        startAtMs: branchInstant(d, minute).getTime(),
        state: o.state,
        bookingStatus: b?.status ?? null,
        noShowBy: b?.status === 'no_show' ? (noShowBy.get(b.id) ?? null) : null,
      };
    });

    const { index, staff, services } = await this.namesFor(
      series,
      facts[0]?.day ?? day(series.createdAt),
    );
    const status = series.status;
    const counted = tally(facts, nowMs);

    const sessionView = (f: SessionFacts): SessionView => {
      const o = series.occurrences.find((x) => x.id === f.id)!;
      const b = o.bookingId === null ? undefined : byId.get(o.bookingId);
      const minute = b?.startMinute ?? o.plannedStartMin;
      const staffId =
        b?.items[0]?.staffId === undefined || b.items[0].staffId === null
          ? series.preferredStaffId
          : b.items[0].staffId;
      const slug = staffId === null ? null : index.toSlug(staffId);
      const changeable =
        status === 'active' && changeRefusal(f, nowMs) === null;
      const total =
        b === undefined
          ? null
          : (storedTotalFils(b) ?? b.priceFils) +
            productMoney(b.products).totalFils;
      return {
        id: f.id,
        index: f.index,
        date: f.day,
        start_time: toOffsetIso(
          branchInstant(f.day, minute),
          BRANCH_UTC_OFFSET_MIN,
        ),
        end_time:
          b === undefined
            ? null
            : toOffsetIso(
                branchInstant(f.day, b.startMinute + b.durationMin),
                BRANCH_UTC_OFFSET_MIN,
              ),
        state: sessionWord(f, nowMs),
        booking_id: b?.id ?? null,
        booking_code: b?.code ?? null,
        stylist:
          slug === null ? null : { id: slug, name: staff.get(slug) ?? null },
        total: total === null ? null : filsToAed(total),
        locked: f.startAtMs - nowMs < ROUTINE_RULES.lockHours * 3_600_000,
        can_skip: changeable,
        can_reschedule: changeable,
      };
    };

    const sessions = [...facts]
      .sort((a, b) => a.index - b.index)
      .map(sessionView);
    const live = sessions.filter(
      (s) => s.state !== 'SKIPPED' && s.state !== 'CANCELLED',
    );
    const totalFils = live.reduce(
      (n, s) => n + (s.total === null ? 0 : Math.round(s.total * 100)),
      0,
    );

    const pause = effectivePause({
      status,
      pausedUntil: series.pausedUntil === null ? null : day(series.pausedUntil),
      pauseReason: series.pauseReason,
      pauseNote: series.pauseNote,
    });
    const regular =
      series.preferredStaffId === null
        ? null
        : index.toSlug(series.preferredStaffId);
    const serviceIds =
      series.serviceIds !== null && series.serviceIds.length > 0
        ? series.serviceIds
        : [series.serviceId];

    return {
      id: series.id,
      booking_type: 'ROUTINE',
      salon_id: index.toSlug(series.branchId),
      status: toRoutineStatus(status),
      frequency: frequencyFromColumn(series.frequency),
      time: formatMinute(series.startMin),
      stylist:
        regular === null
          ? null
          : { id: regular, name: staff.get(regular) ?? null },
      services: serviceIds.map((id) => {
        const slug = index.toSlug(id);
        return { id: slug, name: services.get(slug) ?? null };
      }),
      payment_plan:
        series.paymentPlan === null
          ? null
          : (series.paymentPlan.toUpperCase() as PaymentPlan),
      pause:
        pause === null
          ? null
          : { ...pause, reason: pauseReasonFromColumn(pause.reason) },
      counts: {
        total: counted.total,
        done: counted.done,
        remaining: counted.remaining,
        skipped: counted.skipped,
        cancelled: counted.cancelled,
      },
      next_session:
        counted.next === null
          ? null
          : (sessions.find((s) => s.id === counted.next!.id) ?? null),
      sessions,
      money: { total: filsToAed(totalFils), pay_now: 0 },
      can: routineCan(status, facts, nowMs),
      rules: RULES_VIEW,
      created_at: toOffsetIso(series.createdAt, BRANCH_UTC_OFFSET_MIN),
    };
  }

  /**
   * The roster and catalogue names, and the slugs the app sent in.
   *
   * A NAME IS DECORATION, as in the group read: a platform that is down
   * leaves the names off, it does not make the routine unreadable. Run in
   * the routine's own tenant when the request carried none.
   */
  private async namesFor(
    series: { branchId: string; tenantId: string | null },
    onDay: string,
  ): Promise<{
    index: SlugIndex;
    staff: ReadonlyMap<string, string>;
    services: ReadonlyMap<string, string>;
  }> {
    const branch = new SlugIndex([DEFAULT_BRANCH_ID]).toSlug(series.branchId);
    const load = async () => {
      const [roster, catalogue] = await Promise.all([
        this.context.loadDay(branch, onDay),
        this.context.loadCatalogue(branch),
      ]);
      return {
        index: new SlugIndex([
          ...roster.professionals.map((p) => p.id),
          ...catalogue.map((c) => c.id),
          DEFAULT_BRANCH_ID,
        ]),
        staff: new Map(roster.professionals.map((p) => [p.id, p.name])),
        services: new Map(catalogue.map((c) => [c.id, c.name])),
      };
    };
    try {
      return this.tenants.current() !== null || series.tenantId === null
        ? await load()
        : await this.tenants.run(series.tenantId, load);
    } catch {
      return {
        index: new SlugIndex([DEFAULT_BRANCH_ID]),
        staff: new Map(),
        services: new Map(),
      };
    }
  }
}

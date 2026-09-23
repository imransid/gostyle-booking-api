import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  ReadModelRepository,
  type BookingRow,
} from '@infrastructure/persistence/read-model.repository';
import {
  BOOKING_CONTEXT,
  type BookingContextReader,
} from '@application/ports/booking-context.port';
import {
  CUSTOMER_CONTEXT,
  type CustomerContextReader,
} from '@application/ports/customer-context.port';
import {
  branchInstant,
  branchNowMinute,
  branchToday,
} from '@infrastructure/persistence/hold.repository';
import { SlugIndex } from '@infrastructure/persistence/slug-uuid';
import {
  formatMinute,
  DAY_START_MIN,
  DAY_END_MIN,
} from '@domain/availability/grid';
import { Money } from '@domain/shared/money';
import {
  kpi,
  moneyKpi,
  rankSearch,
  sellableMinutes,
  showUpRate,
  utilisation,
  wholeAed,
  categoryOf,
  conflictKindOf,
  conflictSourceOf,
  type Kpi,
  type SearchCandidate,
} from '@domain/booking/read-models';
import {
  LIVE_STATUSES,
  CALENDAR_CHIPS,
  CHIP_STATUSES,
  isCalendarChip,
  isListFilter,
  statusesFor,
  statusesForChips,
  toDepositOutcome,
  toScreenPayment,
  toScreenStatus,
  type ListFilter,
} from '@application/contract/screen-view';
import type { BookingStatus } from '@domain/booking/lifecycle';
import { LATE_CANCEL_WINDOW_HOURS } from '@domain/booking/lifecycle';
import {
  cancelTiming,
  groupReasons,
  policyWindow,
  summarise,
  type EventKind,
} from '@domain/booking/cancellation-feed';
import type { PaymentStatus } from '../../generated/prisma/enums';
import { bookingError } from '@application/contract/errors';
import {
  deriveSeriesHealth,
  type SeriesFacts,
} from '@domain/booking/series-health';

/**
 * The read side of the bookings module.
 *
 * Seven screens, one set of queries. Everything here is derived: nothing in
 * this file writes, and nothing in it decides anything the domain has not
 * already decided. Where a number needed a rule -- utilisation, a delta
 * string, search ranking -- the rule is in `domain/booking/read-models.ts`
 * with its own spec, and this file only assembles.
 */

// ------------------------------------------------------------ shared shape

/** The row every list and the calendar render. Contract §5.1. */
export interface BookingView {
  readonly id: string;
  readonly code: string;
  readonly status: string;
  /** Our own word, always. See screen-view.ts on ambiguity. */
  readonly statusDetail: string;
  readonly customer: {
    readonly id: string;
    /**
     * What to print. Null when no directory could name them -- see
     * CustomerContext.name. The client renders the id as a fallback; it must
     * not go and look the name up per row, which is what it was doing.
     */
    readonly name: string | null;
    readonly tier: string | null;
    readonly isNew: boolean;
    readonly requiresDeposit: boolean;
    readonly riskBand: string;
    readonly riskScore: number;
  };
  readonly services: readonly string[];
  /**
   * The band the calendar colours by. Derived, never stored -- see
   * categoryOf(). The client was deriving this from resourceTypes[0], which
   * collapsed styling/color/wash into one indistinguishable band.
   */
  readonly category: string;
  readonly staff: { readonly id: string | null; readonly name: string | null };
  readonly date: string;
  readonly startTime: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly durationMinutes: number;
  readonly price: number;
  readonly priceMinor: number;
  readonly payment: {
    readonly state: string;
    readonly deposit: number;
    readonly depositMinor: number;
    readonly depositOutcome: string | null;
    readonly requirement: { readonly source: string | null };
    readonly linkExpiresAt: string | null;
  };
  readonly channel: string;
  readonly moveCount: number;
  readonly reminded: boolean;
  readonly remindedAt: {
    readonly confirm24h: string | null;
    readonly dayOf3h: string | null;
    readonly nudge15m: string | null;
  };
  readonly overbook: {
    readonly reason: string | null;
  } | null;
  readonly group: { readonly id: string } | null;
  /**
   * Why this booking can no longer be delivered, and what is proposed.
   *
   * Null on a healthy booking. The CONFLICTS chip and the worklist tile both
   * route here; before this was populated they routed to rows that showed no
   * cause and offered no repair.
   */
  readonly conflict: {
    readonly kind: string;
    readonly cause: string;
    readonly sourceEvent: string;
    readonly raisedAt: string;
    readonly staffId: string | null;
    readonly resourceClass: string | null;
    /** Where to resolve it. */
    readonly changeId: string;
    readonly itemId: string;
    /** Set once the ladder has run out of rungs and prepared a cancellation. */
    readonly proposed: unknown;
  } | null;
  readonly resourceTypes: readonly string[];
}

/**
 * Row to view.
 *
 * `staffNames` and `customers` are passed in already resolved. Resolving them
 * per row would be a gRPC call per booking, and the day grid renders forty.
 */
function toView(
  r: BookingRow,
  staffNames: ReadonlyMap<string, string>,
  /** Folded id -> roster slug. See the note in decorate(). */
  staffSlugs: ReadonlyMap<string, string>,
  conflict: ConflictRow | undefined,
  customer: {
    name: string | null;
    tier: string;
    risk: string;
    riskScore: number;
    isNewCustomer: boolean;
    requireDepositFlag: boolean;
  },
): BookingView {
  const day = r.trading_day.toISOString().slice(0, 10);
  const endMin = r.start_minute + r.duration_min;
  const staffId = r.staff_ids?.[0] ?? null;

  return {
    id: r.id,
    code: r.code,
    status: toScreenStatus(r.status),
    statusDetail: r.status.toUpperCase(),
    customer: {
      id: r.customer_id,
      name: customer.name,
      tier: customer.tier === 'none' ? null : customer.tier.toUpperCase(),
      isNew: customer.isNewCustomer,
      requiresDeposit: customer.requireDepositFlag,
      riskBand: customer.risk,
      riskScore: customer.riskScore,
    },
    services: r.service_names ?? [],
    category: categoryOf(r.resource_types ?? []),
    staff: {
      /**
       * THE SLUG, not the stored hash.
       *
       * The series board and the waitlist board already published slugs, and
       * this list published the folded uuid -- so the same stylist arrived as
       * "maya" on one screen and "8d820e0c-…" on another. A client keying a
       * cache on one and looking it up with the other finds nothing, silently
       * (CLAUDE.md 8). Every endpoint now spells a professional the same way.
       */
      id: staffId === null ? null : (staffSlugs.get(staffId) ?? staffId),
      name: staffId === null ? null : (staffNames.get(staffId) ?? null),
    },
    date: day,
    startTime: formatMinute(r.start_minute),
    startsAt: branchInstant(day, r.start_minute).toISOString(),
    endsAt: branchInstant(day, endMin).toISOString(),
    durationMinutes: r.duration_min,
    price: wholeAed(r.price_fils),
    priceMinor: r.price_fils,
    payment: {
      state: toScreenPayment(r.payment_status as PaymentStatus),
      deposit: wholeAed(r.deposit_fils),
      depositMinor: r.deposit_fils,
      depositOutcome: toDepositOutcome(r.payment_status as PaymentStatus),
      requirement: { source: r.requirement_source },
      linkExpiresAt:
        r.link_expires_at === null ? null : r.link_expires_at.toISOString(),
    },
    channel: r.channel.toUpperCase(),
    moveCount: r.move_count,
    // "Reminded" on the chip means the confirm-or-move message went out.
    // The other two rungs are day-of noise and do not change the chip.
    reminded: r.reminded_24h_at !== null,
    remindedAt: {
      confirm24h: r.reminded_24h_at?.toISOString() ?? null,
      dayOf3h: r.reminded_3h_at?.toISOString() ?? null,
      nudge15m: r.nudged_15m_at?.toISOString() ?? null,
    },
    overbook: r.overbooked ? { reason: r.overbook_reason } : null,
    group: r.group_id === null ? null : { id: r.group_id },
    conflict:
      conflict === undefined
        ? null
        : {
            kind: conflictKindOf(conflict.kind, conflict.staffId !== null),
            cause: conflict.reason,
            sourceEvent: conflictSourceOf(conflict.kind),
            raisedAt: conflict.raisedAt.toISOString(),
            // Folded like every other professional id on this payload.
            staffId:
              conflict.staffId === null
                ? null
                : (staffSlugs.get(conflict.staffId) ?? conflict.staffId),
            resourceClass: conflict.resourceType,
            changeId: conflict.changeId,
            itemId: conflict.itemId,
            proposed: conflict.proposal ?? null,
          },
    resourceTypes: r.resource_types ?? [],
  };
}

// ------------------------------------------------------------ date helpers

/** Trading days are branch-local calendar dates; all arithmetic is on those. */
function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** The branch's today. Defined once, in hold.repository, beside its inverse. */
function today(): string {
  return branchToday();
}

function monthBounds(month: string): { from: string; to: string } {
  const [y, m] = month.split('-').map(Number);
  const from = `${month}-01`;
  const next =
    m === 12
      ? `${(y ?? 0) + 1}-01-01`
      : `${y}-${String((m ?? 1) + 1).padStart(2, '0')}-01`;
  return { from, to: next };
}

// ------------------------------------------------------------ the handler

const WEEK_LIMIT = 2_000;

@Injectable()
export class BookingReadHandler {
  constructor(
    private readonly reads: ReadModelRepository,
    @Inject(BOOKING_CONTEXT) private readonly context: BookingContextReader,
    @Inject(CUSTOMER_CONTEXT) private readonly customers: CustomerContextReader,
  ) {}

  // ---------------------------------------------------------------- list

  /** §6.6. The upcoming list and every other filtered read. */
  async list(q: {
    branchId: string;
    filter?: string | undefined;
    from?: string | undefined;
    to?: string | undefined;
    staffId?: string | undefined;
    customerId?: string | undefined;
    page?: number | undefined;
    pageSize?: number | undefined;
  }): Promise<{
    data: BookingView[];
    page: number;
    pageSize: number;
    total: number;
    counts: Record<string, number>;
  }> {
    const filter = this.readFilter(q.filter);
    const page = Math.max(1, q.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, q.pageSize ?? 25));

    const window = this.windowFor(filter, q.from, q.to);
    const base = {
      branchId: q.branchId,
      ...window,
      ...(statusesFor(filter) === null
        ? {}
        : { statuses: statusesFor(filter)! }),
      ...(q.staffId === undefined ? {} : { staffId: q.staffId }),
      ...(q.customerId === undefined ? {} : { customerId: q.customerId }),
      notReminded: filter === 'NOT_REMINDED',
      conflictsOnly: filter === 'CONFLICTS',
    };

    const [rows, total, counts] = await Promise.all([
      this.reads.list({
        ...base,
        limit: pageSize,
        offset: (page - 1) * pageSize,
      }),
      this.reads.count(base),
      this.counts(q.branchId),
    ]);

    return {
      data: await this.decorate(q.branchId, rows),
      page,
      pageSize,
      total,
      counts,
    };
  }

  /**
   * The chip counts.
   *
   * Computed against the UNFILTERED set, as the contract requires: a chip
   * that showed the count of what you are already looking at would read "6"
   * on every chip you clicked.
   */
  private async counts(branchId: string): Promise<Record<string, number>> {
    const from = today();
    const horizon = addDays(from, 90);

    const [
      all,
      todayN,
      tomorrow,
      deposit,
      conflicts,
      notReminded,
      unconfirmed,
    ] = await Promise.all([
      this.reads.count({ branchId, fromDay: from, toDay: horizon }),
      this.reads.count({
        branchId,
        fromDay: from,
        toDay: addDays(from, 1),
      }),
      this.reads.count({
        branchId,
        fromDay: addDays(from, 1),
        toDay: addDays(from, 2),
      }),
      this.reads.count({
        branchId,
        fromDay: from,
        toDay: horizon,
        statuses: ['pending_payment'],
      }),
      this.reads.count({
        branchId,
        fromDay: from,
        toDay: horizon,
        conflictsOnly: true,
      }),
      this.reads.count({
        branchId,
        fromDay: from,
        toDay: horizon,
        notReminded: true,
      }),
      /**
       * UNCONFIRMED WAS THE ONE CHIP WITH NO NUMBER.
       *
       * `filter=UNCONFIRMED` worked and returned rows; the projection just
       * never counted it, and the OpenAPI text said so as though it were a
       * decision. The predicate already exists -- `statusesFor` owns it --
       * so there was nothing to decide.
       */
      this.reads.count({
        branchId,
        fromDay: from,
        toDay: horizon,
        statuses: statusesFor('UNCONFIRMED') ?? undefined,
      }),
    ]);

    return {
      ALL: all,
      TODAY: todayN,
      TOMORROW: tomorrow,
      DEPOSIT_PENDING: deposit,
      CONFLICTS: conflicts,
      NOT_REMINDED: notReminded,
      UNCONFIRMED: unconfirmed,
    };
  }

  private readFilter(raw: string | undefined): ListFilter {
    if (raw === undefined || raw === '') return 'ALL';
    if (!isListFilter(raw)) {
      throw bookingError(
        'BOOKING_REASON_REQUIRED',
        `Unknown filter "${raw}".`,
        { filter: raw },
      );
    }
    return raw;
  }

  private windowFor(
    filter: ListFilter,
    from: string | undefined,
    to: string | undefined,
  ): { fromDay: string; toDay: string } {
    const base = today();
    if (filter === 'TODAY') {
      return { fromDay: base, toDay: addDays(base, 1) };
    }
    if (filter === 'TOMORROW') {
      return { fromDay: addDays(base, 1), toDay: addDays(base, 2) };
    }
    /**
     * BOTH ENDS INCLUSIVE, and `toDay` is exclusive underneath.
     *
     * `to` was passed through as the exclusive bound, so `from=X&to=X` --
     * the obvious way to ask for one day -- returned nothing, and a
     * from-only query that returned 102 rows collapsed to 0 the moment a
     * `to` was added. Nobody types a half-open range on a date picker.
     */
    return {
      fromDay: from ?? base,
      toDay: to === undefined ? addDays(from ?? base, 90) : addDays(to, 1),
    };
  }

  // ------------------------------------------------------------ calendar

  /** §6.3. The day grid, its columns and its KPI strip. */
  async day(
    branchId: string,
    date: string,
    filters: { staffId?: string | undefined; status?: string | undefined },
  ): Promise<unknown> {
    /**
     * THE CHIPS, READ ONCE.
     *
     * `status=checked_in,in_service` arrives as one string. An unknown word
     * is dropped rather than silently matching nothing -- the controller
     * refuses it before it reaches here.
     */
    const chips = (filters.status ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== '')
      .filter(isCalendarChip);

    const chosen = statusesForChips(chips);

    /**
     * EVERY STATUS A CHIP CAN REACH, not just the live ones.
     *
     * The read defaulted to LIVE_STATUSES, which excludes no_show and
     * cancelled -- so those two chips filtered a list their bookings were
     * never in and always returned nothing, silently. The day is read wide
     * and the KPIs narrow back to live below.
     */
    const window = {
      branchId,
      fromDay: date,
      toDay: addDays(date, 1),
      statuses: CHIP_STATUSES,
      ...(filters.staffId === undefined ? {} : { staffId: filters.staffId }),
    };

    /**
     * TWO READS, DELIBERATELY.
     *
     * `all` is the whole day and feeds the KPI strip; `rows` is what the
     * chips narrowed to and feeds the grid. Computing the strip from the
     * filtered set made "Cancelled" report cancelled bookings as booked
     * revenue -- a number that describes the filter, not the day.
     */
    const [all, ctx] = await Promise.all([
      this.reads.list(window),
      this.context.loadDay(branchId, date),
    ]);

    /**
     * NO CHIP MEANS LIVE VISITS, not everything.
     *
     * The day is read wide so the no-show and cancelled chips have rows to
     * find, but opening the diary should show today's work, not last week's
     * losses. A cancelled visit is something you go looking for.
     */
    const rows = all.filter((r) =>
      (chosen ?? LIVE_STATUSES).includes(r.status),
    );

    const bookings = await this.decorate(branchId, rows);

    // Same boundary as decorate(): the rows hold hashes, the roster holds
    // slugs, so the load count is matched on the folded id, not the slug.
    const index = new SlugIndex(ctx.professionals.map((p) => p.id));

    /**
     * THE DENOMINATOR NARROWS WITH THE FILTER, and it did not.
     *
     * `staffId=anya` narrowed the bookings to Anya's 85 minutes and still
     * divided by the branch's 3180 sellable minutes, so a stylist who was
     * 16% booked on her own shift rendered as "3% of sellable time". A
     * utilisation figure whose numerator and denominator describe different
     * populations is not a low number, it is a wrong one -- and the front
     * end was right to refuse to recompute it client-side.
     */
    const inView =
      filters.staffId === undefined
        ? ctx.professionals
        : ctx.professionals.filter(
            (p) => p.id === index.toSlug(filters.staffId!),
          );

    const columns = inView.map((p) => {
      const mine = rows.filter((r) =>
        (r.staff_ids ?? []).some((id) => index.toSlug(id) === p.id),
      );
      return {
        staffId: p.id,
        name: p.name,
        shift: { fromMinute: p.shift.startMin, toMinute: p.shift.endMin },
        /**
         * EMPTY, AND HONESTLY SO. Approved time off reaches the engine as
         * opaque entries on the professional's calendar (see Shift in
         * staff-mask.ts: "Breaks and time off are passed as bookings"), so
         * there is no separate list to publish. The minutes ARE excluded
         * from availability; they simply cannot be labelled yet.
         */
        timeOff: [] as { fromMinute: number; toMinute: number }[],
        load: mine.length,
      };
    });

    /**
     * THE STRIP COUNTS LIVE BOOKINGS ONLY.
     *
     * `all` now carries cancelled and no-showed visits so their chips work.
     * Counting them as booked revenue would report lost money as earned.
     */
    const live = all.filter((r) =>
      (LIVE_STATUSES as readonly string[]).includes(r.status),
    );

    const bookedMin = live.reduce((n, r) => n + r.duration_min, 0);
    const sellable = inView.reduce(
      (n, p) =>
        n +
        sellableMinutes({
          shift: { fromMin: p.shift.startMin, toMin: p.shift.endMin },
          timeOff: [],
        }),
      0,
    );

    const walkIns = await this.reads.walkInPressure(
      branchId,
      date,
      nowMinute(),
    );

    return {
      date,
      openMinute: DAY_START_MIN,
      closeMinute: DAY_END_MIN,
      nowMinute: nowMinute(),
      closureReason: ctx.closureReason ?? null,
      columns,
      bookings,
      /**
       * THE STRIP DESCRIBES THE DAY, NOT THE FILTER.
       *
       * Every figure here reads `all`, never `rows`. Tapping a chip narrows
       * the grid below and leaves these still, which is what the desk
       * expects of a header.
       */
      counts: chipCounts(all),
      kpis: {
        booked: live.length,
        utilisation: Number(utilisation(bookedMin, sellable).toFixed(4)),
        revenue: wholeAed(live.reduce((n, r) => n + r.price_fils, 0)),
        pendingDeposits: live.filter((r) => r.status === 'pending_payment')
          .length,
        conflicts: (await this.reads.openConflicts(branchId)).filter(
          (c) => c.trading_day.toISOString().slice(0, 10) === date,
        ).length,
        walkInsWaiting: walkIns.waiting,
      },
    };
  }

  /** §6.4. Seven day summaries, each with its bookings. */
  async week(branchId: string, from: string): Promise<unknown> {
    const to = addDays(from, 7);

    /**
     * THE CEILING IS DECLARED, AND SAID OUT LOUD WHEN IT IS HIT.
     *
     * This asked for the week without a limit and got the repository's
     * default 500. The per-day counts come from a different query with no
     * cap at all, so a busy week showed a strip reading 612 above a grid
     * holding 500, with nothing to explain the gap. A week grid cannot be
     * paged -- it needs all seven days at once to draw -- so the ceiling is
     * raised to a number no salon reaches and the response admits when it
     * was reached.
     */
    const [rows, totals] = await Promise.all([
      this.reads.list({
        branchId,
        fromDay: from,
        toDay: to,
        limit: WEEK_LIMIT,
      }),
      this.reads.dailyTotals(branchId, from, to),
    ]);

    /**
     * DERIVED FROM THE STRIP, NOT COUNTED AGAIN.
     *
     * The day totals already narrow by the same branch, the same dates and
     * the same live statuses as the list, so their sum IS the week's size. A
     * separate count() was a second copy of that number: one more query, and
     * one more place for the strip and `total` to drift apart.
     */
    const total = totals.reduce((sum, t) => sum + t.n, 0);

    const views = await this.decorate(branchId, rows);
    const byDay = new Map(totals.map((t) => [t.day, t]));

    return {
      days: Array.from({ length: 7 }, (_, i) => {
        const date = addDays(from, i);
        const t = byDay.get(date);
        return {
          date,
          count: t?.n ?? 0,
          revenue: wholeAed(t?.revenueFils ?? 0),
          bookings: views.filter((v) => v.date === date),
        };
      }),
      /** How many the week really holds, and how many came back. */
      total,
      returned: rows.length,
      /** True when the week holds more than the grid was given. */
      truncated: total > rows.length,
      limit: WEEK_LIMIT,
    };
  }

  /** §6.5. One cell per day, and whether it is inside the lead horizon. */
  async month(
    branchId: string,
    month: string,
    horizonDays: number,
  ): Promise<unknown> {
    const { from, to } = monthBounds(month);
    const totals = await this.reads.dailyTotals(branchId, from, to);
    const byDay = new Map(totals.map((t) => [t.day, t]));

    const lastBookable = addDays(today(), horizonDays);
    const cells: unknown[] = [];
    for (let d = from; d < to; d = addDays(d, 1)) {
      cells.push({
        date: d,
        count: byDay.get(d)?.n ?? 0,
        revenue: wholeAed(byDay.get(d)?.revenueFils ?? 0),
        withinHorizon: d <= lastBookable,
      });
    }
    return { month, cells };
  }

  // ------------------------------------------------------------- summary

  /** §6.1. The KPI strip and the trend chart. */
  async summary(branchId: string, range: number): Promise<unknown> {
    const end = addDays(today(), 1);
    const start = addDays(end, -range);
    const priorStart = addDays(start, -range);

    const [current, prior, totals] = await Promise.all([
      this.reads.windowStats(branchId, start, end),
      this.reads.windowStats(branchId, priorStart, start),
      this.reads.dailyTotals(branchId, start, end),
    ]);

    const byDay = new Map(totals.map((t) => [t.day, t]));
    const trend: unknown[] = [];
    for (let d = start; d < end; d = addDays(d, 1)) {
      trend.push({
        date: d,
        label: new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', {
          weekday: 'short',
          timeZone: 'UTC',
        }),
        bookings: byDay.get(d)?.n ?? 0,
        revenue: wholeAed(byDay.get(d)?.revenueFils ?? 0),
      });
    }

    const avg = (s: typeof current): number =>
      s.bookings === 0 ? 0 : Math.round(s.revenueFils / s.bookings);

    const rate = showUpRate(current);
    const priorRate = showUpRate(prior);

    return {
      range,
      bookings: kpi(current.bookings, prior.bookings),
      revenue: moneyKpi(current.revenueFils, prior.revenueFils),
      showUpRate: {
        value: Number(rate.toFixed(4)),
        delta: kpi(rate, priorRate, 'points').delta,
      },
      averageTicket: {
        value: wholeAed(avg(current)),
        delta: kpi(wholeAed(avg(current)), wholeAed(avg(prior)), 'absolute')
          .delta,
      },
      noShows: kpi(current.noShows, prior.noShows, 'absolute'),
      trend,
      bookingsToday: byDay.get(today())?.n ?? 0,
    } satisfies Record<string, unknown> & { bookings: Kpi };
  }

  // ------------------------------------------------------------ worklist

  /** §6.2. One row per real problem, each with the screen that fixes it. */
  async worklist(branchId: string): Promise<unknown> {
    const day = today();
    const [deposits, conflicts, atRisk, walkIns] = await Promise.all([
      this.reads.depositsPending(branchId, day),
      this.reads.openConflicts(branchId),
      this.reads.seriesAtRisk(branchId),
      this.reads.walkInPressure(branchId, day, nowMinute()),
    ]);

    const items: unknown[] = [];

    if (deposits > 0) {
      items.push({
        kind: 'DEPOSITS_PENDING',
        severity: 'WARN',
        count: deposits,
        target: { screen: 'UPCOMING', filter: 'DEPOSIT_PENDING' },
      });
    }
    if (conflicts.length > 0) {
      items.push({
        kind: 'CONFLICTS',
        severity: 'DANGER',
        count: conflicts.length,
        target: { screen: 'UPCOMING', filter: 'CONFLICTS' },
      });
    }
    for (const s of atRisk) {
      items.push({
        kind: 'SERIES_AT_RISK',
        severity: 'DANGER',
        count: 1,
        context: { seriesId: s.id, customerId: s.customer_id },
        target: { screen: 'RECURRING', seriesId: s.id },
      });
    }
    if (walkIns.waiting > 0) {
      items.push({
        kind: 'WALK_INS_WAITING',
        severity: 'INFO',
        count: walkIns.waiting,
        context: { longestWaitMinutes: walkIns.longestWaitMin },
        target: { screen: 'WALK_INS' },
      });
    }

    /**
     * DUPLICATE_CUSTOMER and DIARY_SLIVERS are absent, not empty.
     *
     * Duplicate detection needs the customer service, which this module reads
     * through a port that answers tier and risk and nothing else. Slivers
     * need the compaction plan, which is a per-day engine run; putting it in
     * the overview would make the cheapest screen the slowest. Both are
     * listed in the FE contract and neither is faked here -- an INFO tile
     * that always reads zero is worse than no tile.
     */
    return { items };
  }

  // -------------------------------------------------------------- search

  /** §6.7. The command palette. */
  async search(branchId: string, q: string, limit: number): Promise<unknown> {
    const query = q.trim();
    if (query === '') return { results: [] };

    const [raw, slugs] = await Promise.all([
      this.reads.searchCandidates(branchId, query, limit),
      this.slugIndex(branchId),
    ]);

    const candidates: SearchCandidate[] = [
      ...raw.bookings.map((b): SearchCandidate => {
        const day = b.trading_day.toISOString().slice(0, 10);
        return {
          kind: 'BOOKING',
          id: b.id,
          label: `${b.code} · ${(b.service_names ?? []).join(', ')}`,
          detail: `${day} ${formatMinute(b.start_minute)}`,
          code: b.code,
          haystack: [b.code, ...(b.service_names ?? [])],
        };
      }),
      ...raw.services.map((s): SearchCandidate => ({
        kind: 'SERVICE',
        /**
         * THE ENGINE'S ID, not the stored one.
         *
         * `booking_item.service_id` is the folded uuid, and a palette hit
         * carrying it 404'd on `/availability` and `/eligible-staff` and
         * appeared in no directory -- so the one useful thing to do with a
         * SERVICE result could not be done. SlugIndex hands back the
         * spelling the catalogue answers to, and passes a real platform
         * uuid through untouched (CLAUDE.md 8).
         */
        id: slugs.toSlug(s.service_id),
        label: s.service_name,
        detail: `${s.duration_min} min · ${Money.fils(s.price_fils).toString()}`,
        haystack: [s.service_name],
      })),
    ];

    return {
      results: rankSearch(candidates, query, limit).map((c) => ({
        kind: c.kind,
        id: c.id,
        label: c.label,
        detail: c.detail,
      })),
    };
  }

  // -------------------------------------------------------------- events

  /** §9.1. Cancellations and no-shows, read out of the status history. */
  async events(q: {
    branchId: string;
    range: number;
    kind?: string | undefined;
    page?: number | undefined;
    pageSize?: number | undefined;
  }): Promise<unknown> {
    const end = addDays(today(), 1);
    const start = addDays(end, -q.range);
    const page = Math.max(1, q.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, q.pageSize ?? 25));

    /**
     * LATE_CANCEL IS A REAL FILTER NOW.
     *
     * It used to fall through to CANCELLED and answer 200 with every
     * cancellation -- a filter that silently means something else, which is
     * the most expensive kind of wrong answer a read model can give. An
     * unknown kind is refused by the controller before it reaches here.
     */
    const kind = (q.kind ?? 'ALL') as EventKind;
    const kinds: BookingStatus[] =
      kind === 'NO_SHOW'
        ? ['no_show']
        : kind === 'CANCELLED' || kind === 'LATE_CANCEL'
          ? ['cancelled']
          : ['cancelled', 'no_show'];
    const lateOnly = kind === 'LATE_CANCEL';

    const window = {
      branchId: q.branchId,
      fromDay: start,
      toDay: end,
      kinds,
      lateOnly,
      lateCancelWindowHours: LATE_CANCEL_WINDOW_HOURS,
    };

    const [rows, total, totals, reasonRows] = await Promise.all([
      this.reads.events({
        ...window,
        limit: pageSize,
        offset: (page - 1) * pageSize,
      }),
      this.reads.countEvents(window),
      this.reads.eventTotals(window),
      this.reads.eventReasons(window),
    ]);

    const names = await this.customerNames(rows.map((r) => r.customer_id));

    const data = rows
      .map((r) => toEventView(r, names))
      // The page is fetched before the late window can be applied -- it is a
      // fact about two timestamps, not a column -- so LATE_CANCEL narrows
      // here as well. The COUNT and the totals narrow in SQL, on the same
      // rule, so the numbers agree.
      .filter((e) => !lateOnly || e.lateCancel);

    return {
      data,
      page,
      pageSize,
      total,
      /**
       * OVER THE WHOLE `range`, and over the active `kind`. Never over the
       * page: that is what made `summary.events` track `pageSize`.
       */
      summary: (() => {
        const s = summarise(totals);
        return {
          events: s.events,
          noShows: s.noShows,
          lostValue: wholeAed(s.lostValueFils),
          depositsKept: wholeAed(s.depositsKeptFils),
          recovered: s.recovered,
        };
      })(),
      /** The same window, grouped. Biggest first; free text folded on case. */
      reasons: groupReasons(reasonRows).map((r) => ({
        reason: r.reason,
        count: r.count,
        value: wholeAed(r.valueFils),
      })),
    };
  }

  /** §9.2. The detail drawer, with the worked policy maths. */
  async event(id: string): Promise<unknown> {
    const r = await this.reads.event(id);
    if (r === null) throw new NotFoundException('No such event');

    const view = toEventView(r, await this.customerNames([r.customer_id]));
    const timing = cancelTiming({
      occurredAtMs: r.created_at.getTime(),
      startAtMs: r.start_at.getTime(),
    });

    return {
      /**
       * EVERY FIELD THE LIST ROW CARRIES, and then the drawer's extras.
       *
       * The detail read published eight fields and the list row published
       * fourteen, so the client cached the row and merged -- which works
       * until somebody opens a deep link or refreshes the page, and then the
       * drawer has nothing to merge with.
       */
      ...view,
      math: [
        { label: 'Service value', value: wholeAed(r.price_fils) },
        { label: 'Deposit captured', value: wholeAed(r.deposit_fils) },
        {
          /**
           * THE WINDOW, DERIVED FROM THE TWO TIMESTAMPS.
           *
           * This read `r.reason` on a cancellation, so the drawer showed a
           * labelled row saying "Policy window: qa backfill test". The
           * reason is already published above, under its own name; the
           * window is a fact about when the cancellation happened relative
           * to the start, and `cancelTiming` is the same rule the refund
           * used.
           */
          label: 'Policy window',
          value: policyWindow({ kind: view.kind, timing }),
        },
        {
          label: 'Outcome',
          value: eventOutcome(r.payment_status as PaymentStatus),
        },
      ],
      /**
       * EMPTY BY HONESTY. §9.2 wants the WhatsApp trail beside the maths.
       * Nothing in this service sends a message -- the reminder ladder marks
       * a rung as fired and writes an outbox event, and the transport does
       * not exist. Returning a fabricated DELIVERED row would be worse than
       * an empty list.
       */
      messageLog: [],
    };
  }

  // ------------------------------------------------------- §14 waitlist

  /**
   * The waitlist board.
   *
   * `waiting` arrives in the SERVER's order and the client renders the
   * position from it. Ranking is join order (see domain/booking/waitlist.ts,
   * which explains why tier is a tie-break that never fires today) and the
   * tier weighting in the front-end contract is an open decision, not an
   * omission.
   */
  async waitlist(branchId: string): Promise<unknown> {
    const from = today();
    const [rows, conversion, slugs] = await Promise.all([
      this.reads.waitlistBoard(branchId, from),
      this.reads.waitlistConversion(branchId, from),
      this.slugIndex(branchId),
    ]);
    const names = await this.customerNames(rows.map((r) => r.customer_id));

    const toEntry = (r: (typeof rows)[number], position: number): unknown => ({
      id: r.id,
      status: r.status.toUpperCase(),
      position,
      customer: { id: r.customer_id, name: names.get(r.customer_id) ?? null },
      service: { id: slugs.toSlug(r.service_id) },
      window: {
        date: r.trading_day.toISOString().slice(0, 10),
        fromMinute: r.window_from_min,
        toMinute: r.window_to_min,
        fromTime: formatMinute(r.window_from_min),
        toTime: formatMinute(r.window_to_min),
      },
      preferredStaffId:
        r.preferred_staff_id === null
          ? null
          : slugs.toSlug(r.preferred_staff_id),
      declineCount: r.decline_count,
      joinedAt: r.joined_at.toISOString(),
      offer:
        r.status !== 'offered' || r.offered_start_min === null
          ? null
          : {
              date: r.trading_day.toISOString().slice(0, 10),
              startTime: formatMinute(r.offered_start_min),
              startsAt: branchInstant(
                r.trading_day.toISOString().slice(0, 10),
                r.offered_start_min,
              ).toISOString(),
              durationMinutes: r.offered_duration_min,
              staffId:
                r.offered_staff_id === null
                  ? null
                  : slugs.toSlug(r.offered_staff_id),
              bookingCode: r.offered_booking_code,
              expiresAt: r.offer_expires_at?.toISOString() ?? null,
            },
    });

    const waiting = rows.filter((r) => r.status === 'waiting');
    const offered = rows.filter((r) => r.status === 'offered');

    return {
      offered: offered.map((r, i) => toEntry(r, i + 1)),
      waiting: waiting.map((r, i) => toEntry(r, i + 1)),
      summary: {
        waiting: waiting.length,
        offered: offered.length,
        recovered: conversion.accepted,
        conversionRate:
          conversion.total === 0
            ? 0
            : Number((conversion.accepted / conversion.total).toFixed(4)),
      },
    };
  }

  // --------------------------------------------------------- §10.1 series

  /** The recurring screen. Health is DERIVED, never a stored judgement. */
  async series(branchId: string, status?: string): Promise<unknown> {
    const [rows, slugs] = await Promise.all([
      this.reads.seriesBoard(branchId),
      this.slugIndex(branchId),
    ]);
    const names = await this.customerNames(rows.map((r) => r.customer_id));

    const data = rows
      .map((r) => toSeriesRow(r, slugs, names))
      .filter((s) =>
        status === undefined || status === 'ALL'
          ? true
          : status === 'AT_RISK'
            ? s.health === 'AT_RISK'
            : s.status === status,
      );

    return {
      data,
      summary: {
        live: data.filter((s) => s.status === 'ACTIVE').length,
        atRisk: data.filter((s) => s.health === 'AT_RISK').length,
        paused: data.filter((s) => s.status === 'PAUSED').length,
        futureOccurrences: data.reduce((n, s) => n + s.occurrences.total, 0),
        lifetimeValue: data.reduce((n, s) => n + s.lifetimeValue, 0),
      },
    };
  }

  /**
   * ONE series' board row, for the detail panel's header.
   *
   * THE SAME ROW AND THE SAME MAPPER the board uses. The panel published
   * eight fields and the list published fifteen others, so a deep link to a
   * series could not draw its own header -- no customer, no service, no
   * staff, no pattern, no price. Building a second projection here would put
   * those fifteen fields in two places and guarantee one of them lags
   * (CLAUDE.md 4), so the panel asks the board for its row.
   *
   * Null when the series does not exist; the caller turns that into its own
   * 404 alongside whatever else it could not load.
   */
  async seriesOne(seriesId: string): Promise<SeriesRowView | null> {
    const branchId = await this.reads.seriesBranch(seriesId);
    if (branchId === null) return null;

    const [rows, slugs] = await Promise.all([
      this.reads.seriesBoard(branchId, seriesId),
      this.slugIndex(branchId),
    ]);
    const row = rows[0];
    if (row === undefined) return null;
    return toSeriesRow(row, slugs, await this.customerNames([row.customer_id]));
  }

  /**
   * One index over every id the fixtures speak in slugs.
   *
   * WHY THIS IS NOT OPTIONAL. The calendar publishes `staff.id: "reem"`
   * (resolved through the roster) while a board reading straight out of a
   * column publishes the hash. Two endpoints describing the same stylist with
   * two different ids is precisely the slug/uuid trap in CLAUDE.md 8, and the
   * client would key a cache on one and look it up with the other.
   *
   * Built from the roster AND the catalogue, because a series carries a
   * service id as well as a professional.
   */
  private async slugIndex(branchId: string): Promise<SlugIndex> {
    const day = branchToday();
    try {
      const [ctx, catalogue] = await Promise.all([
        this.context.loadDay(branchId, day),
        this.context.loadCatalogue(branchId),
      ]);
      return new SlugIndex([
        ...ctx.professionals.map((p) => p.id),
        ...catalogue.map((c) => c.id),
      ]);
    } catch {
      // An unreachable roster must not stop a board rendering. Unresolved
      // ids pass through unchanged, which is what SlugIndex already does.
      return new SlugIndex([]);
    }
  }

  // ------------------------------------------------------------- helpers

  /**
   * Customer names for a page of rows, resolved ONCE.
   *
   * The same batching `decorate` already does for the booking list, extracted
   * so the events feed, the waitlist board and the series board can publish a
   * name too -- none of them did, which is why the console was joining
   * against the platform customers API per row and rendering "#127B" when
   * that missed.
   *
   * A directory that cannot answer leaves every name null. Decoration never
   * fails a read.
   */
  private async customerNames(
    ids: readonly string[],
  ): Promise<ReadonlyMap<string, string | null>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map();
    try {
      const pairs = await Promise.all(
        unique.map(
          async (id) => [id, (await this.customers.load(id)).name] as const,
        ),
      );
      return new Map(pairs);
    } catch {
      return new Map();
    }
  }

  /**
   * Names and customer context, resolved once per read rather than per row.
   *
   * A day grid has forty bookings and perhaps six professionals and twenty
   * customers. Forty lookups would be thirty-four more than necessary, and
   * the customer port is a network call in production.
   */
  private async decorate(
    branchId: string,
    rows: readonly BookingRow[],
  ): Promise<BookingView[]> {
    if (rows.length === 0) return [];

    /**
     * THE ROSTER IS PER DAY, AND SO IS THIS.
     *
     * This took the date off the FIRST row and loaded one day's roster. The
     * day grid only ever holds one day, so it looked right; the week grid
     * holds seven, and everyone was matched against Monday. A stylist off on
     * Monday lost their name all week -- and worse, the slug lookup missed
     * too, so their `staff.id` came back as the folded hash while the day
     * grid published "maya". Two endpoints spelling one stylist two ways is
     * the trap in CLAUDE.md 8, and a staff filter built on it misses them
     * silently.
     *
     * One load per DISTINCT day, in parallel. A week is seven; a day is one,
     * exactly as before.
     */
    const days = [
      ...new Set(rows.map((r) => r.trading_day.toISOString().slice(0, 10))),
    ];
    const staffNames = new Map<string, string>();
    const staffSlugs = new Map<string, string>();

    /**
     * ONE DAY'S FAILURE COSTS ONE DAY'S NAMES.
     *
     * A single try around all seven loads would have let a Tuesday blip
     * blank the names for the whole week -- silently, since a null name is
     * not an error. Each day is caught on its own, so Tuesday loses its
     * stylists and the other six keep theirs.
     */
    const rosters = await Promise.all(
      days.map((d) =>
        this.context
          .loadDay(branchId, d)
          .then((c) => c.professionals)
          .catch(() => {
            // A name is decoration. Rule 2 -- missing data removes capacity,
            // never adds it -- is about AVAILABILITY; refusing to render the
            // diary because the roster service blinked would help nobody.
            return [];
          }),
      ),
    );

    // THE SLUG/UUID BOUNDARY (CLAUDE.md 8). The roster speaks slugs
    // ("maya"); booking_item.staff_id holds toUuid("maya"). Keying the
    // name map by the slug meant every lookup missed and every booking
    // rendered with a null professional -- silently, because a missing
    // name is not an error. SlugIndex answers to both spellings.
    const everyone = rosters.flat();
    const index = new SlugIndex(everyone.map((p) => p.id));
    for (const p of everyone) staffNames.set(p.id, p.name);
    for (const r of rows) {
      for (const raw of r.staff_ids ?? []) {
        const slug = index.toSlug(raw);
        const name = staffNames.get(slug);
        if (name !== undefined) staffNames.set(raw, name);
        if (slug !== raw) staffSlugs.set(raw, slug);
      }
    }

    const ids = [...new Set(rows.map((r) => r.customer_id))];
    const [contexts, conflicts] = await Promise.all([
      Promise.all(
        ids.map(async (id) => [id, await this.customers.load(id)] as const),
      ).then((pairs) => new Map(pairs)),
      // ONE query for the whole page, not one per row. A day grid is forty
      // bookings and almost always zero conflicts.
      this.reads.conflictsFor(rows.map((r) => r.id)),
    ]);

    return rows.map((r) => {
      const c = contexts.get(r.customer_id);
      return toView(r, staffNames, staffSlugs, conflicts.get(r.id), {
        name: c?.name ?? null,
        tier: c?.tier ?? 'none',
        risk: c?.risk ?? 'LOW',
        riskScore: c?.riskScore ?? 80,
        isNewCustomer: c?.isNewCustomer ?? true,
        requireDepositFlag: c?.requireDepositFlag ?? false,
      });
    });
  }
}

/**
 * What became of the money on a cancelled or no-showed booking.
 *
 * `partially_refunded` gets its OWN word now. It used to fold into REFUNDED,
 * and anything unrecognised fell through to LOST -- so the prepaid 2-24h
 * split, which is the one case the front-end contract had no cell for,
 * rendered as "Lost" on the cancellations screen and in a dispute.
 */
/**
 * One event row, for the feed AND for the drawer.
 *
 * ONE MAPPER, because the two were different projections of the same row and
 * the drawer had half the fields. See `event()`.
 */
function toEventView(
  r: Awaited<ReturnType<ReadModelRepository['events']>>[number],
  names: ReadonlyMap<string, string | null>,
) {
  const kind: 'NO_SHOW' | 'CANCELLED' =
    r.to_status === 'no_show' ? 'NO_SHOW' : 'CANCELLED';
  const day = r.trading_day.toISOString().slice(0, 10);
  const timing = cancelTiming({
    occurredAtMs: r.created_at.getTime(),
    startAtMs: r.start_at.getTime(),
  });

  return {
    id: r.id,
    bookingId: r.booking_id,
    code: r.code,
    kind,
    by: r.actor_kind === 'system' ? 'AUTO' : r.actor_kind.toUpperCase(),
    occurredAt: r.created_at.toISOString(),
    customer: { id: r.customer_id, name: names.get(r.customer_id) ?? null },
    service: (r.service_names ?? []).join(', '),
    staffId: r.staff_ids?.[0] ?? null,
    /**
     * WHEN THE VISIT WAS FOR. The row carried `slot.startTime` and a
     * duration and no date at all, so the feed could not say which day a
     * cancellation belonged to and could not derive how late it was.
     */
    tradingDay: day,
    startAt: r.start_at.toISOString(),
    slot: {
      date: day,
      startTime: formatMinute(r.start_minute),
      durationMinutes: r.duration_min,
    },
    /** Hours between the cancellation and the start. Negative after it. */
    hoursBeforeStart: Number(timing.hoursBeforeStart.toFixed(2)),
    /** Inside the late window. A no-show is always past the start. */
    lateCancel: kind === 'CANCELLED' && timing.lateCancel,
    policyBand: timing.band.toUpperCase(),
    reason: r.reason,
    servicePrice: wholeAed(r.price_fils),
    depositAmount: wholeAed(r.deposit_fils),
    outcome: eventOutcome(r.payment_status as PaymentStatus),
    /**
     * The waitlist refilled this slot.
     *
     * A boolean, not `recoveredByCode`: an accepted waitlist entry records
     * WHICH cancellation it took, but the booking that acceptance became is
     * created by a separate confirm call that does not write back to the
     * entry. Saying "recovered: true" is a fact; naming a code would be a
     * guess.
     */
    recovered: r.recovered,
  };
}

function eventOutcome(p: PaymentStatus): string {
  if (p === 'forfeited') return 'DEPOSIT_KEPT';
  if (p === 'partially_refunded') return 'PARTIALLY_REFUNDED';
  if (p === 'refunded') return 'REFUNDED';
  if (p === 'none_required' || p === 'unpaid') return 'NO_CHARGE';
  return 'LOST';
}

function nowMinute(): number {
  return branchNowMinute();
}

/**
 * How many bookings sit behind each chip.
 *
 * Over the WHOLE window, never the filtered set: a chip showing the size of
 * what you are already looking at reads the same number every time.
 */
function chipCounts(rows: readonly BookingRow[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const chip of CALENDAR_CHIPS) {
    const statuses = statusesForChips([chip]) ?? [];
    out[chip] = rows.filter((r) => statuses.includes(r.status)).length;
  }
  return out;
}

export { LIVE_STATUSES };

/** One series, as both the board and the detail panel publish it. */
export type SeriesRowView = ReturnType<typeof toSeriesRow>;

/**
 * A series row to the screen's shape.
 *
 * MODULE LEVEL, and exported, because two screens render it: the recurring
 * board and the detail panel's header. It used to live inline in `series()`,
 * which is why the panel had none of it.
 */
function toSeriesRow(
  r: Awaited<ReturnType<ReadModelRepository['seriesBoard']>>[number],
  slugs: SlugIndex,
  names: ReadonlyMap<string, string | null>,
) {
  const facts: SeriesFacts = {
    status: r.status as SeriesFacts['status'],
    needsAttentionCount: Number(r.needs_attention),
    // Not tracked per series yet; the two that are drive the verdict.
    consecutiveConfirmationExpiries: 0,
    noShowCount: 0,
    skippedCount: Number(r.skipped),
  };
  const health = deriveSeriesHealth(facts);

  return {
    id: r.id,
    status: r.status.toUpperCase(),
    health: health.health.toUpperCase(),
    /**
     * THREE FIELDS, ONE DERIVATION.
     *
     * `riskCause` (board) and `healthReasons` + `healthExplanation` (panel)
     * were two different prose fields describing the same thing, written by
     * two different functions. They are all `deriveSeriesHealth`'s answer
     * now: the enum to branch on, the sentence to read, and `riskCause` kept
     * as the sentence under its old name so nothing that reads it breaks.
     */
    healthReasons: health.reasons.map((x) => x.toUpperCase()),
    healthExplanation: health.explanation,
    riskCause: health.health === 'at_risk' ? health.explanation : null,
    customer: { id: r.customer_id, name: names.get(r.customer_id) ?? null },
    service: { id: slugs.toSlug(r.service_id) },
    staff: {
      id:
        r.preferred_staff_id === null
          ? null
          : slugs.toSlug(r.preferred_staff_id),
    },
    pattern: {
      kind: r.pattern.toUpperCase(),
      interval: r.interval_weeks,
      weekdays: r.weekdays,
      dayOfMonth: r.day_of_month,
      timeOfDay: formatMinute(r.start_min),
      anchorDate: r.anchor_day.toISOString().slice(0, 10),
    },
    confirmRule: r.auto_confirm_rule.toUpperCase(),
    ends: {
      kind: r.end_kind.toUpperCase(),
      count: r.end_count,
      date: r.end_date?.toISOString().slice(0, 10) ?? null,
    },
    nextDate: r.next_day?.toISOString().slice(0, 10) ?? null,
    pricePerVisit: wholeAed(r.baseline_price_fils),
    lifetimeValue: wholeAed(
      r.baseline_price_fils * Number(r.total_occurrences),
    ),
    occurrences: {
      total: Number(r.total_occurrences),
      needsAttention: Number(r.needs_attention),
      skipped: Number(r.skipped),
    },
    course:
      r.course_visits === null
        ? null
        : {
            visits: r.course_visits,
            drawn: r.course_drawn ?? 0,
            totalNet: wholeAed(r.course_total_net_fils ?? 0),
          },
    materialisedThrough:
      r.materialised_through?.toISOString().slice(0, 10) ?? null,
  };
}

/** What conflictsFor() returns for one booking. */
type ConflictRow = NonNullable<
  ReturnType<Awaited<ReturnType<ReadModelRepository['conflictsFor']>>['get']>
>;

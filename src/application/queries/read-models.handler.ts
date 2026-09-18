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
  isListFilter,
  statusesFor,
  toDepositOutcome,
  toScreenPayment,
  toScreenStatus,
  type ListFilter,
} from '@application/contract/screen-view';
import type { BookingStatus } from '@domain/booking/lifecycle';
import type { PaymentStatus } from '../../generated/prisma/enums';
import { bookingError } from '@application/contract/errors';
import {
  deriveSeriesHealth,
  type SeriesFacts,
  type RiskReason,
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

    const [all, todayN, tomorrow, deposit, conflicts, notReminded] =
      await Promise.all([
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
      ]);

    return {
      ALL: all,
      TODAY: todayN,
      TOMORROW: tomorrow,
      DEPOSIT_PENDING: deposit,
      CONFLICTS: conflicts,
      NOT_REMINDED: notReminded,
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
    return {
      fromDay: from ?? base,
      toDay: to ?? addDays(from ?? base, 90),
    };
  }

  // ------------------------------------------------------------ calendar

  /** §6.3. The day grid, its columns and its KPI strip. */
  async day(
    branchId: string,
    date: string,
    filters: { staffId?: string | undefined; status?: string | undefined },
  ): Promise<unknown> {
    const [rows, ctx] = await Promise.all([
      this.reads.list({
        branchId,
        fromDay: date,
        toDay: addDays(date, 1),
        ...(filters.staffId === undefined ? {} : { staffId: filters.staffId }),
      }),
      this.context.loadDay(branchId, date),
    ]);

    const bookings = await this.decorate(branchId, rows);

    // Same boundary as decorate(): the rows hold hashes, the roster holds
    // slugs, so the load count is matched on the folded id, not the slug.
    const index = new SlugIndex(ctx.professionals.map((p) => p.id));
    const columns = ctx.professionals.map((p) => {
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

    const bookedMin = rows.reduce((n, r) => n + r.duration_min, 0);
    const sellable = ctx.professionals.reduce(
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
      kpis: {
        booked: rows.length,
        utilisation: Number(utilisation(bookedMin, sellable).toFixed(4)),
        revenue: wholeAed(rows.reduce((n, r) => n + r.price_fils, 0)),
        pendingDeposits: rows.filter((r) => r.status === 'pending_payment')
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
    const [rows, totals] = await Promise.all([
      this.reads.list({ branchId, fromDay: from, toDay: to }),
      this.reads.dailyTotals(branchId, from, to),
    ]);

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

    const raw = await this.reads.searchCandidates(branchId, query, limit);

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
        id: s.service_id,
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

    const kinds: BookingStatus[] =
      q.kind === 'NO_SHOW'
        ? ['no_show']
        : q.kind === 'CANCELLED' || q.kind === 'LATE_CANCEL'
          ? ['cancelled']
          : ['cancelled', 'no_show'];

    const [rows, total] = await Promise.all([
      this.reads.events({
        branchId: q.branchId,
        fromDay: start,
        toDay: end,
        kinds,
        limit: pageSize,
        offset: (page - 1) * pageSize,
      }),
      this.reads.countEvents({
        branchId: q.branchId,
        fromDay: start,
        toDay: end,
        kinds,
      }),
    ]);

    const data = rows.map((r) => ({
      id: r.id,
      bookingId: r.booking_id,
      code: r.code,
      kind: r.to_status === 'no_show' ? 'NO_SHOW' : 'CANCELLED',
      by: r.actor_kind === 'system' ? 'AUTO' : r.actor_kind.toUpperCase(),
      occurredAt: r.created_at.toISOString(),
      customer: { id: r.customer_id },
      service: (r.service_names ?? []).join(', '),
      staffId: r.staff_ids?.[0] ?? null,
      slot: {
        startTime: formatMinute(r.start_minute),
        durationMinutes: r.duration_min,
      },
      reason: r.reason,
      servicePrice: wholeAed(r.price_fils),
      depositAmount: wholeAed(r.deposit_fils),
      outcome: eventOutcome(r.payment_status as PaymentStatus),
    }));

    const lostFils = rows
      .filter((r) => r.payment_status !== 'forfeited')
      .reduce((n, r) => n + r.price_fils, 0);

    return {
      data,
      page,
      pageSize,
      total,
      summary: {
        events: data.length,
        noShows: data.filter((d) => d.kind === 'NO_SHOW').length,
        lostValue: wholeAed(lostFils),
        depositsKept: wholeAed(
          rows
            .filter((r) => r.payment_status === 'forfeited')
            .reduce((n, r) => n + r.deposit_fils, 0),
        ),
      },
    };
  }

  /** §9.2. The detail drawer, with the worked policy maths. */
  async event(id: string): Promise<unknown> {
    const r = await this.reads.event(id);
    if (r === null) throw new NotFoundException('No such event');

    return {
      id: r.id,
      bookingId: r.booking_id,
      code: r.code,
      kind: r.to_status === 'no_show' ? 'NO_SHOW' : 'CANCELLED',
      occurredAt: r.created_at.toISOString(),
      reason: r.reason,
      /**
       * THE MATHS, NOT THE VERDICT. The desk has to answer "why was I
       * charged", and an enum cannot be read down a phone. These are the
       * figures the policy actually used.
       */
      math: [
        { label: 'Service value', value: wholeAed(r.price_fils) },
        { label: 'Deposit captured', value: wholeAed(r.deposit_fils) },
        {
          label: 'Policy window',
          value:
            r.to_status === 'no_show'
              ? 'start + grace passed'
              : (r.reason ?? 'cancelled'),
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

    const toEntry = (r: (typeof rows)[number], position: number): unknown => ({
      id: r.id,
      status: r.status.toUpperCase(),
      position,
      customer: { id: r.customer_id },
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

    const data = rows
      .map((r) => {
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
          riskCause: health.reasons.map(describeSeriesRisk).join('; ') || null,
          customer: { id: r.customer_id },
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
      })
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

    const day = rows[0]!.trading_day.toISOString().slice(0, 10);
    const staffNames = new Map<string, string>();
    const staffSlugs = new Map<string, string>();
    try {
      const ctx = await this.context.loadDay(branchId, day);
      // THE SLUG/UUID BOUNDARY (CLAUDE.md 8). The roster speaks slugs
      // ("maya"); booking_item.staff_id holds toUuid("maya"). Keying the
      // name map by the slug meant every lookup missed and every booking
      // rendered with a null professional -- silently, because a missing
      // name is not an error. SlugIndex answers to both spellings.
      const index = new SlugIndex(ctx.professionals.map((p) => p.id));
      for (const p of ctx.professionals) staffNames.set(p.id, p.name);
      for (const r of rows) {
        for (const raw of r.staff_ids ?? []) {
          const slug = index.toSlug(raw);
          const name = staffNames.get(slug);
          if (name !== undefined) staffNames.set(raw, name);
          if (slug !== raw) staffSlugs.set(raw, slug);
        }
      }
    } catch {
      // A name is decoration. Rule 2 -- missing data removes capacity, never
      // adds it -- is about AVAILABILITY; refusing to render the diary
      // because the roster service blinked would help nobody.
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

export { LIVE_STATUSES };

/** A series risk reason, in the words the desk uses. */
function describeSeriesRisk(reason: RiskReason): string {
  switch (reason) {
    case 'needs_attention':
      return 'an occurrence no longer fits and could not be repaired';
    case 'confirmations_lapsing':
      return 'confirmation requests are going unanswered';
    case 'no_show':
      return 'the customer did not turn up';
    case 'skipping':
      return 'visits are being skipped rather than kept';
  }
}

/** What conflictsFor() returns for one booking. */
type ConflictRow = NonNullable<
  ReturnType<Awaited<ReturnType<ReadModelRepository['conflictsFor']>>['get']>
>;

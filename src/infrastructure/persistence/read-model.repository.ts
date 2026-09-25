import { Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from './prisma.service';
import { toUuid } from './hold.repository';
import type { BookingStatus } from '@domain/booking/lifecycle';
import { LIVE_STATUSES } from '@application/contract/screen-view';

/**
 * The queries behind the seven booking screens.
 *
 * WHY A SEPARATE REPOSITORY. Everything else in persistence/ writes: it takes
 * a lock, proves a constraint, commits a row. This one only reads, and it
 * reads WIDELY -- a day grid, a month of counts, a search across four kinds
 * of thing. Mixing that into BookingRepository would put an unindexed
 * `ILIKE` next to the confirm transaction and invite somebody to reuse one
 * for the other.
 *
 * EVERY QUERY IS BRANCH- AND DAY-SCOPED, and lands on
 * `booking_branch_day_idx` (branch_id, trading_day, status), which already
 * existed for the availability masks. No new index is needed for any read
 * here except the search, which is called at human typing speed against a
 * single branch and is bounded by LIMIT.
 *
 * DATES. `trading_day` is a DATE column in branch-local terms, and every
 * range below is half-open [from, to) on it. Comparing on start_at instead
 * would put a 22:00 booking on the wrong calendar day four hours a night.
 */

export interface BookingRow {
  readonly id: string;
  readonly code: string;
  readonly branch_id: string;
  readonly customer_id: string;
  readonly status: BookingStatus;
  readonly payment_status: string;
  readonly trading_day: Date;
  readonly start_at: Date;
  readonly start_minute: number;
  readonly duration_min: number;
  readonly price_fils: number;
  readonly deposit_fils: number;
  readonly requirement_source: string | null;
  readonly channel: string;
  readonly move_count: number;
  readonly overbooked: boolean;
  readonly overbook_reason: string | null;
  readonly group_id: string | null;
  readonly link_expires_at: Date | null;
  readonly reminded_24h_at: Date | null;
  readonly reminded_3h_at: Date | null;
  readonly nudged_15m_at: Date | null;
  readonly service_names: string[] | null;
  readonly staff_ids: string[] | null;
  readonly resource_types: string[] | null;
}

export interface ListFilters {
  readonly branchId: string;
  readonly fromDay: string;
  readonly toDay: string;
  readonly statuses?: readonly BookingStatus[] | undefined;
  /**
   * Any of these professionals: a booking matches when ANY of its lines is
   * held by ANY of them. Absent means everyone. An empty list is not
   * "everyone" -- it matches nothing, so a caller with no ids leaves this out.
   */
  readonly staffIds?: readonly string[] | undefined;
  /** Any of these services, on any line. Absent means every service. */
  readonly serviceIds?: readonly string[] | undefined;
  readonly customerId?: string | undefined;
  /** NOT_REMINDED: the 24-hour rung has not gone out. */
  readonly notReminded?: boolean | undefined;
  /** CONFLICTS: has an open roster-change worklist item. */
  readonly conflictsOnly?: boolean | undefined;
  readonly limit?: number | undefined;
  readonly offset?: number | undefined;
}

/**
 * THE WHERE, WRITTEN ONCE.
 *
 * `list` and `count` each carried their own copy of these conditions, and
 * they had already drifted: staffId and customerId narrowed the rows and not
 * the count, so a filtered read showed five rows and reported `total: 109`.
 * Every pager built on that asks for pages that do not exist.
 *
 * One builder, every caller. A filter added here reaches all of them, and
 * the grid cannot disagree with the strip about what it is looking at
 * (CLAUDE.md 4).
 *
 * Prisma.sql binds its arguments exactly as a tagged template does, so
 * nothing here is string concatenation.
 *
 * STAFF AND SERVICE ARE LISTS. Within one list it is ANY: any line, any of
 * the ids. Across the two it is AND: a booking must hold one of the staff and
 * one of the services -- on the same line or on different ones, because both
 * are asked of the booking, as the single-id version always asked them. One
 * id is a list of one, and `= ANY('{x}')` is `= x`.
 */
function bookingWhere(f: ListFilters): Prisma.Sql {
  const statuses = [...(f.statuses ?? LIVE_STATUSES)];
  // Folded here, once per id, so every caller spells an id the way the
  // column does (CLAUDE.md 8). null is "no filter".
  const staff = f.staffIds?.map((id) => toUuid(id)) ?? null;
  const services = f.serviceIds?.map((id) => toUuid(id)) ?? null;

  return Prisma.sql`
         b.branch_id = ${toUuid(f.branchId)}::uuid
     AND b.trading_day >= ${f.fromDay}::date
     AND b.trading_day < ${f.toDay}::date
     AND b.status::text = ANY(${statuses}::text[])
     AND (${staff}::uuid[] IS NULL OR EXISTS (
           SELECT 1 FROM booking_item si
            WHERE si.booking_id = b.id
              AND si.staff_id = ANY(${staff}::uuid[])))
     AND (${services}::uuid[] IS NULL OR EXISTS (
           SELECT 1 FROM booking_item si
            WHERE si.booking_id = b.id
              AND si.service_id = ANY(${services}::uuid[])))
     AND (${f.customerId ?? null}::text IS NULL
          OR b.customer_id = ${
            f.customerId === undefined ? null : toUuid(f.customerId)
          }::uuid)
     AND (${f.notReminded ?? false}::boolean IS FALSE
          OR b.reminded_24h_at IS NULL)
     AND (${f.conflictsOnly ?? false}::boolean IS FALSE OR EXISTS (
           SELECT 1 FROM roster_change_item ri
            WHERE ri.booking_id = b.id AND ri.state = 'open'))`;
}

@Injectable()
export class ReadModelRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The list every screen ultimately reads.
   *
   * Items are aggregated into arrays in the same query rather than fetched
   * per booking. A day grid renders ~40 bookings; the N+1 version made 41
   * round trips and was the reason the first draft of the calendar took
   * 900ms.
   */
  async list(f: ListFilters): Promise<BookingRow[]> {
    return this.prisma.$queryRaw<BookingRow[]>`
      SELECT b.id, b.code, b.branch_id, b.customer_id, b.status::text AS status,
             b.payment_status::text AS payment_status,
             b.trading_day, b.start_at, b.start_minute, b.duration_min,
             b.price_fils, b.deposit_fils, b.requirement_source, b.channel,
             b.move_count, b.overbooked, b.overbook_reason, b.group_id,
             b.link_expires_at, b.reminded_24h_at, b.reminded_3h_at,
             b.nudged_15m_at,
             array_agg(i.service_name ORDER BY i.position)
               FILTER (WHERE i.id IS NOT NULL) AS service_names,
             array_agg(DISTINCT i.staff_id::text)
               FILTER (WHERE i.staff_id IS NOT NULL) AS staff_ids,
             array_agg(DISTINCT i.resource_type)
               FILTER (WHERE i.resource_type IS NOT NULL) AS resource_types
        FROM booking b
        LEFT JOIN booking_item i ON i.booking_id = b.id
        WHERE ${bookingWhere(f)}
        GROUP BY b.id
       ORDER BY b.start_at ASC
       LIMIT ${f.limit ?? 500} OFFSET ${f.offset ?? 0}`;
  }

  /**
   * The total behind a page, for `total` in the envelope.
   *
   * IT HAS TO NARROW BY EXACTLY WHAT `list` NARROWS BY, and it did not:
   * `staffId` and `customerId` were applied to the rows and not to the count,
   * so a filtered read returned five rows and reported `total: 109`. Every
   * pager built on that asks for pages that do not exist.
   */
  async count(f: ListFilters): Promise<number> {
    const rows = await this.prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n
        FROM booking b
       WHERE ${bookingWhere(f)}`;
    return Number(rows[0]?.n ?? 0n);
  }

  /**
   * Per-day counts and revenue for the week strip and the month grid.
   *
   * One query for the whole range. The month view asked for 31 of these
   * before, which is 31 round trips to render one screen.
   */
  async dailyTotals(
    f: ListFilters,
  ): Promise<{ day: string; n: number; revenueFils: number }[]> {
    type Row = { day: Date; n: bigint; revenue: bigint | null };

    const rows: Row[] = await this.prisma.$queryRaw`
      SELECT b.trading_day AS day, count(*) AS n, sum(b.price_fils) AS revenue
        FROM booking b
       WHERE ${bookingWhere(f)}
       GROUP BY b.trading_day
       ORDER BY b.trading_day`;

    return rows.map((r) => ({
      day: r.day.toISOString().slice(0, 10),
      n: Number(r.n),
      revenueFils: Number(r.revenue ?? 0n),
    }));
  }

  /**
   * How many bookings in each status, and what they are worth.
   *
   * FOR A WINDOW TOO WIDE TO READ ROW BY ROW. The month's KPI strip needs a
   * count and a sum, not bookings. Fetching them only to count them borrowed
   * the week grid's 2000-row ceiling, and a month past it undercounted the
   * header while the cells -- summed in SQL by dailyTotals -- stayed right.
   * This returns one row per status however busy the month is.
   *
   * GROUPED BY STATUS, NOT BY CHIP. Which statuses are live and which ones a
   * chip means is screen-view.ts's to say; folding them here would be a
   * second copy of that map, written in Postgres (CLAUDE.md 4).
   */
  async statusTotals(
    f: ListFilters,
  ): Promise<{ status: BookingStatus; n: number; revenueFils: number }[]> {
    type Row = { status: BookingStatus; n: bigint; revenue: bigint | null };

    const rows: Row[] = await this.prisma.$queryRaw`
      SELECT b.status::text AS status, count(*) AS n,
             sum(b.price_fils) AS revenue
        FROM booking b
       WHERE ${bookingWhere(f)}
       GROUP BY b.status`;

    return rows.map((r) => ({
      status: r.status,
      n: Number(r.n),
      revenueFils: Number(r.revenue ?? 0n),
    }));
  }

  /**
   * The numbers behind one KPI window.
   *
   * `kept` counts visits that reached completed or settled. Deliberately not
   * "everything not cancelled": a confirmed booking tomorrow has not been
   * kept yet, and counting it would make the show-up rate drift with how far
   * ahead the diary is filled rather than with how people behave.
   */
  async windowStats(
    branchId: string,
    fromDay: string,
    toDay: string,
  ): Promise<{
    bookings: number;
    revenueFils: number;
    kept: number;
    noShows: number;
    lateCancels: number;
  }> {
    const rows = await this.prisma.$queryRaw<
      {
        bookings: bigint;
        revenue: bigint | null;
        kept: bigint;
        no_shows: bigint;
        late_cancels: bigint;
      }[]
    >`
      SELECT count(*) FILTER (
               WHERE b.status::text = ANY(${[...LIVE_STATUSES]}::text[])
             ) AS bookings,
             sum(b.price_fils) FILTER (
               WHERE b.status::text = ANY(${[...LIVE_STATUSES]}::text[])
             ) AS revenue,
             count(*) FILTER (WHERE b.status IN ('completed','settled')) AS kept,
             count(*) FILTER (WHERE b.status = 'no_show') AS no_shows,
             count(*) FILTER (WHERE b.status = 'cancelled') AS late_cancels
        FROM booking b
       WHERE b.branch_id = ${toUuid(branchId)}::uuid
         AND b.trading_day >= ${fromDay}::date
         AND b.trading_day < ${toDay}::date`;

    const r = rows[0];
    return {
      bookings: Number(r?.bookings ?? 0n),
      revenueFils: Number(r?.revenue ?? 0n),
      kept: Number(r?.kept ?? 0n),
      noShows: Number(r?.no_shows ?? 0n),
      lateCancels: Number(r?.late_cancels ?? 0n),
    };
  }

  /**
   * Cancellation and no-show events, read out of the status history.
   *
   * THE HISTORY IS THE EVENT LOG. Every lifecycle write already appends a row
   * with the actor and the reason; a second `booking_event` table would be a
   * copy that can disagree with it (CLAUDE.md 4). What the drawer needs that
   * the history lacks -- the service, the price, the deposit -- is joined
   * here rather than denormalised at write time.
   */
  async events(input: {
    readonly branchId: string;
    readonly fromDay: string;
    readonly toDay: string;
    readonly kinds?: readonly BookingStatus[] | undefined;
    readonly limit?: number | undefined;
    readonly offset?: number | undefined;
  }): Promise<
    {
      id: string;
      booking_id: string;
      code: string;
      to_status: BookingStatus;
      actor_kind: string;
      reason: string | null;
      created_at: Date;
      customer_id: string;
      trading_day: Date;
      start_at: Date;
      start_minute: number;
      duration_min: number;
      price_fils: number;
      deposit_fils: number;
      payment_status: string;
      service_names: string[] | null;
      staff_ids: string[] | null;
      recovered: boolean;
    }[]
  > {
    const kinds = [...(input.kinds ?? ['cancelled', 'no_show'])];
    return this.prisma.$queryRaw`
      SELECT h.id, h.booking_id, b.code, h.to_status::text AS to_status,
             h.actor_kind::text AS actor_kind, h.reason, h.created_at,
             b.customer_id, b.trading_day, b.start_at,
             b.start_minute, b.duration_min,
             b.price_fils, b.deposit_fils,
             b.payment_status::text AS payment_status,
             array_agg(i.service_name ORDER BY i.position)
               FILTER (WHERE i.id IS NOT NULL) AS service_names,
             array_agg(DISTINCT i.staff_id::text)
               FILTER (WHERE i.staff_id IS NOT NULL) AS staff_ids,
             -- DID THE WAITLIST REFILL THE SLOT THIS FREED?
             --
             -- The only record of a recovery: an accepted entry keeps the
             -- code of the cancellation it took (see markAccepted). No row
             -- carried this at all, so recovered was permanently zero on a
             -- screen whose whole point is what the salon got back.
             EXISTS (
               SELECT 1 FROM waitlist_entry w
                WHERE w.status = 'accepted'
                  AND w.offered_booking_code = b.code
             ) AS recovered
        FROM booking_status_history h
        JOIN booking b ON b.id = h.booking_id
        LEFT JOIN booking_item i ON i.booking_id = b.id
       WHERE b.branch_id = ${toUuid(input.branchId)}::uuid
         -- WINDOWED ON WHEN THE EVENT HAPPENED, not on when the visit was
         -- booked for. A cancellation made today of a booking three days out
         -- belongs in today's feed; filtering on trading_day hid exactly the
         -- events the screen exists to show, because a future visit is never
         -- inside a backward-looking window.
         AND h.created_at >= ${input.fromDay}::date
         AND h.created_at < (${input.toDay}::date + interval '1 day')
         AND h.to_status::text = ANY(${kinds}::text[])
       GROUP BY h.id, b.id
       ORDER BY h.created_at DESC
       LIMIT ${input.limit ?? 50} OFFSET ${input.offset ?? 0}`;
  }

  /** How many events the window holds, for the pagination envelope. */
  async countEvents(input: {
    readonly branchId: string;
    readonly fromDay: string;
    readonly toDay: string;
    readonly kinds?: readonly BookingStatus[] | undefined;
  }): Promise<number> {
    const kinds = [...(input.kinds ?? ['cancelled', 'no_show'])];
    const rows = await this.prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n
        FROM booking_status_history h
        JOIN booking b ON b.id = h.booking_id
       WHERE b.branch_id = ${toUuid(input.branchId)}::uuid
         AND h.created_at >= ${input.fromDay}::date
         AND h.created_at < (${input.toDay}::date + interval '1 day')
         AND h.to_status::text = ANY(${kinds}::text[])`;
    return Number(rows[0]?.n ?? 0n);
  }

  /**
   * One event, by its history-row id.
   *
   * THE SAME ROW SHAPE THE LIST RETURNS, deliberately. The detail read
   * published eight fields while the list row for the same event carried
   * fourteen, so a deep link or a page refresh -- which has no list row to
   * merge with -- could not draw the drawer at all.
   */
  async event(
    id: string,
  ): Promise<
    Awaited<ReturnType<ReadModelRepository['events']>>[number] | null
  > {
    const rows = await this.prisma.$queryRaw<
      Awaited<ReturnType<ReadModelRepository['events']>>
    >`
      SELECT h.id, h.booking_id, b.code, h.to_status::text AS to_status,
             h.actor_kind::text AS actor_kind, h.reason, h.created_at,
             b.customer_id, b.trading_day, b.start_at,
             b.start_minute, b.duration_min,
             b.price_fils, b.deposit_fils,
             b.payment_status::text AS payment_status,
             array_agg(i.service_name ORDER BY i.position)
               FILTER (WHERE i.id IS NOT NULL) AS service_names,
             array_agg(DISTINCT i.staff_id::text)
               FILTER (WHERE i.staff_id IS NOT NULL) AS staff_ids,
             EXISTS (
               SELECT 1 FROM waitlist_entry w
                WHERE w.status = 'accepted'
                  AND w.offered_booking_code = b.code
             ) AS recovered
        FROM booking_status_history h
        JOIN booking b ON b.id = h.booking_id
        LEFT JOIN booking_item i ON i.booking_id = b.id
       WHERE h.id = ${id}::uuid
       GROUP BY h.id, b.id`;
    return rows[0] ?? null;
  }

  /**
   * THE WHOLE WINDOW, not the page.
   *
   * `summary` was computed from the rows that happened to be on screen, so
   * it tracked `pageSize` exactly -- 10 events on a 10-row page, 100 on a
   * 100-row page -- while `total` correctly said 132. It is the KPI strip
   * for the period, so it has to be an aggregate over the period.
   */
  async eventTotals(input: {
    readonly branchId: string;
    readonly fromDay: string;
    readonly toDay: string;
    readonly kinds?: readonly BookingStatus[] | undefined;
    readonly lateOnly?: boolean | undefined;
    readonly lateCancelWindowHours: number;
  }): Promise<{
    events: number;
    noShows: number;
    serviceValueFils: number;
    depositsKeptFils: number;
    recovered: number;
  }> {
    const kinds = [...(input.kinds ?? ['cancelled', 'no_show'])];
    const rows = await this.prisma.$queryRaw<
      {
        events: bigint;
        no_shows: bigint;
        service_value_fils: bigint | null;
        deposits_kept_fils: bigint | null;
        recovered: bigint;
      }[]
    >`
      SELECT count(*) AS events,
             count(*) FILTER (WHERE h.to_status = 'no_show') AS no_shows,
             sum(b.price_fils) AS service_value_fils,
             sum(b.deposit_fils) FILTER (
               WHERE b.payment_status = 'forfeited'
             ) AS deposits_kept_fils,
             count(*) FILTER (
               WHERE EXISTS (
                 SELECT 1 FROM waitlist_entry w
                  WHERE w.status = 'accepted'
                    AND w.offered_booking_code = b.code)
             ) AS recovered
        FROM booking_status_history h
        JOIN booking b ON b.id = h.booking_id
       WHERE b.branch_id = ${toUuid(input.branchId)}::uuid
         AND h.created_at >= ${input.fromDay}::date
         AND h.created_at < (${input.toDay}::date + interval '1 day')
         AND h.to_status::text = ANY(${kinds}::text[])
         AND (${input.lateOnly ?? false}::boolean IS FALSE
              OR b.start_at - h.created_at
                 < make_interval(hours => ${input.lateCancelWindowHours}))`;

    const r = rows[0];
    return {
      events: Number(r?.events ?? 0n),
      noShows: Number(r?.no_shows ?? 0n),
      serviceValueFils: Number(r?.service_value_fils ?? 0n),
      depositsKeptFils: Number(r?.deposits_kept_fils ?? 0n),
      recovered: Number(r?.recovered ?? 0n),
    };
  }

  /**
   * Every reason given in the window, with what it cost.
   *
   * Read raw and grouped in the domain rather than `GROUP BY reason` here:
   * the reason is free text, so "Customer called" and "customer called" are
   * one reason, and case folding is a rule, not a query detail.
   */
  async eventReasons(input: {
    readonly branchId: string;
    readonly fromDay: string;
    readonly toDay: string;
    readonly kinds?: readonly BookingStatus[] | undefined;
    readonly lateOnly?: boolean | undefined;
    readonly lateCancelWindowHours: number;
  }): Promise<{ reason: string | null; priceFils: number }[]> {
    const kinds = [...(input.kinds ?? ['cancelled', 'no_show'])];
    const rows = await this.prisma.$queryRaw<
      { reason: string | null; price_fils: number }[]
    >`
      SELECT h.reason, b.price_fils
        FROM booking_status_history h
        JOIN booking b ON b.id = h.booking_id
       WHERE b.branch_id = ${toUuid(input.branchId)}::uuid
         AND h.created_at >= ${input.fromDay}::date
         AND h.created_at < (${input.toDay}::date + interval '1 day')
         AND h.to_status::text = ANY(${kinds}::text[])
         AND (${input.lateOnly ?? false}::boolean IS FALSE
              OR b.start_at - h.created_at
                 < make_interval(hours => ${input.lateCancelWindowHours}))`;
    return rows.map((r) => ({ reason: r.reason, priceFils: r.price_fils }));
  }

  /**
   * Command-palette candidates.
   *
   * Pulled WIDE and ranked in the domain rather than ordered in SQL. Ranking
   * here would mean a second copy of rankSearch() written in Postgres, and
   * "exact code matches first" is exactly the rule that must not exist twice.
   * The LIMIT keeps the width honest.
   */
  async searchCandidates(
    branchId: string,
    q: string,
    limit: number,
  ): Promise<{
    bookings: {
      id: string;
      code: string;
      customer_id: string;
      trading_day: Date;
      start_minute: number;
      service_names: string[] | null;
      staff_ids: string[] | null;
    }[];
    services: {
      service_id: string;
      service_name: string;
      duration_min: number;
      price_fils: number;
    }[];
  }> {
    const like = `%${q.replace(/[%_]/g, (m) => `\\${m}`)}%`;

    const bookings = await this.prisma.$queryRaw<
      {
        id: string;
        code: string;
        customer_id: string;
        trading_day: Date;
        start_minute: number;
        service_names: string[] | null;
        staff_ids: string[] | null;
      }[]
    >`
      SELECT b.id, b.code, b.customer_id, b.trading_day, b.start_minute,
             array_agg(i.service_name ORDER BY i.position)
               FILTER (WHERE i.id IS NOT NULL) AS service_names,
             array_agg(DISTINCT i.staff_id::text)
               FILTER (WHERE i.staff_id IS NOT NULL) AS staff_ids
        FROM booking b
        LEFT JOIN booking_item i ON i.booking_id = b.id
       WHERE b.branch_id = ${toUuid(branchId)}::uuid
         AND (b.code ILIKE ${like} OR EXISTS (
               SELECT 1 FROM booking_item si
                WHERE si.booking_id = b.id AND si.service_name ILIKE ${like}))
       GROUP BY b.id
       ORDER BY b.start_at DESC
       LIMIT ${limit * 4}`;

    const services = await this.prisma.$queryRaw<
      {
        service_id: string;
        service_name: string;
        duration_min: number;
        price_fils: number;
      }[]
    >`
      SELECT DISTINCT ON (i.service_id)
             i.service_id::text AS service_id, i.service_name,
             i.duration_min, i.price_fils
        FROM booking_item i
        JOIN booking b ON b.id = i.booking_id
       WHERE b.branch_id = ${toUuid(branchId)}::uuid
         AND i.service_name ILIKE ${like}
       ORDER BY i.service_id, i.id DESC
       LIMIT ${limit * 2}`;

    return { bookings, services };
  }

  /** Open conflict worklist items across the branch, newest first. */
  async openConflicts(branchId: string): Promise<
    {
      item_id: string;
      change_id: string;
      booking_id: string;
      booking_code: string;
      kind: string;
      reason: string;
      staff_id: string | null;
      resource_type: string | null;
      created_at: Date;
      trading_day: Date;
      start_minute: number;
      duration_min: number;
    }[]
  > {
    return this.prisma.$queryRaw`
      SELECT ri.id AS item_id, rc.id AS change_id, ri.booking_id,
             ri.booking_code, rc.kind::text AS kind, rc.reason,
             rc.staff_id::text AS staff_id, rc.resource_type,
             rc.created_at, rc.trading_day,
             b.start_minute, b.duration_min
        FROM roster_change_item ri
        JOIN roster_change rc ON rc.id = ri.change_id
        JOIN booking b ON b.id = ri.booking_id
       WHERE rc.branch_id = ${toUuid(branchId)}::uuid
         AND ri.state = 'open'
       ORDER BY rc.created_at DESC`;
  }

  /**
   * The open conflict on each of these bookings, if any.
   *
   * WHY THIS EXISTS. The upcoming list has a CONFLICTS chip and the worklist
   * has a tile that routes to it -- and every row it landed on carried
   * `conflict: null`, because nothing ever populated the field. The desk was
   * sent to a filtered list with no cause shown and no repair offered, which
   * is worse than not having the chip.
   *
   * The `proposal` on a rung-4 item carries what the ladder prepared, so a
   * row can say not only what broke but what the salon is offering to do
   * about it.
   */
  async conflictsFor(bookingIds: readonly string[]): Promise<
    Map<
      string,
      {
        itemId: string;
        changeId: string;
        kind: string;
        reason: string;
        staffId: string | null;
        resourceType: string | null;
        rung: string | null;
        proposal: unknown;
        raisedAt: Date;
      }
    >
  > {
    if (bookingIds.length === 0) return new Map();

    const rows = await this.prisma.$queryRaw<
      {
        booking_id: string;
        item_id: string;
        change_id: string;
        kind: string;
        reason: string;
        staff_id: string | null;
        resource_type: string | null;
        rung: string | null;
        proposal: unknown;
        raised_at: Date;
      }[]
    >`
      SELECT ri.booking_id, ri.id AS item_id, rc.id AS change_id,
             rc.kind::text AS kind, rc.reason,
             rc.staff_id::text AS staff_id, rc.resource_type,
             ri.rung::text AS rung, ri.proposal, rc.created_at AS raised_at
        FROM roster_change_item ri
        JOIN roster_change rc ON rc.id = ri.change_id
       WHERE ri.state = 'open'
         AND ri.booking_id = ANY(${[...bookingIds]}::uuid[])
       ORDER BY rc.created_at DESC`;

    // Newest first, so first-wins keeps the most recent conflict per booking.
    const out = new Map<string, (typeof rows)[number]>();
    for (const r of rows) if (!out.has(r.booking_id)) out.set(r.booking_id, r);

    return new Map(
      [...out].map(([id, r]) => [
        id,
        {
          itemId: r.item_id,
          changeId: r.change_id,
          kind: r.kind,
          reason: r.reason,
          staffId: r.staff_id,
          resourceType: r.resource_type,
          rung: r.rung,
          proposal: r.proposal,
          raisedAt: r.raised_at,
        },
      ]),
    );
  }

  /** How many walk-ins are waiting, and how long the longest has been there. */
  async walkInPressure(
    branchId: string,
    tradingDay: string,
    nowMin: number,
  ): Promise<{ waiting: number; longestWaitMin: number }> {
    const rows = await this.prisma.$queryRaw<
      { waiting: bigint; earliest: number | null }[]
    >`
      SELECT count(*) AS waiting, min(w.joined_min) AS earliest
        FROM walk_in_entry w
       WHERE w.branch_id = ${toUuid(branchId)}::uuid
         AND w.trading_day = ${tradingDay}::date
         AND w.status = 'waiting'`;

    const r = rows[0];
    const waiting = Number(r?.waiting ?? 0n);
    return {
      waiting,
      longestWaitMin:
        waiting === 0 || r?.earliest == null
          ? 0
          : Math.max(0, nowMin - Number(r.earliest)),
    };
  }

  /** Bookings pending a deposit right now, for the worklist tile. */
  async depositsPending(branchId: string, fromDay: string): Promise<number> {
    const rows = await this.prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n
        FROM booking b
       WHERE b.branch_id = ${toUuid(branchId)}::uuid
         AND b.trading_day >= ${fromDay}::date
         AND b.status = 'pending_payment'`;
    return Number(rows[0]?.n ?? 0n);
  }

  /**
   * The waitlist board: who is offered, who is waiting, in the server's rank
   * order.
   *
   * ORDERED HERE ONLY BY JOIN TIME. The real ranking lives in
   * `domain/booking/waitlist.ts` and depends on the SLOT being offered, which
   * a board with no slot does not have. So this returns join order — which IS
   * the primary key of that ranking — and the board renders position from it.
   * Re-implementing tier weighting in SQL would be a second copy of a rule
   * that decides who gets a slot (CLAUDE.md 4).
   */
  async waitlistBoard(
    branchId: string,
    fromDay: string,
  ): Promise<
    {
      id: string;
      customer_id: string;
      service_id: string;
      trading_day: Date;
      window_from_min: number;
      window_to_min: number;
      preferred_staff_id: string | null;
      status: string;
      decline_count: number;
      offered_booking_code: string | null;
      offer_expires_at: Date | null;
      offered_start_min: number | null;
      offered_staff_id: string | null;
      offered_duration_min: number | null;
      joined_at: Date;
    }[]
  > {
    return this.prisma.$queryRaw`
      SELECT w.id, w.customer_id, w.service_id::text AS service_id,
             w.trading_day, w.window_from_min, w.window_to_min,
             w.preferred_staff_id::text AS preferred_staff_id,
             w.status::text AS status, w.decline_count,
             w.offered_booking_code, w.offer_expires_at,
             w.offered_start_min, w.offered_staff_id::text AS offered_staff_id,
             w.offered_duration_min, w.joined_at
        FROM waitlist_entry w
       WHERE w.branch_id = ${toUuid(branchId)}::uuid
         AND w.trading_day >= ${fromDay}::date
         AND w.status IN ('waiting', 'offered')
       ORDER BY w.joined_at ASC`;
  }

  /** How many waitlist entries converted into a booking, for the tile. */
  async waitlistConversion(
    branchId: string,
    fromDay: string,
  ): Promise<{ accepted: number; total: number }> {
    const rows = await this.prisma.$queryRaw<
      { accepted: bigint; total: bigint }[]
    >`
      SELECT count(*) FILTER (WHERE w.status = 'accepted') AS accepted,
             count(*) AS total
        FROM waitlist_entry w
       WHERE w.branch_id = ${toUuid(branchId)}::uuid
         AND w.trading_day >= ${fromDay}::date`;
    return {
      accepted: Number(rows[0]?.accepted ?? 0n),
      total: Number(rows[0]?.total ?? 0n),
    };
  }

  /** The recurring screen's list, with health derived from its occurrences. */
  async seriesBoard(
    branchId: string,
    /**
     * ONE SERIES, when the panel asks. Same query, same aggregate, so the
     * board row and the panel header cannot disagree -- which they did:
     * every identity and economics field the detail screen needs existed
     * only on the list, so a deep link had nothing to render.
     */
    seriesId?: string,
  ): Promise<
    {
      id: string;
      customer_id: string;
      service_id: string;
      preferred_staff_id: string | null;
      status: string;
      pattern: string;
      interval_weeks: number | null;
      weekdays: number[] | null;
      day_of_month: number | null;
      start_min: number;
      anchor_day: Date;
      end_kind: string;
      end_count: number | null;
      end_date: Date | null;
      auto_confirm_rule: string;
      baseline_price_fils: number;
      course_visits: number | null;
      course_drawn: number | null;
      course_total_net_fils: number | null;
      materialised_through: Date | null;
      needs_attention: bigint;
      skipped: bigint;
      total_occurrences: bigint;
      next_day: Date | null;
    }[]
  > {
    return this.prisma.$queryRaw`
      SELECT s.id, s.customer_id, s.service_id::text AS service_id,
             s.preferred_staff_id::text AS preferred_staff_id,
             s.status::text AS status, s.pattern::text AS pattern,
             s.interval_weeks, s.weekdays, s.day_of_month, s.start_min,
             s.anchor_day, s.end_kind::text AS end_kind, s.end_count, s.end_date,
             s.auto_confirm_rule::text AS auto_confirm_rule,
             s.baseline_price_fils, s.course_visits, s.course_drawn,
             s.course_total_net_fils, s.materialised_through,
             count(o.*) FILTER (WHERE o.state = 'needs_attention') AS needs_attention,
             count(o.*) FILTER (WHERE o.state = 'skipped') AS skipped,
             count(o.*) AS total_occurrences,
             min(o.planned_day) FILTER (
               WHERE o.planned_day >= CURRENT_DATE
                 AND o.state <> 'skipped'
             ) AS next_day
        FROM booking_series s
        LEFT JOIN series_occurrence o ON o.series_id = s.id
       WHERE s.branch_id = ${toUuid(branchId)}::uuid
         AND (${seriesId ?? null}::text IS NULL
              OR s.id = ${seriesId ?? null}::uuid)
       GROUP BY s.id
       ORDER BY s.created_at DESC`;
  }

  /**
   * One series' board row, found by id without needing its branch.
   *
   * The panel is reached by id alone -- a deep link carries no branch -- so
   * the branch is read off the row rather than demanded from the caller.
   */
  async seriesBranch(seriesId: string): Promise<string | null> {
    const rows = await this.prisma.$queryRaw<{ branch_id: string }[]>`
      SELECT branch_id::text AS branch_id FROM booking_series
       WHERE id = ${seriesId}::uuid LIMIT 1`;
    return rows[0]?.branch_id ?? null;
  }

  /** Series flagged at risk, with the customer, for the worklist tile. */
  async seriesAtRisk(
    branchId: string,
  ): Promise<{ id: string; customer_id: string }[]> {
    return this.prisma.$queryRaw`
      SELECT s.id, s.customer_id
        FROM booking_series s
       WHERE s.branch_id = ${toUuid(branchId)}::uuid
         AND s.status = 'active'
         AND EXISTS (
           SELECT 1 FROM series_occurrence o
            WHERE o.series_id = s.id AND o.state = 'needs_attention')`;
  }
}

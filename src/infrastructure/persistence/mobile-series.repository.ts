import { Injectable } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { TenantContext } from '../tenancy/tenant-context';
import { toUuid } from './hold.repository';
import type { FrequencyColumn } from '@domain/booking/mobile-series';

/**
 * A mobile routine's rows: one booking_series, one series_occurrence per
 * session, and the link on each session's booking.
 *
 * Persistence only (CLAUDE.md 7). Every session was already booked, one by
 * one, by the single mobile create; the handler hands down what it made and
 * this writes the rows that tie them together.
 *
 * THE SAME SHAPES THE DESK ALREADY WRITES, so the desk board and panel read a
 * mobile routine with no desk change: pattern CUSTOM with the session days,
 * end AFTER_COUNT, auto_confirm_on_schedule, service_id the first service,
 * preferred_staff_id the regular stylist, occurrences `materialised` with
 * their booking (or `planned` past the 90 day horizon). Only the nullable
 * mobile columns are new (20260926120000_mobile_series).
 */

/**
 * WHY `materialised_through` IS 9999-12-31 ON EVERY MOBILE ROUTINE.
 *
 * The desk's nightly job (SeriesMaterialiser) picks every ACTIVE series whose
 * materialised_through is before today (SeriesRepository.dueForTopUp), then
 * tops it up and books its planned occurrences through the DESK path: the
 * repair ladder that swaps stylist or time without asking (K11) and the
 * unpaid birth state (K4). A mobile routine must never be picked, and the
 * desk code must not change. This date keeps it out of that query for good.
 *
 * The desk panel shows it as the horizon line. The one way it changes is the
 * desk pressing "materialise" on a mobile routine by hand, which rewrites it;
 * the mobile job puts it back (plan E.4). Proven in
 * mobile-series.desk-job.spec.ts and prisma/proof-mobile-series-created.sql.
 */
export const MOBILE_NEVER_TOPPED_UP = '9999-12-31';

export interface MobileSeriesSessionInput {
  /** The session's number in the routine, from 0. */
  readonly index: number;
  readonly day: string;
  readonly startMin: number;
  readonly movedFromDayOfMonth: number | null;
  /** The booking the single create made. Null: past the horizon, planned. */
  readonly bookingId: string | null;
}

export interface CreateMobileSeriesInput {
  readonly branchId: string;
  readonly customerId: string;
  readonly frequency: FrequencyColumn;
  /** Every service of a session, in order (D1). The first is service_id. */
  readonly serviceIds: readonly string[];
  /** The regular stylist. */
  readonly stylistId: string;
  /** The routine's own time. A picked session may differ (D4). */
  readonly startMin: number;
  readonly paymentPlan: 'pay_at_salon';
  /** One session's services, net, before discount: the desk's baseline. */
  readonly baselinePriceFils: number;
  readonly sessions: readonly MobileSeriesSessionInput[];
}

const date = (day: string): Date => new Date(`${day}T00:00:00Z`);

@Injectable()
export class MobileSeriesRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenants: TenantContext,
  ) {}

  /**
   * Everything in one transaction: a routine is either all there, linked to
   * all its bookings, or not there at all. If this throws, the handler
   * cancels the sessions it booked.
   */
  async create(input: CreateMobileSeriesInput): Promise<{ seriesId: string }> {
    if (input.sessions.length === 0) {
      throw new Error('a routine needs sessions');
    }
    const days = [...input.sessions.map((s) => s.day)].sort();

    return this.prisma.$transaction(async (tx) => {
      const series = await tx.bookingSeries.create({
        data: {
          tenantId: this.tenants.current(),
          branchId: toUuid(input.branchId),
          customerId: toUuid(input.customerId),
          anchorDay: date(days[0]!),
          startMin: input.startMin,
          // Explicit dates, never a cadence the desk could re-expand into
          // other days (plan E.1, K5). The app's choice is in `frequency`.
          pattern: 'custom',
          customDates: days.map(date),
          endKind: 'after_count',
          endCount: input.sessions.length,
          autoConfirmRule: 'auto_confirm_on_schedule',
          serviceId: toUuid(input.serviceIds[0]!),
          preferredStaffId: toUuid(input.stylistId),
          baselinePriceFils: input.baselinePriceFils,
          materialisedThrough: date(MOBILE_NEVER_TOPPED_UP),
          source: 'mobile',
          frequency: input.frequency,
          serviceIds: input.serviceIds.map(toUuid),
          paymentPlan: input.paymentPlan,
        },
        select: { id: true },
      });

      await tx.seriesOccurrence.createMany({
        data: input.sessions.map((s) => ({
          seriesId: series.id,
          index: s.index,
          plannedDay: date(s.day),
          plannedStartMin: s.startMin,
          movedFromDayOfMonth: s.movedFromDayOfMonth,
          state:
            s.bookingId === null
              ? ('planned' as const)
              : ('materialised' as const),
          bookingId: s.bookingId,
        })),
      });

      // THE LINK, on each session's booking: series_id and booking_type
      // together ("write both or neither", schema.prisma), and channel
      // `recurring`, which is the desk calendar's RECURRING chip and keeps
      // compaction from moving the session. Scoped to the customer, so a
      // booking id that is not theirs links nothing, and nothing is written.
      for (const s of input.sessions) {
        if (s.bookingId === null) continue;
        const linked = await tx.booking.updateMany({
          where: {
            id: s.bookingId,
            customerId: toUuid(input.customerId),
            seriesId: null,
          },
          data: {
            seriesId: series.id,
            bookingType: 'routine',
            channel: 'recurring',
          },
        });
        if (linked.count !== 1) {
          throw new Error(
            `session ${s.index}: booking ${s.bookingId} could not be linked`,
          );
        }
      }

      await tx.eventOutbox.create({
        data: {
          aggregateType: 'series',
          aggregateId: series.id,
          eventType: 'series.created',
          payload: {
            source: 'mobile',
            frequency: input.frequency,
            occurrences: input.sessions.length,
            booked: input.sessions.filter((s) => s.bookingId !== null).length,
          },
        },
      });

      return { seriesId: series.id };
    });
  }

  /**
   * CANCEL (step 7): the routine ends at the customer's request, in one
   * transaction. The handler has already cancelled every booking behind it
   * through the lifecycle (refund bands, history, events), one by one. What
   * is left is written here:
   *
   * - the routine becomes `ended`, ONLY if it is still active or paused (the
   *   desk may have ended it a moment before; then nothing else is written);
   * - its sessions that were never booked (past the 90 day horizon, or
   *   waiting for a choice) are marked skipped, so none waits for a booking;
   * - its own event, `series.cancelled`, carries the app's reason. A routine
   *   with nothing booked has no booking history to carry it (plan, "Where
   *   the cancel reason is stored").
   *
   * True when the routine ended here.
   */
  async endByCustomer(input: {
    readonly seriesId: string;
    readonly unbookedIds: readonly string[];
    readonly reason: string | null;
    readonly cancelled: number;
  }): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const ended = await tx.bookingSeries.updateMany({
        where: { id: input.seriesId, status: { in: ['active', 'paused'] } },
        data: { status: 'ended' },
      });
      if (ended.count !== 1) return false;

      if (input.unbookedIds.length > 0) {
        await tx.seriesOccurrence.updateMany({
          where: {
            id: { in: [...input.unbookedIds] },
            seriesId: input.seriesId,
            bookingId: null,
          },
          data: { state: 'skipped' },
        });
      }

      await tx.eventOutbox.create({
        data: {
          aggregateType: 'series',
          aggregateId: input.seriesId,
          eventType: 'series.cancelled',
          payload: {
            source: 'mobile',
            status: 'ended',
            reason: input.reason,
            cancelled: input.cancelled,
            skipped: input.unbookedIds.length,
          },
        },
      });
      return true;
    });
  }

  /**
   * PAUSE and RESUME (step 7): the moved sessions on their new days, in one
   * transaction. The handler has already booked the new slots; this links
   * them exactly as `create` does, and sets the routine's own row.
   *
   * - The routine must still have `fromStatus` (active for a pause, paused
   *   for a resume). If the desk or another request changed it a moment
   *   before, nothing is written, and the handler releases what it booked.
   * - Every moved row is first parked on a far day of its own with nothing
   *   booked, then takes its new day and booking. So no two rows ever share
   *   a day or a booking in between, whatever the table's unique rules: a
   *   kept booking may move to another row.
   * - The routine's explicit dates follow its sessions (the desk reads a
   *   mobile routine as CUSTOM on these dates). Its count is unchanged (D6).
   * - Its own event, series.paused or series.resumed, says what moved.
   *
   * False when the routine no longer had `fromStatus`: nothing changed.
   */
  async moveSessions(input: {
    readonly seriesId: string;
    readonly customerId: string;
    readonly fromStatus: 'active' | 'paused';
    readonly sessions: readonly {
      readonly occurrenceId: string;
      readonly day: string;
      readonly startMin: number;
      readonly movedFromDayOfMonth: number | null;
      readonly bookingId: string | null;
    }[];
    /** The new bookings among them, to link to the routine. */
    readonly linkIds: readonly string[];
    readonly after: MoveRoutineUpdate;
    readonly summary: {
      readonly moved: number;
      readonly kept: number;
      readonly booked: number;
      readonly released: number;
    };
  }): Promise<boolean> {
    const { after } = input;
    return this.prisma.$transaction(async (tx) => {
      const changed = await tx.bookingSeries.updateMany({
        where: { id: input.seriesId, status: input.fromStatus },
        data: {
          status: after.status,
          pausedUntil:
            after.pausedUntil === null ? null : date(after.pausedUntil),
          pauseReason: after.pauseReason,
          pauseNote: after.pauseNote,
          ...(after.startMin === undefined ? {} : { startMin: after.startMin }),
          ...(after.preferredStaffId === undefined
            ? {}
            : { preferredStaffId: after.preferredStaffId }),
          ...(after.frequency === undefined
            ? {}
            : { frequency: after.frequency }),
          ...(after.anchorDay === undefined
            ? {}
            : { anchorDay: date(after.anchorDay) }),
        },
      });
      if (changed.count !== 1) return false;

      for (const [k, s] of input.sessions.entries()) {
        const parked = await tx.seriesOccurrence.updateMany({
          where: { id: s.occurrenceId, seriesId: input.seriesId },
          data: {
            plannedDay: new Date(Date.UTC(2999, 0, 1 + k)),
            bookingId: null,
            state: 'planned',
          },
        });
        if (parked.count !== 1) {
          throw new Error(
            `session ${s.occurrenceId} is not part of routine ${input.seriesId}`,
          );
        }
      }
      for (const s of input.sessions) {
        await tx.seriesOccurrence.updateMany({
          where: { id: s.occurrenceId, seriesId: input.seriesId },
          data: {
            plannedDay: date(s.day),
            plannedStartMin: s.startMin,
            movedFromDayOfMonth: s.movedFromDayOfMonth,
            state: s.bookingId === null ? 'planned' : 'materialised',
            bookingId: s.bookingId,
          },
        });
      }

      for (const bookingId of input.linkIds) {
        const linked = await tx.booking.updateMany({
          where: {
            id: bookingId,
            customerId: toUuid(input.customerId),
            seriesId: null,
          },
          data: {
            seriesId: input.seriesId,
            bookingType: 'routine',
            channel: 'recurring',
          },
        });
        if (linked.count !== 1) {
          throw new Error(`booking ${bookingId} could not be linked`);
        }
      }

      const days = await tx.seriesOccurrence.findMany({
        where: { seriesId: input.seriesId },
        select: { plannedDay: true },
        orderBy: { plannedDay: 'asc' },
      });
      await tx.bookingSeries.update({
        where: { id: input.seriesId },
        data: { customDates: days.map((d) => d.plannedDay) },
      });

      await tx.eventOutbox.create({
        data: {
          aggregateType: 'series',
          aggregateId: input.seriesId,
          eventType:
            after.status === 'paused' ? 'series.paused' : 'series.resumed',
          payload: {
            source: 'mobile',
            until: after.pausedUntil,
            reason: after.pauseReason,
            ...input.summary,
          },
        },
      });
      return true;
    });
  }

  /**
   * The hourly job (step 8): every app routine it looks at, active or
   * paused. Ended and completed ones are closed for good.
   */
  async openRoutines(): Promise<
    {
      readonly id: string;
      readonly customerId: string;
      readonly status: 'active' | 'paused';
      readonly pausedUntil: string | null;
    }[]
  > {
    const rows = await this.prisma.bookingSeries.findMany({
      where: { source: 'mobile', status: { in: ['active', 'paused'] } },
      select: { id: true, customerId: true, status: true, pausedUntil: true },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => ({
      id: r.id,
      customerId: r.customerId,
      status: r.status === 'paused' ? 'paused' : 'active',
      pausedUntil:
        r.pausedUntil === null
          ? null
          : r.pausedUntil.toISOString().slice(0, 10),
    }));
  }

  /**
   * Plan E.4 step 6: the desk's "materialise" button rewrites
   * materialised_through to today plus 70 days, which would let the desk's
   * nightly job book an app routine the desk's way (K11, K4). Put back.
   * Returns how many routines were put back.
   */
  async keepDeskAway(): Promise<number> {
    const far = date('9999-12-31');
    const out = await this.prisma.bookingSeries.updateMany({
      where: {
        source: 'mobile',
        OR: [
          { materialisedThrough: null },
          { materialisedThrough: { not: far } },
        ],
      },
      data: { materialisedThrough: far },
    });
    return out.count;
  }

  /**
   * Plan E.4 step 1: a pause whose date has come ends by itself. The pause
   * already moved the visits past that date (D6), so only the status and
   * the pause columns change. CLAIMED IN ONE UPDATE: of the two copies of
   * booking-api running the job, one resumes it, the other finds it done.
   */
  async resumeByJob(seriesId: string, today: string): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const claimed = await tx.bookingSeries.updateMany({
        where: {
          id: seriesId,
          source: 'mobile',
          status: 'paused',
          pausedUntil: { not: null, lte: date(today) },
        },
        data: {
          status: 'active',
          pausedUntil: null,
          pauseReason: null,
          pauseNote: null,
        },
      });
      if (claimed.count !== 1) return false;
      await tx.eventOutbox.create({
        data: {
          aggregateType: 'series',
          aggregateId: seriesId,
          eventType: 'series.resumed',
          payload: { source: 'mobile', by: 'job', on: today },
        },
      });
      return true;
    });
  }

  /**
   * Plan E.4 step 4: every visit closed, the routine is `completed`, so the
   * desk's job and this one never look at it again. Claimed as resumeByJob
   * is.
   */
  async completeByJob(seriesId: string): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const claimed = await tx.bookingSeries.updateMany({
        where: {
          id: seriesId,
          source: 'mobile',
          status: { in: ['active', 'paused'] },
        },
        data: { status: 'completed' },
      });
      if (claimed.count !== 1) return false;
      await tx.eventOutbox.create({
        data: {
          aggregateType: 'series',
          aggregateId: seriesId,
          eventType: 'series.completed',
          payload: { source: 'mobile', by: 'job' },
        },
      });
      return true;
    });
  }

  /**
   * Events the job writes with their OWN ids (the 48 hour reminders, R10).
   * An id already in the outbox, written by this copy an hour ago or by the
   * other copy a second ago, is skipped by the database itself. Returns how
   * many were new.
   */
  async writeEvents(
    seriesId: string,
    events: readonly {
      readonly id: string;
      readonly eventType: string;
      readonly payload: Readonly<Record<string, string | number>>;
    }[],
  ): Promise<number> {
    if (events.length === 0) return 0;
    const out = await this.prisma.eventOutbox.createMany({
      data: events.map((e) => ({
        id: e.id,
        aggregateType: 'series',
        aggregateId: seriesId,
        eventType: e.eventType,
        payload: { ...e.payload },
      })),
      skipDuplicates: true,
    });
    return out.count;
  }

  /**
   * EXTEND (step 6): more sessions on an existing app routine, in one
   * transaction, linked exactly as `create` links them (series_id,
   * booking_type and the `recurring` channel, scoped to the customer). The
   * routine's explicit dates and count grow with them. If this throws, the
   * handler cancels the sessions it booked.
   */
  async appendSessions(input: {
    readonly seriesId: string;
    readonly customerId: string;
    readonly sessions: readonly MobileSeriesSessionInput[];
  }): Promise<void> {
    if (input.sessions.length === 0) return;
    await this.prisma.$transaction(async (tx) => {
      await tx.seriesOccurrence.createMany({
        data: input.sessions.map((s) => ({
          seriesId: input.seriesId,
          index: s.index,
          plannedDay: date(s.day),
          plannedStartMin: s.startMin,
          movedFromDayOfMonth: s.movedFromDayOfMonth,
          state:
            s.bookingId === null
              ? ('planned' as const)
              : ('materialised' as const),
          bookingId: s.bookingId,
        })),
      });

      for (const s of input.sessions) {
        if (s.bookingId === null) continue;
        const linked = await tx.booking.updateMany({
          where: {
            id: s.bookingId,
            customerId: toUuid(input.customerId),
            seriesId: null,
          },
          data: {
            seriesId: input.seriesId,
            bookingType: 'routine',
            channel: 'recurring',
          },
        });
        if (linked.count !== 1) {
          throw new Error(
            `session ${s.index}: booking ${s.bookingId} could not be linked`,
          );
        }
      }

      await tx.bookingSeries.update({
        where: { id: input.seriesId },
        data: {
          customDates: { push: input.sessions.map((s) => date(s.day)) },
          endCount: { increment: input.sessions.length },
        },
      });
    });
  }
}

/**
 * A routine's own row after a PAUSE or RESUME (step 7). The pause columns
 * are cleared on a resume. What RESUME's "Customize first" changed (time,
 * stylist, frequency) is written too, with the new cadence's anchor day.
 */
export interface MoveRoutineUpdate {
  readonly status: 'active' | 'paused';
  readonly pausedUntil: string | null;
  readonly pauseReason: string | null;
  readonly pauseNote: string | null;
  readonly startMin?: number;
  readonly preferredStaffId?: string;
  readonly frequency?: FrequencyColumn;
  readonly anchorDay?: string;
}

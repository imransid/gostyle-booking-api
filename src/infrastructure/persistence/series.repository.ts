import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from './prisma.service';
import { toUuid, branchInstant } from './hold.repository';
import { SlugIndex } from './slug-uuid';
import { isExclusionViolation } from './pg-errors';
import { STAFF_SLUGS } from '../fixtures/fixture-booking-context';
import type {
  Occurrence,
  SeriesDefinition,
  Weekday,
} from '@domain/booking/recurrence';
import type { BookingStatus } from '@domain/booking/lifecycle';
import type { RepairOffer } from '@domain/availability/series-ladder';

/**
 * The series, and the occurrences it wants.
 *
 * Persistence only. Every decision this file acts on -- which days, which
 * slot, which state -- was already made by the domain and handed down. What
 * happens here is rows.
 */

export interface CreateSeriesInput {
  readonly branchId: string;
  readonly customerId: string;
  readonly anchorDay: string;
  readonly startMin: number;
  readonly pattern: 'weekly' | 'every_n_weeks' | 'monthly_on_date' | 'custom';
  readonly weekdays: readonly number[];
  readonly intervalWeeks: number | null;
  readonly dayOfMonth: number | null;
  readonly customDates: readonly string[];
  readonly endKind: 'never' | 'on_date' | 'after_count';
  readonly endDate: string | null;
  readonly endCount: number | null;
  readonly autoConfirmRule:
    'auto_confirm_on_schedule' | 'ask_each_time' | 'vip_standing';
  readonly serviceId: string;
  readonly preferredStaffId: string | null;
  readonly baselinePriceFils: number;
  readonly course: {
    readonly totalNetFils: number;
    readonly visits: number;
  } | null;
  /** Already expanded by the domain. */
  readonly occurrences: readonly Occurrence[];
  readonly horizonEnd: string;
}

export interface SeriesRow {
  readonly id: string;
  readonly branchId: string;
  readonly customerId: string;
  readonly startMin: number;
  readonly autoConfirmRule:
    'auto_confirm_on_schedule' | 'ask_each_time' | 'vip_standing';
  readonly status: 'active' | 'paused' | 'ended' | 'completed';
  readonly serviceId: string;
  readonly preferredStaffId: string | null;
  readonly baselinePriceFils: number;
  readonly grandfathered: boolean;
  readonly courseTotalNetFils: number | null;
  readonly courseVisits: number | null;
  readonly courseDrawn: number;
}

export interface PlannedRow {
  readonly id: string;
  readonly index: number;
  readonly plannedDay: string;
  readonly plannedStartMin: number;
}

/** Everything needed to write one occurrence into the diary. */
export interface MaterialiseInput {
  readonly occurrenceId: string;
  readonly branchId: string;
  readonly customerId: string;
  readonly tradingDay: string;
  readonly startMin: number;
  readonly durationMin: number;
  readonly staffId: string;
  readonly serviceId: string;
  readonly serviceName: string;
  readonly resourceType: string;
  readonly requiredSkill: string;
  readonly priceFils: number;
  readonly depositFils: number;
  readonly status: BookingStatus;
  readonly paymentStatus: 'none_required' | 'unpaid';
  readonly claimPreMin: number;
  readonly claimPostMin: number;
}

export type MaterialiseOutcome =
  | {
      readonly kind: 'materialised';
      readonly bookingId: string;
      readonly code: string;
    }
  /** The slot went while we were deciding. The occurrence stays planned. */
  | { readonly kind: 'raced' };

@Injectable()
export class SeriesRepository {
  private static readonly log = new Logger(SeriesRepository.name);

  /**
   * preferred_staff_id is written as toUuid(slug), so reading it back gives
   * the hash. The engine names professionals by slug, so a raw comparison
   * never matches and the ladder silently drops to "anyone at this time":
   * "Maya every Tuesday" becomes "whoever every Tuesday", with nothing in the
   * response to say so. Caught by the live run, not by a test.
   *
   * SlugIndex, not another local conversion -- that is what the boundary is
   * for, and each extra conversion is another place to forget.
   */
  private readonly staff = new SlugIndex(STAFF_SLUGS);

  constructor(private readonly prisma: PrismaService) {}

  async create(
    input: CreateSeriesInput,
  ): Promise<{ seriesId: string; planned: number }> {
    return this.prisma.$transaction(async (tx) => {
      const series = await tx.bookingSeries.create({
        data: {
          branchId: toUuid(input.branchId),
          customerId: toUuid(input.customerId),
          anchorDay: new Date(`${input.anchorDay}T00:00:00Z`),
          startMin: input.startMin,
          pattern: input.pattern,
          weekdays: [...input.weekdays],
          intervalWeeks: input.intervalWeeks,
          dayOfMonth: input.dayOfMonth,
          customDates: input.customDates.map((d) => new Date(`${d}T00:00:00Z`)),
          endKind: input.endKind,
          endDate:
            input.endDate === null
              ? null
              : new Date(`${input.endDate}T00:00:00Z`),
          endCount: input.endCount,
          autoConfirmRule: input.autoConfirmRule,
          serviceId: toUuid(input.serviceId),
          preferredStaffId:
            input.preferredStaffId === null
              ? null
              : toUuid(input.preferredStaffId),
          baselinePriceFils: input.baselinePriceFils,
          courseTotalNetFils: input.course?.totalNetFils ?? null,
          courseVisits: input.course?.visits ?? null,
          materialisedThrough: new Date(`${input.horizonEnd}T00:00:00Z`),
        },
        select: { id: true },
      });

      if (input.occurrences.length > 0) {
        await tx.seriesOccurrence.createMany({
          data: input.occurrences.map((o) => ({
            seriesId: series.id,
            index: o.index,
            plannedDay: new Date(`${o.date}T00:00:00Z`),
            plannedStartMin: o.startMin,
            movedFromDayOfMonth: o.movedFromDayOfMonth,
            state: 'planned' as const,
          })),
        });
      }

      await tx.eventOutbox.create({
        data: {
          aggregateType: 'series',
          aggregateId: series.id,
          eventType: 'series.created',
          payload: {
            occurrences: input.occurrences.length,
            horizonEnd: input.horizonEnd,
            pattern: input.pattern,
          },
        },
      });

      return { seriesId: series.id, planned: input.occurrences.length };
    });
  }

  /** Add days the pattern produced that we have not stored yet. */
  async topUp(
    seriesId: string,
    occurrences: readonly Occurrence[],
    horizonEnd: string,
  ): Promise<number> {
    if (occurrences.length === 0) {
      await this.prisma.bookingSeries.update({
        where: { id: seriesId },
        data: { materialisedThrough: new Date(`${horizonEnd}T00:00:00Z`) },
      });
      return 0;
    }

    return this.prisma.$transaction(async (tx) => {
      // skipDuplicates: the ordinal is unique per series, so a top-up that
      // overlaps what is already stored is a no-op rather than a crash. The
      // nightly job can therefore run twice without anybody minding.
      const made = await tx.seriesOccurrence.createMany({
        data: occurrences.map((o) => ({
          seriesId,
          index: o.index,
          plannedDay: new Date(`${o.date}T00:00:00Z`),
          plannedStartMin: o.startMin,
          movedFromDayOfMonth: o.movedFromDayOfMonth,
          state: 'planned' as const,
        })),
        skipDuplicates: true,
      });

      await tx.bookingSeries.update({
        where: { id: seriesId },
        data: { materialisedThrough: new Date(`${horizonEnd}T00:00:00Z`) },
      });

      return made.count;
    });
  }

  async load(seriesId: string): Promise<SeriesRow | null> {
    const s = await this.prisma.bookingSeries.findUnique({
      where: { id: seriesId },
    });
    if (s === null) return null;
    return {
      id: s.id,
      branchId: s.branchId,
      customerId: s.customerId,
      startMin: s.startMin,
      autoConfirmRule: s.autoConfirmRule,
      status: s.status,
      serviceId: s.serviceId,
      preferredStaffId:
        s.preferredStaffId === null
          ? null
          : this.staff.toSlug(s.preferredStaffId),
      baselinePriceFils: s.baselinePriceFils,
      grandfathered: s.grandfathered,
      courseTotalNetFils: s.courseTotalNetFils,
      courseVisits: s.courseVisits,
      courseDrawn: s.courseDrawn,
    };
  }

  /** Live series whose calendar has fallen behind the horizon. */
  async dueForTopUp(throughBefore: string, limit: number): Promise<string[]> {
    const rows = await this.prisma.bookingSeries.findMany({
      where: {
        status: 'active',
        OR: [
          { materialisedThrough: null },
          {
            materialisedThrough: { lt: new Date(`${throughBefore}T00:00:00Z`) },
          },
        ],
      },
      orderBy: { materialisedThrough: { sort: 'asc', nulls: 'first' } },
      take: limit,
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  /** Planned occurrences inside the booking horizon, oldest first. */
  async plannedWithin(
    seriesId: string,
    throughDay: string,
  ): Promise<PlannedRow[]> {
    const rows = await this.prisma.seriesOccurrence.findMany({
      where: {
        seriesId,
        state: 'planned',
        plannedDay: { lte: new Date(`${throughDay}T00:00:00Z`) },
      },
      orderBy: { index: 'asc' },
      select: {
        id: true,
        index: true,
        plannedDay: true,
        plannedStartMin: true,
      },
    });
    return rows.map((r) => ({
      id: r.id,
      index: r.index,
      plannedDay: r.plannedDay.toISOString().slice(0, 10),
      plannedStartMin: r.plannedStartMin,
    }));
  }

  /**
   * Write one occurrence into the diary as an ordinary booking.
   *
   * The reservations are what make it real: without them the occurrence
   * occupies no professional and no chair, and the next caller is offered the
   * same minute. The EXCLUDE constraint is the backstop -- if the slot went
   * between the plan and this write, Postgres refuses and we report a race
   * rather than double-booking a standing client.
   */
  async materialise(input: MaterialiseInput): Promise<MaterialiseOutcome> {
    const day = new Date(`${input.tradingDay}T00:00:00Z`);
    const startAt = branchInstant(input.tradingDay, input.startMin);
    const endAt = branchInstant(
      input.tradingDay,
      input.startMin + input.durationMin,
    );

    try {
      return await this.prisma.$transaction(async (tx) => {
        const key = `${input.branchId}:${input.resourceType}:${input.tradingDay}`;
        await tx.$executeRaw`
          SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;

        const codeRows = await tx.$queryRaw<{ code: string }[]>`
          SELECT 'GS-' || nextval('booking_code_seq') AS code`;
        const code = codeRows[0]?.code;
        if (code === undefined)
          throw new Error('booking_code_seq returned nothing');

        const booking = await tx.booking.create({
          data: {
            code,
            branchId: toUuid(input.branchId),
            customerId: toUuid(input.customerId),
            status: input.status,
            paymentStatus: input.paymentStatus,
            tradingDay: day,
            startAt,
            endAt,
            startMinute: input.startMin,
            durationMin: input.durationMin,
            priceFils: input.priceFils,
            depositFils: input.depositFils,
            channel: 'recurring',
          },
          select: { id: true, code: true },
        });

        const item = await tx.bookingItem.create({
          data: {
            bookingId: booking.id,
            serviceId: toUuid(input.serviceId),
            serviceName: input.serviceName,
            resourceType: input.resourceType,
            requiredSkill: input.requiredSkill,
            priceFils: input.priceFils,
            durationMin: input.durationMin,
            position: 0,
            staffId: toUuid(input.staffId),
          },
          select: { id: true },
        });

        await tx.staffReservation.create({
          data: {
            bookingItemId: item.id,
            branchId: toUuid(input.branchId),
            staffId: toUuid(input.staffId),
            tradingDay: day,
            kind: 'active',
            startAt,
            endAt,
            startMinute: input.startMin,
            durationMin: input.durationMin,
            claimPreMin: input.claimPreMin,
            claimPostMin: input.claimPostMin,
          },
        });

        await tx.resourceReservation.create({
          data: {
            bookingItemId: item.id,
            branchId: toUuid(input.branchId),
            resourceType: input.resourceType,
            tradingDay: day,
            startAt,
            endAt,
            startMinute: input.startMin,
            durationMin: input.durationMin,
          },
        });

        await tx.seriesOccurrence.update({
          where: { id: input.occurrenceId },
          data: {
            state: 'materialised',
            bookingId: booking.id,
            plannedDay: day,
            plannedStartMin: input.startMin,
            // A repaired occurrence carries no stale alternatives. DbNull,
            // not JsonNull: the column goes back to SQL NULL, which is what
            // the "alternatives only when stuck" constraint tests for.
            alternatives: Prisma.DbNull,
          },
        });

        await tx.eventOutbox.create({
          data: {
            aggregateType: 'booking',
            aggregateId: booking.id,
            eventType: 'occurrence.materialized',
            payload: {
              code: booking.code,
              tradingDay: input.tradingDay,
              startMin: input.startMin,
              staffId: input.staffId,
              status: input.status,
            },
          },
        });

        return {
          kind: 'materialised' as const,
          bookingId: booking.id,
          code: booking.code,
        };
      });
    } catch (e) {
      // The professional was taken between the plan and the write.
      //
      // The exclusion constraint is on (staff_id, time) with no branch in it,
      // and rightly so: a professional cannot be in two places at once. The
      // availability query IS branch-scoped, so the two can disagree, and
      // when they do the constraint is the one telling the truth. Losing the
      // race is an ordinary outcome, not a failure -- the occurrence stays
      // planned and the next run tries again.
      if (isExclusionViolation(e)) {
        SeriesRepository.log.warn(
          `Occurrence ${input.occurrenceId} lost its slot at the write; staying planned`,
        );
        return { kind: 'raced' as const };
      }
      throw e;
    }
  }

  /** The engine could not seat it. Attach what a human can choose from. */
  async markNeedsAttention(
    occurrenceId: string,
    alternatives: readonly RepairOffer[],
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const occ = await tx.seriesOccurrence.update({
        where: { id: occurrenceId },
        data: {
          state: 'needs_attention',
          bookingId: null,
          alternatives: alternatives.map((a) => ({
            startMin: a.startMin,
            staffId: a.staffId,
            distanceMin: a.distanceMin,
            keepsProfessional: a.keepsProfessional,
          })),
        },
        select: { seriesId: true, index: true },
      });

      await tx.eventOutbox.create({
        data: {
          aggregateType: 'series',
          aggregateId: occ.seriesId,
          eventType: 'occurrence.needs_attention',
          payload: {
            occurrenceId,
            index: occ.index,
            alternatives: alternatives.length,
          },
        },
      });
    });
  }

  async setStatus(
    seriesId: string,
    status: 'active' | 'paused' | 'ended' | 'completed',
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.bookingSeries.update({
        where: { id: seriesId },
        data: { status },
      });
      await tx.eventOutbox.create({
        data: {
          aggregateType: 'series',
          aggregateId: seriesId,
          eventType: `series.${status}`,
          payload: { status },
        },
      });
    });
  }

  /**
   * Cancel the bookings behind a set of occurrences, and mark them skipped.
   *
   * The occurrences named here were chosen by the domain: everything inside
   * the 48-hour protection window was held back for the desk to confirm one
   * at a time, and never reaches this call.
   */
  async cancelOccurrences(
    occurrenceIds: readonly string[],
    reason: string,
  ): Promise<number> {
    if (occurrenceIds.length === 0) return 0;

    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.seriesOccurrence.findMany({
        where: { id: { in: [...occurrenceIds] } },
        select: { id: true, bookingId: true, seriesId: true },
      });

      for (const r of rows) {
        if (r.bookingId !== null) {
          await tx.booking.update({
            where: { id: r.bookingId },
            data: { status: 'cancelled' },
          });
          // Releasing capacity is what actually frees the slot. The status
          // alone would leave the professional booked for a visit nobody is
          // coming to.
          const items = await tx.bookingItem.findMany({
            where: { bookingId: r.bookingId },
            select: { id: true },
          });
          const ids = items.map((i) => i.id);
          if (ids.length > 0) {
            await tx.staffReservation.updateMany({
              where: { bookingItemId: { in: ids } },
              data: { blocking: false },
            });
            await tx.resourceReservation.updateMany({
              where: { bookingItemId: { in: ids } },
              data: { blocking: false },
            });
          }
          await tx.bookingStatusHistory.create({
            data: {
              bookingId: r.bookingId,
              fromStatus: 'confirmed',
              toStatus: 'cancelled',
              actorKind: 'system',
              reason,
            },
          });
        }
        await tx.seriesOccurrence.update({
          where: { id: r.id },
          data: { state: 'skipped', bookingId: null },
        });
      }

      return rows.length;
    });
  }

  /**
   * The stored row, back as the domain's own definition.
   *
   * The domain expands patterns; the database stores them. This is the one
   * place the two vocabularies meet, so a column rename cannot leak into
   * recurrence.ts.
   */
  async definition(seriesId: string): Promise<SeriesDefinition | null> {
    const s = await this.prisma.bookingSeries.findUnique({
      where: { id: seriesId },
    });
    if (s === null) return null;

    const anchor = s.anchorDay.toISOString().slice(0, 10);

    const pattern: SeriesDefinition['pattern'] =
      s.pattern === 'weekly'
        ? { kind: 'weekly', weekdays: s.weekdays as Weekday[] }
        : s.pattern === 'every_n_weeks'
          ? { kind: 'every_n_weeks', weeks: s.intervalWeeks ?? 1 }
          : s.pattern === 'monthly_on_date'
            ? { kind: 'monthly_on_date', dayOfMonth: s.dayOfMonth ?? 1 }
            : {
                kind: 'custom',
                dates: s.customDates.map((d) => d.toISOString().slice(0, 10)),
              };

    const end: SeriesDefinition['end'] =
      s.endKind === 'on_date'
        ? {
            kind: 'on_date',
            date: (s.endDate ?? s.anchorDay).toISOString().slice(0, 10),
          }
        : s.endKind === 'after_count'
          ? { kind: 'after_count', count: s.endCount ?? 1 }
          : { kind: 'never' };

    return { anchor, startMin: s.startMin, pattern, end };
  }

  /** The occurrence timeline the series panel shows. */
  async timeline(seriesId: string): Promise<
    readonly {
      readonly id: string;
      readonly index: number;
      readonly day: string;
      readonly startMin: number;
      readonly state: string;
      readonly movedFromDayOfMonth: number | null;
      readonly bookingCode: string | null;
      readonly bookingStatus: string | null;
      readonly startsInHours: number;
      readonly alternatives: unknown;
    }[]
  > {
    const rows = await this.prisma.seriesOccurrence.findMany({
      where: { seriesId },
      orderBy: { index: 'asc' },
    });

    const bookingIds = rows
      .map((r) => r.bookingId)
      .filter((x): x is string => x !== null);
    const bookings =
      bookingIds.length === 0
        ? []
        : await this.prisma.booking.findMany({
            where: { id: { in: bookingIds } },
            select: { id: true, code: true, status: true, startAt: true },
          });
    const byId = new Map(bookings.map((b) => [b.id, b]));

    const now = Date.now();
    return rows.map((r) => {
      const b = r.bookingId === null ? undefined : byId.get(r.bookingId);
      const day = r.plannedDay.toISOString().slice(0, 10);
      const startsAt = b?.startAt ?? branchInstant(day, r.plannedStartMin);
      return {
        id: r.id,
        index: r.index,
        day,
        startMin: r.plannedStartMin,
        state: r.state,
        movedFromDayOfMonth: r.movedFromDayOfMonth,
        bookingCode: b?.code ?? null,
        bookingStatus: b?.status ?? null,
        startsInHours: (startsAt.getTime() - now) / 3_600_000,
        alternatives: r.alternatives,
      };
    });
  }

  /** Counts behind the health derivation. */
  async healthFacts(seriesId: string): Promise<{
    needsAttentionCount: number;
    noShowCount: number;
    skippedCount: number;
    consecutiveConfirmationExpiries: number;
  }> {
    const rows = await this.prisma.seriesOccurrence.findMany({
      where: { seriesId },
      orderBy: { index: 'desc' },
      select: { state: true, bookingId: true },
    });

    const bookingIds = rows
      .map((r) => r.bookingId)
      .filter((x): x is string => x !== null);
    const bookings =
      bookingIds.length === 0
        ? []
        : await this.prisma.booking.findMany({
            where: { id: { in: bookingIds } },
            select: { id: true, status: true },
          });
    const statusOf = new Map(bookings.map((b) => [b.id, b.status]));

    let needsAttentionCount = 0;
    let noShowCount = 0;
    let skippedCount = 0;
    let streak = 0;
    let streakBroken = false;

    // Rows are newest first, so the streak is counted from the most recent
    // occurrence backwards and stops at the first one that was honoured.
    for (const r of rows) {
      if (r.state === 'needs_attention') needsAttentionCount += 1;
      if (r.state === 'skipped') skippedCount += 1;

      const status = r.bookingId === null ? null : statusOf.get(r.bookingId);
      if (status === 'no_show') noShowCount += 1;

      if (!streakBroken) {
        if (status === 'expired') streak += 1;
        else if (status !== undefined && status !== null) streakBroken = true;
      }
    }

    return {
      needsAttentionCount,
      noShowCount,
      skippedCount,
      consecutiveConfirmationExpiries: streak,
    };
  }

  /**
   * Draw one visit from the course.
   *
   * The ledger entry is NEGATIVE: a draw spends credit the salon already
   * holds, so it moves the balance down exactly as applied_at_pos does. The
   * ledger's own CHECK enforces the sign, which is why the amount is negated
   * here rather than trusted from the caller.
   */
  async drawCourseVisit(
    seriesId: string,
    bookingId: string,
    amountFils: number,
  ): Promise<number> {
    return this.prisma.$transaction(async (tx) => {
      const s = await tx.bookingSeries.update({
        where: { id: seriesId },
        data: { courseDrawn: { increment: 1 } },
        select: { courseDrawn: true, courseVisits: true },
      });

      await tx.depositLedger.create({
        data: {
          bookingId,
          entryType: 'course_draw',
          amountFils: -Math.abs(amountFils),
          rail: 'internal',
          actorKind: 'system',
        },
      });

      return s.courseDrawn;
    });
  }
}

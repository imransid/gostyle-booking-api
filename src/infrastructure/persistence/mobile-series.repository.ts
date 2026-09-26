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
}

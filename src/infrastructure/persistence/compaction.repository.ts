import { Injectable } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { toUuid } from './hold.repository';
import { SlugIndex } from './slug-uuid';
import { STAFF_SLUGS } from '../fixtures/fixture-booking-context';
import type {
  DiaryBooking,
  Ineligibility,
} from '@domain/availability/compaction';

export interface DiaryRow {
  readonly booking: DiaryBooking;
  readonly customerId: string;
  readonly resourceType: string;
  readonly claimPreMin: number;
  readonly claimPostMin: number;
}

@Injectable()
export class CompactionRepository {
  /** Columns hold uuids; the planner and the engine speak slugs. */
  private readonly staff = new SlugIndex(STAFF_SLUGS);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * One professional-day diary, with each booking's eligibility already
   * decided.
   *
   * ELIGIBILITY IS DECIDED HERE because it depends on facts only the
   * database holds: whether the booking is a group lane, and whether it
   * belongs to a series. The planner is handed the answer rather than the
   * three queries it would take to work it out.
   */
  async diaryFor(branchId: string, tradingDay: string): Promise<DiaryRow[]> {
    const day = new Date(`${tradingDay}T00:00:00Z`);

    const bookings = await this.prisma.booking.findMany({
      where: {
        branchId: toUuid(branchId),
        tradingDay: day,
        status: {
          in: ['confirmed', 'pending_payment', 'pending_confirmation'],
        },
      },
      select: {
        id: true,
        code: true,
        status: true,
        startMinute: true,
        durationMin: true,
        customerId: true,
        groupId: true,
        items: {
          select: { staffId: true, resourceType: true },
          orderBy: { position: 'asc' },
          take: 1,
        },
      },
    });

    const ids = bookings.map((b) => b.id);

    // A booking that is one occurrence of a series. Its timing carries the
    // standing arrangement, so compaction does not get to touch it.
    const occurrences =
      ids.length === 0
        ? []
        : await this.prisma.seriesOccurrence.findMany({
            where: { bookingId: { in: ids } },
            select: { bookingId: true },
          });
    const inSeries = new Set(occurrences.map((o) => o.bookingId));

    const reservations =
      ids.length === 0
        ? []
        : await this.prisma.staffReservation.findMany({
            where: { bookingItem: { bookingId: { in: ids } }, blocking: true },
            select: {
              claimPreMin: true,
              claimPostMin: true,
              bookingItem: { select: { bookingId: true } },
            },
          });
    const claimsOf = new Map(
      reservations.map((r) => [
        r.bookingItem?.bookingId ?? '',
        { pre: r.claimPreMin, post: r.claimPostMin },
      ]),
    );

    return bookings.map((b) => {
      const ineligible = reasonFor(b.status, b.groupId, inSeries.has(b.id));
      return {
        booking: {
          bookingId: b.id,
          code: b.code,
          staffId: this.staff.toSlug(b.items[0]?.staffId ?? ''),
          startMin: b.startMinute,
          endMin: b.startMinute + b.durationMin,
          ...(ineligible === undefined ? {} : { ineligible }),
        },
        customerId: b.customerId,
        resourceType: b.items[0]?.resourceType ?? 'styling',
        claimPreMin: claimsOf.get(b.id)?.pre ?? 0,
        claimPostMin: claimsOf.get(b.id)?.post ?? 0,
      };
    });
  }
}

/**
 * Only PLAIN CONFIRMED bookings may be compacted.
 *
 * A booking still waiting on money or a reply is not settled enough to be
 * moved for the salon's convenience; a group lane and a series occurrence
 * both carry timing that means something outside the diary.
 */
function reasonFor(
  status: string,
  groupId: string | null,
  isOccurrence: boolean,
): Ineligibility | undefined {
  if (groupId !== null) return 'group_lane';
  if (isOccurrence) return 'series_occurrence';
  if (status !== 'confirmed') return 'not_confirmed';
  return undefined;
}

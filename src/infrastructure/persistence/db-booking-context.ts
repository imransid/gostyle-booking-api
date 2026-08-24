import { Injectable } from '@nestjs/common';
import type {
  BookingContextReader,
  DayContext,
} from '@application/ports/booking-context.port';
import type { Service } from '@domain/availability/feasible';
import type { StaffBooking } from '@domain/availability/staff-mask';
import type { ChairOccupation } from '@domain/availability/capacity';
import { FixtureBookingContext } from '../fixtures/fixture-booking-context';
import { PrismaService } from './prisma.service';
import { toUuid } from './hold.repository';

/**
 * The real adapter, for the tables this service owns.
 *
 * Catalogue, roster and chair registry still come from the fixture, because
 * those live in other services and the gRPC clients do not exist yet. What
 * changes here is the DIARY: staff and chair reservations are now read from
 * Postgres, so a held slot stops being offered.
 *
 * Before this, "a held slot is not sellable" was true only at the database.
 * The engine kept offering a taken slot and the exclusion constraint refused
 * it on click, which is safe but a poor thing to show an operator.
 */
@Injectable()
export class DbBookingContext implements BookingContextReader {
  constructor(
    private readonly fixture: FixtureBookingContext,
    private readonly prisma: PrismaService,
  ) {}

  loadServices(
    branchId: string,
    serviceIds: readonly string[],
  ): Promise<Service[]> {
    return this.fixture.loadServices(branchId, serviceIds);
  }

  loadCatalogue(branchId: string): Promise<Service[]> {
    return this.fixture.loadCatalogue(branchId);
  }

  async loadDay(branchId: string, tradingDay: string): Promise<DayContext> {
    const base = await this.fixture.loadDay(branchId, tradingDay);
    if (base.closureReason !== undefined) return base;

    const day = new Date(`${tradingDay}T00:00:00Z`);
    const branch = toUuid(branchId);
    const now = new Date();

    /**
     * A dead hold protects nothing, and it should stop protecting the instant
     * it expires rather than whenever the sweeper next runs.
     *
     * The sweeper deletes the row so the exclusion constraint stops seeing it.
     * This filter makes the ANSWER correct immediately, which closes the
     * thirty-second window where availability would still hide the slot.
     */
    const liveOnly = {
      blocking: true,
      branchId: branch,
      tradingDay: day,
      OR: [{ holdId: null }, { hold: { expiresAt: { gt: now } } }],
    };

    const [staffRows, chairRows] = await Promise.all([
      this.prisma.staffReservation.findMany({ where: liveOnly }),
      this.prisma.resourceReservation.findMany({ where: liveOnly }),
    ]);

    // The fixture speaks slugs ("maya"); the columns are UUIDs. toUuid is
    // deterministic, so the reverse map is just the roster hashed again.
    // This disappears the day real UUIDs arrive over gRPC.
    const slugOf = new Map(base.professionals.map((p) => [toUuid(p.id), p.id]));

    // Start from the fixture diary. It stands in for bookings made through
    // channels this service cannot see yet, so the day stays believably busy.
    const staffBookings = new Map<string, StaffBooking[]>();
    for (const [id, list] of base.staffBookings)
      staffBookings.set(id, [...list]);

    for (const r of staffRows) {
      const slug = slugOf.get(r.staffId) ?? r.staffId;
      const list = staffBookings.get(slug) ?? [];
      list.push({
        startMin: r.startMinute,
        endMin: r.startMinute + r.durationMin,
        claims: { preMin: r.claimPreMin, postMin: r.claimPostMin },
        ...(r.processingFromMin !== null && r.processingToMin !== null
          ? {
              processing: {
                fromMin: r.processingFromMin,
                toMin: r.processingToMin,
              },
            }
          : {}),
      });
      staffBookings.set(slug, list);
    }

    const occupations: ChairOccupation[] = [
      ...base.occupations,
      ...chairRows.map((r) => ({
        resourceType: r.resourceType,
        startMin: r.startMinute,
        endMin: r.startMinute + r.durationMin,
      })),
    ];

    return {
      professionals: base.professionals,
      resources: base.resources,
      staffBookings,
      occupations,
    };
  }
}

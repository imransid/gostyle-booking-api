import { Injectable, Logger } from '@nestjs/common';
import type {
  BookingContextReader,
  DayContext,
} from '@application/ports/booking-context.port';
import type { Professional, Service } from '@domain/availability/feasible';
import type { StaffBooking } from '@domain/availability/staff-mask';
import type { ChairOccupation } from '@domain/availability/capacity';
import { FixtureBookingContext } from '../fixtures/fixture-booking-context';
import { PrismaService } from './prisma.service';
import { toUuid } from './hold.repository';
import { PlatformServiceCatalogue } from './platform-service-catalogue';
import { PlatformStaffRoster } from './platform-staff-roster';

/**
 * The real adapter, for the tables this service owns.
 *
 * The DIARY is Postgres: staff and chair reservations are read from it, so a
 * held slot stops being offered.
 *
 * SERVICES and, behind their own flag, the ROSTER are now platform-first
 * (stage 1 of the slug-to-uuid migration). The CHAIR REGISTRY is still the
 * fixture, because platform does not expose chairs at all -- see
 * docs/api/PLATFORM-ASKS-BOOKING-CONTEXT.md, ask B1.
 *
 * Before this, "a held slot is not sellable" was true only at the database.
 * The engine kept offering a taken slot and the exclusion constraint refused
 * it on click, which is safe but a poor thing to show an operator.
 */
@Injectable()
export class DbBookingContext implements BookingContextReader {
  private static readonly log = new Logger(DbBookingContext.name);

  constructor(
    private readonly fixture: FixtureBookingContext,
    private readonly prisma: PrismaService,
    private readonly platform: PlatformServiceCatalogue,
    private readonly roster: PlatformStaffRoster,
  ) {}

  /**
   * Stage 1: platform first for a uuid, fixture for a slug.
   *
   * With SERVICES_FROM_PLATFORM off this is exactly what it always was --
   * the fixture, and nothing else runs. With it on, a real platform id
   * resolves over gRPC and a slug still resolves from the fixture, so both
   * kinds of caller work while we measure who is still sending which.
   *
   * The ORDER matters and is not arbitrary: platform ids are checked first
   * because a uuid can never be a fixture slug, so there is no case where
   * one shadows the other.
   */
  async loadServices(
    branchId: string,
    serviceIds: readonly string[],
  ): Promise<Service[]> {
    if (!this.platform.enabled()) {
      return this.fixture.loadServices(branchId, serviceIds);
    }

    const fromPlatform = await this.platform.resolve(branchId, serviceIds);
    const claimed = new Set(fromPlatform.map((s) => s.id.toLowerCase()));

    const rest = serviceIds.filter((id) => !claimed.has(id.toLowerCase()));
    const fromFixture = await this.fixture.loadServices(branchId, rest);

    // Back into the order the caller asked for. The chain is laid out in
    // basket order and a reshuffle here would silently reorder the visit.
    const byId = new Map(
      [...fromPlatform, ...fromFixture].map((s) => [s.id.toLowerCase(), s]),
    );
    const resolved = serviceIds
      .map((id) => byId.get(id.toLowerCase()))
      .filter((s): s is Service => s !== undefined);

    // Logs the split, and refuses a basket we cannot price or staff.
    this.platform.report(branchId, serviceIds, resolved);

    return resolved;
  }

  /**
   * The menu: platform first, fixture behind it.
   *
   * THE SAME SOURCE THE DIRECTORY ENDPOINT READS. This was the fixture and
   * nothing else, so the booking wizard and `/services-directory` described
   * two different salons -- the desk was offered haircut-finish and
   * fringe-trim for a tenant that sells Keratin and Olaplex. Whichever list
   * the front end built its picker from, it was wrong: one names services
   * nobody sells, the other names services the engine then refuses.
   *
   * The fixture entries STAY, appended, for exactly as long as the slug
   * callers do (proof scripts, the desk tests, every existing integration).
   * Platform ids win on a collision because a uuid can never be a slug, so
   * there is no case where one shadows the other.
   *
   * A platform failure falls back to the fixture rather than emptying the
   * menu, because an empty catalogue reads as "this salon sells nothing".
   */
  async loadCatalogue(branchId: string): Promise<Service[]> {
    const fixture = await this.fixture.loadCatalogue(branchId);
    if (!this.platform.enabled()) return fixture;

    try {
      const fromPlatform = await this.platform.catalogue(branchId);
      const claimed = new Set(fromPlatform.map((s) => s.id.toLowerCase()));
      return [
        ...fromPlatform,
        ...fixture.filter((s) => !claimed.has(s.id.toLowerCase())),
      ];
    } catch (e) {
      DbBookingContext.log.error(
        'Platform catalogue unreachable; serving the fixture menu. ' +
          (e instanceof Error ? e.message : String(e)),
      );
      return fixture;
    }
  }

  async loadDay(branchId: string, tradingDay: string): Promise<DayContext> {
    const base = await this.fixture.loadDay(branchId, tradingDay);
    if (base.closureReason !== undefined) return base;

    const professionals = await this.rosterFor(branchId, tradingDay, base);

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
    // This disappears the day real UUIDs arrive over gRPC -- and for a
    // platform roster it already has: toUuid passes a uuid through unchanged,
    // so every entry maps to itself and the diary keys match on the nose.
    const slugOf = new Map(professionals.map((p) => [toUuid(p.id), p.id]));

    // THE DIARY IS THE DATABASE. Nothing else.
    //
    // This used to start from the fixture's eleven hand-written bookings, on
    // the reasoning that they stood in for channels this service could not
    // see. That was fair while the fixture was the whole world. It stopped
    // being fair the moment real bookings existed: every day in production
    // then carried the same imaginary Friday, so a colour returned the same
    // three late-afternoon starts whatever the date, and six invented
    // bookings sat on real chairs.
    //
    // The CHAIR REGISTRY still comes from the fixture, and the ROSTER does
    // too unless STAFF_FROM_PLATFORM is on, because those genuinely live in
    // other services. The diary does not.
    const staffBookings = new Map<string, StaffBooking[]>();

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
      // resource_reservation rows are ALREADY split around the hands-free
      // band, because placeHold writes one row per chain segment and
      // expandChain does the splitting. Nothing to do here.
      ...chairRows.map((r) => ({
        resourceType: r.resourceType,
        startMin: r.startMinute,
        endMin: r.startMinute + r.durationMin,
      })),
    ];

    return {
      professionals,
      resources: base.resources,
      staffBookings,
      occupations,
    };
  }

  /**
   * Who is on today: platform's people, or the fixture's.
   *
   * ONE SPELLING PER REQUEST, and that is the whole point. The union of both
   * rosters was the obvious alternative and is the wrong one: the ranker would
   * then be free to assign `maya` to a mobile booking whose app has never
   * heard of a slug, and the id going back out would not be one the caller
   * could use again. Two id spaces on one payload is the trap CLAUDE.md 8 is
   * about, and this is where it would be set.
   *
   * EMPTY FALLS BACK. `resolve` answers `[]` for a missing tenant, an
   * unreachable platform and a branch that genuinely has no staff alike. The
   * first two are outages, and taking every slug caller down with them would
   * be a worse failure than the one this fixes. The log line distinguishes
   * them; this decision does not need to.
   */
  private async rosterFor(
    branchId: string,
    tradingDay: string,
    base: DayContext,
  ): Promise<readonly Professional[]> {
    if (!this.roster.enabled()) return base.professionals;

    const fromPlatform = await this.roster.resolve(branchId, tradingDay);
    if (fromPlatform.length > 0) return fromPlatform;

    DbBookingContext.log.warn(
      `STAFF_FROM_PLATFORM is on but platform listed no bookable stylist at ` +
        `branch ${branchId} on ${tradingDay}. Falling back to the fixture ` +
        'roster, which speaks slugs -- a caller sending a platform stylist ' +
        'uuid will be refused as unknown.',
    );
    return base.professionals;
  }
}

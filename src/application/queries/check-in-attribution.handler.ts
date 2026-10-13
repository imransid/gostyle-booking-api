import { Inject, Injectable, Logger } from '@nestjs/common';
import { shout, type Shouted } from '@application/contract/wire';
import {
  SCREEN_NAME_CAP_MS,
  SCREEN_NAME_LOOKUP_MS,
  withinCap,
} from '@application/contract/screen-names';
import {
  STAFF_DIRECTORY,
  type StaffDirectoryReader,
  type StaffNamesLookup,
} from '@application/ports/staff-directory.port';
import {
  checkInOf,
  staffShortName,
  type CheckInVia,
} from '@domain/booking/check-in-attribution';
import { CheckInRequestRepository } from '@infrastructure/persistence/check-in-request.repository';

/**
 * The welcome screen's facts: "Checked in by Layla R. at 14:24".
 */
export interface CheckInView {
  /** When the check-in that stands was written. */
  readonly at: string;
  /**
   * SELF: the customer asked first, and the desk approved it. STAFF: the desk
   * did it on its own. Null: checked in before this was recorded.
   */
  readonly via: Shouted<CheckInVia> | null;
  /**
   * "Layla R.", BEST EFFORT. Null when the desk member has no staff profile,
   * when platform did not answer in time, or when the profile has no first
   * name. The screen must read right without it.
   */
  readonly byName: string | null;
}

/**
 * WHO CHECKED THIS BOOKING IN, AND HOW, for a customer's screen.
 *
 * The facts are the booking's status history (check-in-attribution.ts):
 * when and how are stored there, and so is who, by id. The NAME is not
 * stored. It is asked of platform here, when the screen is read, so it is
 * never in front of a receptionist with a customer waiting.
 *
 * ONLY WHEN THERE IS SOMETHING TO SHOW. No check-in standing, a row that
 * names no desk member, a booking with no tenant to ask in: no lookup. The
 * caller holds back further (a waiting request does not call this at all).
 *
 * NEVER IN THE WAY OF THE READ: one lookup, quick (SCREEN_NAME_LOOKUP_MS)
 * and capped (SCREEN_NAME_CAP_MS), and whatever goes wrong with it is a null
 * name and at most one log line; after platform fails to answer, no lookup
 * at all for NAME_OUTAGE_SKIP_MS. A name missing is a cosmetic loss; the
 * read failing is not.
 */
/**
 * AFTER PLATFORM FAILS TO ANSWER, names are skipped for this long, in this
 * process. Reads in the window answer at once with no name, instead of each
 * holding a request open for the full cap for a name nobody will see: in an
 * outage, that is every checked-in customer in every salon refreshing. At
 * most one slow read and one log line per window per process; the first
 * read after it asks again.
 *
 * One window for every tenant: an outage is platform's, not a salon's. A
 * tenant too large to answer in time (the known cost in
 * SELF_CHECK_IN_HANDOVER.md) closes it for everyone for 30s, which costs
 * names, never a read.
 */
export const NAME_OUTAGE_SKIP_MS = 30_000;

@Injectable()
export class CheckInAttributionHandler {
  private static readonly log = new Logger('WelcomeScreen');

  /** No name lookups before this (NAME_OUTAGE_SKIP_MS). */
  private skipNamesUntilMs = 0;

  constructor(
    private readonly requests: CheckInRequestRepository,
    @Inject(STAFF_DIRECTORY) private readonly staff: StaffDirectoryReader,
  ) {}

  /** The check-in that stands on this booking, or null. */
  async ofBooking(bookingId: string): Promise<CheckInView | null> {
    const facts = await this.requests.checkInFactsOf(bookingId);
    if (facts === null) return null;
    const standing = checkInOf(facts.history);
    if (standing === null) return null;

    return {
      at: new Date(standing.atMs).toISOString(),
      via: standing.via === null ? null : shout(standing.via),
      byName:
        standing.by === null || facts.tenantId === null
          ? null
          : await this.nameOf(facts.tenantId, standing.by.id),
    };
  }

  private async nameOf(
    tenantId: string,
    userId: string,
  ): Promise<string | null> {
    // Platform did not answer a moment ago: do not wait on it again yet.
    if (Date.now() < this.skipNamesUntilMs) return null;

    const answer = await withinCap(
      this.staff
        .namesOf(tenantId, [userId], { quickMs: SCREEN_NAME_LOOKUP_MS })
        // An adapter that throws is one more way of not answering.
        .catch((e: unknown): StaffNamesLookup => ({
          kind: 'unavailable',
          error: e instanceof Error ? e.message : String(e),
        })),
      SCREEN_NAME_CAP_MS,
    );

    if (answer === null || answer.kind === 'unavailable') {
      this.skipNamesUntilMs = Date.now() + NAME_OUTAGE_SKIP_MS;
      const why =
        answer === null
          ? `did not answer within ${SCREEN_NAME_CAP_MS}ms`
          : `unavailable (${answer.error})`;
      CheckInAttributionHandler.log.warn(
        `name: platform ${why}; the screen went out without it, and names ` +
          `are skipped for the next ${NAME_OUTAGE_SKIP_MS / 1000}s`,
      );
      return null;
    }
    // Absent: no staff profile in that tenant. An answer, not a fault.
    const name = answer.names.get(userId.toLowerCase());
    return name === undefined
      ? null
      : staffShortName(name.firstName, name.lastName);
  }
}

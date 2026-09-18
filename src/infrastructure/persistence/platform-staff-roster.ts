import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  STAFF_DIRECTORY,
  type StaffDirectoryReader,
} from '@application/ports/staff-directory.port';
import { TenantContext } from '../tenancy/tenant-context';
import type { Professional } from '@domain/availability/feasible';
import { DAY_END_MIN, DAY_START_MIN } from '@domain/availability/grid';
import { parseOffDays, toProfessional } from '@domain/availability/roster';

/**
 * Stage 1 of the slug-to-UUID migration, roster half.
 *
 * WHAT THIS IS FOR. `PlatformServiceCatalogue` beside this file fixed exactly
 * one half of the problem: a real service uuid resolves, so the basket prices
 * and the money verifies. The roster stayed on the fixture's six slugs, so the
 * very next step refused --
 *
 *     {"field":"stylists","code":"stylist_unavailable",
 *      "message":"16:00 is no longer available. Offers have refreshed."}
 *
 * -- for a stylist the SAME SERVICE had just handed the app out of
 * `GET /v1/staff-directory/stylists`. The slot was free the whole time. The
 * engine excluded all six fixture professionals as `not_preferred` against a
 * uuid none of them could ever equal, which left an empty pool and an empty
 * union, and an empty union has only one sentence to say (CLAUDE.md 8: the
 * fifth bite, and the same kind as the other four).
 *
 * OFF BY DEFAULT. `STAFF_FROM_PLATFORM=true` turns it on. With the flag off
 * nothing changes at all: the fixture answers, exactly as before, and every
 * desk test and proof script keeps its slugs.
 *
 * WHAT IT DOES NOT TOUCH. Skills and chairs stay as they are -- see
 * docs/api/PLATFORM-ASKS-BOOKING-CONTEXT.md, asks A2 and B1. Shifts (A3) are
 * half answered here: `ListStylists` carries `opening_time`, `closing_time`
 * and `offday` per stylist, which is a real published window even though it
 * is not the per-day `shift` table A3 asks for.
 */

export const STAFF_FROM_PLATFORM = (): boolean =>
  (process.env.STAFF_FROM_PLATFORM ?? '').trim().toLowerCase() === 'true';

/** The branch's trading window, for a stylist who publishes no hours. */
const BRANCH_WINDOW = { startMin: DAY_START_MIN, endMin: DAY_END_MIN };

@Injectable()
export class PlatformStaffRoster {
  private static readonly log = new Logger(PlatformStaffRoster.name);

  constructor(
    @Inject(STAFF_DIRECTORY) private readonly directory: StaffDirectoryReader,
    private readonly tenants: TenantContext,
  ) {}

  enabled(): boolean {
    return STAFF_FROM_PLATFORM();
  }

  /**
   * The people platform says work at this branch on this day.
   *
   * EMPTY IS A REAL ANSWER and the caller treats it as one: it falls back to
   * the fixture rather than answering "the salon has no staff", because with
   * this flag on and platform unreachable, an empty roster would take every
   * existing slug caller down with it. The adapter beneath swallows transport
   * failures and logs them (grpc-staff-directory.ts says why), so empty here
   * means "platform answered and had nothing" OR "platform is down", and the
   * log line is the only place those two are distinguishable.
   */
  async resolve(branchId: string, tradingDay: string): Promise<Professional[]> {
    const tenantId = this.tenants.current();
    if (tenantId === null) {
      /**
       * NO TENANT, NO LOOKUP -- the same rule as the services catalogue.
       * ListStylists is tenant-scoped, and guessing a tenant would either
       * fail or, worse, succeed against somebody else's staff.
       */
      PlatformStaffRoster.log.warn(
        'Cannot resolve the roster from platform: no X-Tenant-Id on this ' +
          'request, and ListStylists is tenant-scoped. Falling back to the ' +
          'fixture roster.',
      );
      return [];
    }

    const stylists = await this.directory.listStylists(tenantId, branchId);

    const rostered: Professional[] = [];
    const inactive: string[] = [];
    const offToday: string[] = [];
    const defaulted: string[] = [];
    const unreadable: string[] = [];

    for (const s of stylists) {
      if (s.id.trim() === '') {
        /**
         * An id-less stylist cannot be booked and must not be counted as
         * capacity. `staff_profile_id` is absent on the wire when platform
         * sends the proto3 default, and the adapter turns that into ''.
         */
        unreadable.push(s.name === '' ? '(unnamed)' : s.name);
        continue;
      }

      const { unparsed } = parseOffDays(s.offday);
      if (unparsed.length > 0) {
        /**
         * SAID OUT LOUD, never silently treated as "works every day". An
         * offday nobody could read is a stylist who may be rostered onto a
         * day they do not work, and the only symptom is a customer arriving
         * to an empty chair.
         */
        PlatformStaffRoster.log.warn(
          `offday for stylist ${s.id} reads "${s.offday ?? ''}" -- could not ` +
            `understand [${unparsed.join(', ')}]. They are treated as ` +
            'WORKING on those days.',
        );
      }

      const verdict = toProfessional(s, BRANCH_WINDOW, tradingDay);
      if (verdict.kind === 'inactive') {
        inactive.push(s.id);
        continue;
      }
      if (verdict.kind === 'off_today') {
        offToday.push(s.id);
        continue;
      }
      if (verdict.shiftFrom === 'branch') defaulted.push(s.id);
      rostered.push(verdict.professional);
    }

    /**
     * ONE LINE PER LOAD, naming every drop.
     *
     * The measurement stage 2 needs, and the first thing to read when a
     * booking is refused for a stylist the app can see (CLAUDE.md 9). Without
     * the drops it says "platform sent eleven, the engine offers three" and
     * leaves the interesting part out.
     */
    PlatformStaffRoster.log.log(
      `roster branch=${branchId} day=${tradingDay} ` +
        `rostered=${rostered.length} [${rostered.map((p) => p.id).join(',')}] ` +
        `inactive=[${inactive.join(',')}] ` +
        `off_today=[${offToday.join(',')}] ` +
        `no_id=[${unreadable.join(',')}]`,
    );

    if (defaulted.length > 0) {
      /**
       * A branch-window shift is a GUESS at somebody's working hours, and a
       * guess that sells their time. Worth a line of its own every time.
       */
      PlatformStaffRoster.log.warn(
        `No published hours for [${defaulted.join(',')}] -- each is being ` +
          `offered across the whole branch window ` +
          `${BRANCH_WINDOW.startMin}-${BRANCH_WINDOW.endMin}. See ask A3.`,
      );
    }

    if (rostered.length > 0) {
      /**
       * The mirror of SKILLS_UNVERIFIED on the services side, and stated for
       * the same reason: platform publishes no skills for staff, so nobody
       * resolved here can be SHOWN to be qualified for anything. A platform
       * service's own skill is blank, which is what lets the pair book at
       * all -- and that pairing is already gated behind SKILLS_UNVERIFIED.
       * A FIXTURE service still refuses these stylists by name, which is the
       * honest answer until ask A2 lands.
       */
      PlatformStaffRoster.log.warn(
        `STAFF_FROM_PLATFORM: ${rostered.length} stylist(s) resolved with NO ` +
          'skills -- they can take a platform service (blank skill) and are ' +
          'refused by name for a fixture one. See ask A2.',
      );
    }

    return rostered;
  }
}

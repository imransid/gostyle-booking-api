import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  BOOKING_CONTEXT,
  type BookingContextReader,
} from '@application/ports/booking-context.port';
import {
  feasibleSet,
  staffAvailableAt,
  expandChain,
  DESK_CHANNEL,
  ONLINE_CHANNEL,
  type Channel,
} from '@domain/availability/feasible';
import { bitAt, type Mask } from '@domain/availability/mask';
import { bookingError } from '@application/contract/errors';
import { describeRefusal } from '@application/queries/get-availability.handler';
import {
  toSlot,
  toMin,
  formatMinute,
  DAILY_BOOKING_CAP,
  SLOTS,
  SLOT_MIN,
  OFFER_SPACING_MIN,
} from '@domain/availability/grid';
import { effectiveUnits } from '@domain/availability/capacity';
import {
  feasibilityToken,
  startHold,
  formatCountdown,
  remainingSeconds,
  HOLD_TTL_MS,
  type AttendedInterval,
} from '@domain/booking/hold';
import {
  HoldRepository,
  type ResourceDemand,
} from '@infrastructure/persistence/hold.repository';

export interface PlaceHoldCommand {
  readonly branchId: string;
  readonly tradingDay: string;
  readonly serviceIds: readonly string[];
  readonly startMin: number;
  /** null means "any available", and the engine picks least-loaded. */
  readonly preferredStaffId: string | null;
  readonly customerId: string | null;
  readonly channel: 'desk' | 'online';
  readonly nowOverrideMin?: number;
}

export interface HoldView {
  readonly holdId: string;
  readonly expiresAt: string;
  readonly expiresInSeconds: number;
  readonly countdown: string;
  readonly staff: { id: string; name: string };
  readonly startMin: number;
  readonly start: string;
  readonly endMin: number;
  readonly end: string;
  readonly durationMin: number;
  readonly feasibilityToken: string;
}

@Injectable()
export class PlaceHoldHandler {
  private static readonly log = new Logger(PlaceHoldHandler.name);

  constructor(
    @Inject(BOOKING_CONTEXT) private readonly context: BookingContextReader,
    private readonly holds: HoldRepository,
  ) {}

  async execute(cmd: PlaceHoldCommand): Promise<HoldView> {
    const services = await this.context.loadServices(
      cmd.branchId,
      cmd.serviceIds,
    );
    if (services.length !== cmd.serviceIds.length) {
      throw new NotFoundException('One or more services do not exist');
    }

    const day = await this.context.loadDay(cmd.branchId, cmd.tradingDay);
    if (day.closureReason !== undefined) {
      throw new UnprocessableEntityException(day.closureReason);
    }

    const channel: Channel =
      cmd.channel === 'online' ? ONLINE_CHANNEL : DESK_CHANNEL;

    /**
     * A STYLIST NOBODY HAS HEARD OF IS NOT A BUSY STYLIST.
     *
     * Asked BEFORE the engine runs, because the engine cannot tell the two
     * apart. `eligible()` drops every professional who is not the preferred
     * one as `not_preferred`, so an id belonging to no roster at all empties
     * the pool exactly the way a fully booked salon does -- and the refusal
     * below then says "16:00 is no longer available. Offers have refreshed."
     * about a slot that was free the whole time.
     *
     * That is what the mobile app hit: it lists stylists from the platform
     * staff directory, which answers with `staff_profile_id` uuids, and sends
     * one back on the booking. The engine's roster was the fixture's six
     * slugs. Two id spaces, no overlap, and a refusal that named the time
     * instead of the mismatch (CLAUDE.md 8).
     */
    const preferredStaffId = cmd.preferredStaffId;
    if (
      preferredStaffId !== null &&
      !day.professionals.some((p) => p.id === preferredStaffId)
    ) {
      /**
       * WHICH ROSTER SAID NO, the way `unknown_service` says which catalogue
       * did. The id being absent is half the answer; the other half is what
       * the roster DOES hold, because six slugs tells you instantly that
       * STAFF_FROM_PLATFORM is off, and eleven uuids tells you it is on and
       * this person is not among them (CLAUDE.md 9).
       */
      PlaceHoldHandler.log.warn(
        `unknown_stylist at branch ${cmd.branchId} on ${cmd.tradingDay}: ` +
          `asked for ${preferredStaffId}; BOOKING_CONTEXT rosters ` +
          `${day.professionals.length} professional(s) ` +
          `[${day.professionals.map((p) => p.id).join(', ')}]. This roster ` +
          'is NOT the gRPC staff directory unless STAFF_FROM_PLATFORM=true.',
      );

      throw bookingError(
        'BOOKING_STAFF_UNKNOWN',
        'That stylist does not work at this salon, so no time can be held ' +
          'with them. Pick one of the salon’s stylists.',
        {
          staffId: preferredStaffId,
          roster: day.professionals.map((p) => ({ id: p.id, name: p.name })),
        },
      );
    }

    // FRESH. The offer list the operator is looking at may be seconds old,
    // and this is the moment that stops mattering.
    const result = feasibleSet({
      services,
      professionals: day.professionals,
      staffBookings: day.staffBookings,
      resources: day.resources,
      occupations: day.occupations,
      channel,
      window: { fromMin: 600, toMin: 1320 },
      preferredStaffId: cmd.preferredStaffId,
      isToday: false,
      nowMin: cmd.nowOverrideMin ?? 0,
      dailyCap: DAILY_BOOKING_CAP,
    });

    const slot = toSlot(cmd.startMin);
    if (!bitAt(result.union, slot)) {
      /**
       * WHY, NOT JUST NO.
       *
       * "12:30 is no longer available" is true and useless when the real
       * answer is "Lina does not cut hair". The engine already knows: it
       * dropped each ineligible professional with a reason, and the
       * availability endpoint has been rendering those as `refusals` all
       * along. A named professional who was excluded gets that reason and
       * the code that goes with it, so the desk is told to pick someone
       * else rather than to try another time.
       */
      const preferred = preferredStaffId;
      const named =
        preferred === null ? undefined : result.excluded.get(preferred);

      if (named !== undefined && named.kind === 'missing_skills') {
        throw bookingError(
          'BOOKING_SKILL_MISSING',
          `${nameOf(day, preferred ?? '')} ${describeRefusal(named)} ` +
            `(${requiredOf(services)}).`,
          {
            staffId: preferred,
            missingSkills: named.skills,
            requires: requirements(services),
            eligibleStaff: whoCouldTakeIt(result.excluded, day),
          },
        );
      }

      if (named !== undefined && named.kind === 'daily_cap') {
        throw bookingError(
          'BOOKING_STAFF_UNAVAILABLE',
          `${nameOf(day, preferred ?? '')} ${describeRefusal(named)}.`,
          {
            staffId: preferred,
            eligibleStaff: whoCouldTakeIt(result.excluded, day),
          },
        );
      }

      // THE REFRESHED OFFERS TRAVEL WITH THE REFUSAL. Without them the desk
      // has to re-run the search by hand to find out what IS free, and the
      // customer watches them do it.
      throw bookingError(
        preferred === null ? 'BOOKING_SLOT_TAKEN' : 'BOOKING_STAFF_UNAVAILABLE',
        `${formatMinute(cmd.startMin)} is no longer available. Offers have refreshed.`,
        {
          offers: freeStarts(result.union),
          ...(preferred === null ? {} : { staffId: preferred }),
        },
      );
    }

    const loadOf = (id: string): number =>
      day.professionals.find((p) => p.id === id)?.bookingsToday ?? 0;

    const who = staffAvailableAt(result, slot);
    const staffId = [...who].sort(
      (a, b) => loadOf(a) - loadOf(b) || (a < b ? -1 : 1),
    )[0];
    if (staffId === undefined) {
      throw bookingError(
        'BOOKING_STAFF_UNAVAILABLE',
        'Nobody is free for that start any more.',
        { offers: freeStarts(result.union) },
      );
    }

    // The digest of the world this decision was made against. Compared again
    // at confirm, so a calendar that moved underneath us is detected rather
    // than assumed away.
    const attended: AttendedInterval[] = [];
    for (const [id, list] of day.staffBookings) {
      for (const b of list) {
        attended.push({
          staffId: id,
          startMin: b.startMin,
          endMin: b.endMin,
          status: 'blocking',
        });
      }
    }

    const unitsOf = (type: string): number => {
      const r = day.resources.find((x) => x.id === type);
      return r === undefined ? 0 : effectiveUnits(r);
    };

    const demand: ResourceDemand[] = expandChain(services)
      .filter((s) => s.resourceType !== null)
      .map((s) => ({
        resourceType: s.resourceType as string,
        startMin: cmd.startMin + s.offsetMin,
        endMin: cmd.startMin + s.offsetMin + s.durationMin,
        units: unitsOf(s.resourceType as string),
      }));

    const first = services[0];
    const last = services[services.length - 1];

    const outcome = await this.holds.place({
      branchId: cmd.branchId,
      customerId: cmd.customerId,
      tradingDay: cmd.tradingDay,
      staffId,
      startMin: cmd.startMin,
      durationMin: result.durationMin,
      claimPreMin: first?.claims.preMin ?? 0,
      claimPostMin: last?.claims.postMin ?? 0,
      ...(services.length === 1 && first?.processing !== undefined
        ? { processing: first.processing }
        : {}),
      resourceDemand: demand,
      feasibilityToken: feasibilityToken(attended),
      ttlMs: HOLD_TTL_MS,
    });

    // Both refusals are normal outcomes, not failures. 409 says "try again
    // with fresh information", which is exactly right.
    if (outcome.kind === 'staff_taken') {
      throw bookingError(
        'BOOKING_SLOT_TAKEN',
        'Someone took this while you were deciding. Nothing was charged. Offers have refreshed.',
        { offers: freeStarts(result.union) },
      );
    }
    if (outcome.kind === 'no_chair') {
      throw bookingError(
        'BOOKING_CAPACITY_BLOCKED',
        `Every ${outcome.resourceType} station is taken at ${formatMinute(cmd.startMin)} ` +
          `(${outcome.inUse} of ${outcome.units} in use).`,
        {
          resourceType: outcome.resourceType,
          inUse: outcome.inUse,
          units: outcome.units,
          offers: freeStarts(result.union),
        },
      );
    }

    const clock = startHold(outcome.expiresAt.getTime() - HOLD_TTL_MS);
    const nowMs = Date.now();
    const endMin = cmd.startMin + result.durationMin;

    return {
      holdId: outcome.holdId,
      expiresAt: outcome.expiresAt.toISOString(),
      expiresInSeconds: remainingSeconds(clock, nowMs),
      countdown: formatCountdown(clock, nowMs),
      staff: {
        id: staffId,
        name: day.professionals.find((p) => p.id === staffId)?.name ?? staffId,
      },
      startMin: cmd.startMin,
      start: formatMinute(cmd.startMin),
      endMin,
      end: formatMinute(endMin),
      durationMin: result.durationMin,
      feasibilityToken: feasibilityToken(attended),
    };
  }

  async release(holdId: string): Promise<{ released: boolean }> {
    return { released: await this.holds.release(holdId) };
  }
}

/**
 * The starts that ARE free, from the union mask the refusal was computed
 * against.
 *
 * Capped at three because that is what the desk can read out loud, and it is
 * the same three-offer policy the availability endpoint already follows.
 * Derived from the mask that has just been built rather than re-running the
 * engine: the refusal and its alternatives then describe the same instant,
 * which a second query could not promise.
 */
function freeStarts(union: Mask): { startMin: number; start: string }[] {
  const out: { startMin: number; start: string }[] = [];
  for (let i = 0; i < SLOTS && out.length < 3; i++) {
    if (bitAt(union, i)) {
      const startMin = toMin(i);
      out.push({ startMin, start: formatMinute(startMin) });
      i += OFFER_SPACING_MIN / SLOT_MIN - 1;
    }
  }
  return out;
}

/** A professional's display name, for a refusal a human reads. */
function nameOf(
  day: { professionals: readonly { id: string; name: string }[] },
  id: string,
): string {
  return day.professionals.find((p) => p.id === id)?.name ?? id;
}

/**
 * Who WOULD have been eligible, had the desk not named someone.
 *
 * `result.pool` is the wrong answer here and was briefly the published one:
 * naming a professional excludes every other with reason `not_preferred`, so
 * the pool narrows to one and an empty pool reads as "nobody in this salon
 * can do this". Those `not_preferred` exclusions are exactly the people who
 * CAN, which is what the desk needs in order to drop the booking somewhere
 * useful.
 */
function whoCouldTakeIt(
  excluded: ReadonlyMap<string, { kind: string }>,
  day: { professionals: readonly { id: string; name: string }[] },
): { id: string; name: string }[] {
  const out: { id: string; name: string }[] = [];
  for (const [id, reason] of excluded) {
    if (reason.kind === 'not_preferred') {
      out.push({ id, name: nameOf(day, id) });
    }
  }
  return out;
}

/** "hair at level 2", for a message a human reads out. */
function requiredOf(
  services: readonly { skill: string; requiredLevel: number }[],
): string {
  return [
    ...new Set(services.map((s) => `${s.skill} at level ${s.requiredLevel}`)),
  ].join(', ');
}

/**
 * The same thing structured, because the LEVEL is what the prose was missing.
 *
 * "does not hold the required skills: hair" is misleading about a stylist who
 * holds hair at level 1 for a service needing level 2 -- she holds the skill,
 * just not deeply enough. The client should not have to parse a sentence to
 * tell those apart.
 */
function requirements(
  services: readonly { skill: string; requiredLevel: number }[],
): { skill: string; level: number }[] {
  const seen = new Map<string, number>();
  for (const s of services) {
    seen.set(s.skill, Math.max(seen.get(s.skill) ?? 0, s.requiredLevel));
  }
  return [...seen].map(([skill, level]) => ({ skill, level }));
}

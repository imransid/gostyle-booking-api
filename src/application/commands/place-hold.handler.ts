import {
  ConflictException,
  Inject,
  Injectable,
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
import { bitAt } from '@domain/availability/mask';
import {
  toSlot,
  formatMinute,
  DAILY_BOOKING_CAP,
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
      throw new ConflictException(
        `${formatMinute(cmd.startMin)} is no longer available. Offers have refreshed.`,
      );
    }

    const loadOf = (id: string): number =>
      day.professionals.find((p) => p.id === id)?.bookingsToday ?? 0;

    const who = staffAvailableAt(result, slot);
    const staffId = [...who].sort(
      (a, b) => loadOf(a) - loadOf(b) || (a < b ? -1 : 1),
    )[0];
    if (staffId === undefined) {
      throw new ConflictException('Nobody is free for that start any more.');
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
      throw new ConflictException(
        'Someone took this while you were deciding. Nothing was charged. Offers have refreshed.',
      );
    }
    if (outcome.kind === 'no_chair') {
      throw new ConflictException(
        `Every ${outcome.resourceType} station is taken at ${formatMinute(cmd.startMin)} ` +
          `(${outcome.inUse} of ${outcome.units} in use).`,
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

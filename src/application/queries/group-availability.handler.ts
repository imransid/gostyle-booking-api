import {
  ConflictException,
  Inject,
  Injectable,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  GroupHoldRepository,
  type GroupHoldInput,
} from '@infrastructure/persistence/group-hold.repository';
import {
  BOOKING_CONTEXT,
  type BookingContextReader,
} from '@application/ports/booking-context.port';
import { DAILY_BOOKING_CAP, formatMinute } from '@domain/availability/grid';
import { modeToWire, type WireGroupMode } from '@application/contract/wire';
import type { GroupMode, PartyPlan } from '@domain/availability/party';
import { MAX_PARTY_STARTS } from '@domain/availability/party-starts';
import { skillsRequired } from '@domain/booking/service-resolution';

export interface GroupAvailabilityQuery {
  readonly branchId: string;
  readonly tradingDay: string;
  readonly targetMin: number;
  readonly mode: GroupMode;
  readonly finishWindowMin?: number;
  readonly maxStaggerMin?: number;
  readonly participants: readonly {
    readonly label: string;
    readonly serviceIds: readonly string[];
    readonly preferredStaffId: string | null;
  }[];
}

export interface GroupAvailabilityView {
  readonly branchId: string;
  readonly tradingDay: string;
  readonly targetMin: number;
  readonly target: string;
  readonly mode: WireGroupMode;
  readonly feasible: boolean;
  /** Present when feasible. Advisory: nothing is held. */
  readonly lanes: readonly {
    readonly label: string;
    readonly staffId: string;
    readonly start: string;
    readonly end: string;
    readonly startMin: number;
    readonly endMin: number;
    readonly resourceType: string;
  }[];
  /** Present when not. The same sentence the hold would have refused with. */
  readonly reason?: string;
  readonly remedy?: string;
  /** Said out loud, because an availability answer is not a reservation. */
  readonly advisory: string;
}

/** The same question, at several starts. */
export interface GroupAvailabilityManyQuery extends Omit<
  GroupAvailabilityQuery,
  'targetMin'
> {
  readonly targetMins: readonly number[];
}

/**
 * One answer per start asked, in the order asked. Each one is exactly the
 * view the single call returns for that start -- the same keys, in the same
 * order -- so a client can treat an entry as the answer it would have got.
 */
export interface GroupAvailabilityManyView {
  readonly starts: readonly GroupAvailabilityView[];
}

/**
 * Can this party be seated at this time? Without taking it.
 *
 * The wizard needs to colour a date strip without holding a slot per cell,
 * and the desk needs to answer "is Thursday any good?" without burning a
 * ten-minute hold to find out. It runs THE SAME planner the hold runs, on the
 * same context, so a green answer here and a refusal at the hold can only
 * mean the diary moved in between -- which is the honest reason, and the one
 * the hold already reports.
 */
@Injectable()
export class GroupAvailabilityHandler {
  constructor(
    private readonly repo: GroupHoldRepository,
    @Inject(BOOKING_CONTEXT) private readonly context: BookingContextReader,
  ) {}

  async execute(q: GroupAvailabilityQuery): Promise<GroupAvailabilityView> {
    if (q.participants.length < 2) {
      throw new UnprocessableEntityException(
        'A group needs at least two participants. Ask about a single appointment instead.',
      );
    }
    if (q.participants.length > 8) {
      throw new UnprocessableEntityException(
        `A party of ${q.participants.length} is larger than the online cap of 8. The desk can take this as an event.`,
      );
    }

    const day = await this.context.loadDay(q.branchId, q.tradingDay);
    if (day.closureReason !== undefined)
      throw new ConflictException(day.closureReason);

    const resourceCounts: Record<string, number> = {};
    for (const r of day.resources) {
      resourceCounts[r.id] = Math.max(0, r.units - r.outOfService);
    }

    const specs = await Promise.all(
      q.participants.map(async (p, i) => {
        const services = await this.context.loadServices(
          q.branchId,
          p.serviceIds,
        );
        if (services.length !== p.serviceIds.length) {
          throw new UnprocessableEntityException(
            `${p.label}: one or more services do not exist.`,
          );
        }
        return {
          participant: {
            id: `p${i}`,
            label: p.label,
            skills: skillsRequired(services),
            durationMin: services.reduce((n, s) => n + s.durationMin, 0),
            resourceType: services[services.length - 1]!.resourceType,
            preferredStaffId: p.preferredStaffId,
          },
        };
      }),
    );

    const roster: GroupHoldInput['roster'] = {
      professionals: day.professionals.map((p) => ({
        id: p.id,
        name: p.name,
        skills: [...p.skills.keys()],
        atCap: p.bookingsToday >= DAILY_BOOKING_CAP,
      })),
      resourceCounts,
    };

    const plan = await this.repo.planOnly({
      branchId: q.branchId,
      tradingDay: q.tradingDay,
      targetMin: q.targetMin,
      mode: q.mode,
      participants: specs,
      roster,
      options: {
        ...(q.finishWindowMin !== undefined
          ? { finishWindowMin: q.finishWindowMin }
          : {}),
        ...(q.maxStaggerMin !== undefined
          ? { maxStaggerMin: q.maxStaggerMin }
          : {}),
      },
    });

    const base = {
      branchId: q.branchId,
      tradingDay: q.tradingDay,
      targetMin: q.targetMin,
      target: formatMinute(q.targetMin),
      mode: modeToWire(q.mode),
      advisory:
        'Advisory. Nothing is held, and another desk may take one of these ' +
        'lanes before you do.',
    };

    if (plan.kind === 'infeasible') {
      return {
        ...base,
        feasible: false,
        lanes: [],
        reason: plan.reason,
        remedy: plan.remedy,
      };
    }

    const labelOf = new Map(
      specs.map((s) => [s.participant.id, s.participant.label]),
    );

    return {
      ...base,
      feasible: true,
      lanes: plan.lanes.map((l) => ({
        label: labelOf.get(l.participantId) ?? l.participantId,
        staffId: l.staffId,
        start: formatMinute(l.startMin),
        end: formatMinute(l.endMin),
        startMin: l.startMin,
        endMin: l.endMin,
        resourceType: l.resourceType,
      })),
    };
  }

  /**
   * Can this party be seated at any of these times? One load, many answers.
   *
   * The day view asks about a whole day, and asking execute() once per start
   * reloaded the day, the roster and every participant's services each time
   * -- the expensive part -- to run a planner that costs next to nothing.
   * Here they are loaded once and the planner runs once per start against
   * that single picture (GroupHoldRepository.planMany).
   *
   * EACH ANSWER IS THE ONE execute() GIVES for that start: the same checks
   * in the same order, the same refusals for the same reasons, and the same
   * view, key for key. A closed day or an unknown service refuses the whole
   * call, exactly as it refuses every single one -- neither depends on the
   * start. group-availability.handler.spec.ts holds the two side by side.
   *
   * execute() is deliberately left as it was rather than rewritten on top of
   * this. The setup below repeats its first half; the spec fails the moment
   * the two disagree.
   */
  async executeMany(
    q: GroupAvailabilityManyQuery,
  ): Promise<GroupAvailabilityManyView> {
    if (q.participants.length < 2) {
      throw new UnprocessableEntityException(
        'A group needs at least two participants. Ask about a single appointment instead.',
      );
    }
    if (q.participants.length > 8) {
      throw new UnprocessableEntityException(
        `A party of ${q.participants.length} is larger than the online cap of 8. The desk can take this as an event.`,
      );
    }
    // Unreachable over HTTP, like the two above: the DTO refuses first.
    if (q.targetMins.length < 1 || q.targetMins.length > MAX_PARTY_STARTS) {
      throw new UnprocessableEntityException(
        `Ask about between 1 and ${MAX_PARTY_STARTS} start times at once, not ${q.targetMins.length}.`,
      );
    }

    const day = await this.context.loadDay(q.branchId, q.tradingDay);
    if (day.closureReason !== undefined)
      throw new ConflictException(day.closureReason);

    const resourceCounts: Record<string, number> = {};
    for (const r of day.resources) {
      resourceCounts[r.id] = Math.max(0, r.units - r.outOfService);
    }

    const specs = await Promise.all(
      q.participants.map(async (p, i) => {
        const services = await this.context.loadServices(
          q.branchId,
          p.serviceIds,
        );
        if (services.length !== p.serviceIds.length) {
          throw new UnprocessableEntityException(
            `${p.label}: one or more services do not exist.`,
          );
        }
        return {
          participant: {
            id: `p${i}`,
            label: p.label,
            skills: skillsRequired(services),
            durationMin: services.reduce((n, s) => n + s.durationMin, 0),
            resourceType: services[services.length - 1]!.resourceType,
            preferredStaffId: p.preferredStaffId,
          },
        };
      }),
    );

    const plans = await this.repo.planMany({
      branchId: q.branchId,
      tradingDay: q.tradingDay,
      targetMins: q.targetMins,
      mode: q.mode,
      participants: specs,
      roster: {
        professionals: day.professionals.map((p) => ({
          id: p.id,
          name: p.name,
          skills: [...p.skills.keys()],
          atCap: p.bookingsToday >= DAILY_BOOKING_CAP,
        })),
        resourceCounts,
      },
      options: {
        ...(q.finishWindowMin !== undefined
          ? { finishWindowMin: q.finishWindowMin }
          : {}),
        ...(q.maxStaggerMin !== undefined
          ? { maxStaggerMin: q.maxStaggerMin }
          : {}),
      },
    });

    const labelOf = new Map(
      specs.map((s) => [s.participant.id, s.participant.label]),
    );

    return {
      starts: plans.map((plan, i) =>
        this.viewOf(q, q.targetMins[i]!, plan, labelOf),
      ),
    };
  }

  /** One start's answer, built exactly as execute() builds it. */
  private viewOf(
    q: GroupAvailabilityManyQuery,
    targetMin: number,
    plan: PartyPlan,
    labelOf: ReadonlyMap<string, string>,
  ): GroupAvailabilityView {
    const base = {
      branchId: q.branchId,
      tradingDay: q.tradingDay,
      targetMin,
      target: formatMinute(targetMin),
      mode: modeToWire(q.mode),
      advisory:
        'Advisory. Nothing is held, and another desk may take one of these ' +
        'lanes before you do.',
    };

    if (plan.kind === 'infeasible') {
      return {
        ...base,
        feasible: false,
        lanes: [],
        reason: plan.reason,
        remedy: plan.remedy,
      };
    }

    return {
      ...base,
      feasible: true,
      lanes: plan.lanes.map((l) => ({
        label: labelOf.get(l.participantId) ?? l.participantId,
        staffId: l.staffId,
        start: formatMinute(l.startMin),
        end: formatMinute(l.endMin),
        startMin: l.startMin,
        endMin: l.endMin,
        resourceType: l.resourceType,
      })),
    };
  }
}

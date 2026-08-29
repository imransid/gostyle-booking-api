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
import type { GroupMode } from '@domain/availability/party';

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
            skills: [...new Set(services.map((s) => s.skill))],
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
}

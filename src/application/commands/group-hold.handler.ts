import { modeToWire, type WireGroupMode } from '@application/contract/wire';
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
import { HOLD_TTL_MS } from '@domain/booking/hold';
import type { GroupMode } from '@domain/availability/party';

export interface GroupHoldCommand {
  readonly branchId: string;
  readonly organiserId: string;
  readonly tradingDay: string;
  readonly targetMin: number;
  readonly mode: GroupMode;
  readonly arrangement:
    'organiser_pays_all' | 'split_equally' | 'each_pays_own';
  /**
   * How many minutes apart the party may finish. Zero, the default, means
   * exactly together.
   */
  readonly finishWindowMin?: number;
  /** The widest gap allowed between the first and last arrival. */
  readonly maxStaggerMin?: number;
  readonly participants: readonly {
    readonly label: string;
    readonly serviceIds: readonly string[];
    readonly customerId: string | null;
    readonly guestName: string | null;
    readonly preferredStaffId: string | null;
  }[];
}

export interface GroupHoldView {
  readonly groupId: string;
  readonly holdId: string;
  readonly expiresAt: string;
  readonly expiresInSeconds: number;
  readonly mode: WireGroupMode;
  readonly lanes: readonly {
    readonly label: string;
    readonly staffId: string;
    readonly start: string;
    readonly end: string;
  }[];
}

@Injectable()
export class GroupHoldHandler {
  constructor(
    private readonly repo: GroupHoldRepository,
    @Inject(BOOKING_CONTEXT)
    private readonly context: BookingContextReader,
  ) {}

  async execute(cmd: GroupHoldCommand): Promise<GroupHoldView> {
    if (cmd.participants.length < 2) {
      throw new UnprocessableEntityException(
        'A group needs at least two participants. Book this as a single appointment instead.',
      );
    }
    if (cmd.participants.length > 8) {
      throw new UnprocessableEntityException(
        `A party of ${cmd.participants.length} is larger than the online cap of 8. The desk can take this as an event.`,
      );
    }

    // The roster comes from the SAME source the single-booking engine uses,
    // so a group and a single booking can never disagree about who works
    // today or how many chairs exist.
    const day = await this.context.loadDay(cmd.branchId, cmd.tradingDay);
    if (day.closureReason !== undefined) {
      throw new ConflictException(day.closureReason);
    }

    const resourceCounts: Record<string, number> = {};
    for (const r of day.resources) {
      // Units out of service are not capacity. A chair removed by a closed
      // floor is exactly as unavailable as one that was never bought.
      resourceCounts[r.id] = Math.max(0, r.units - r.outOfService);
    }

    // Each participant's services, priced and measured.
    const specs: GroupHoldInput['participants'] = await Promise.all(
      cmd.participants.map(async (p, i) => {
        const services = await this.context.loadServices(
          cmd.branchId,
          p.serviceIds,
        );
        if (services.length !== p.serviceIds.length) {
          throw new UnprocessableEntityException(
            `${p.label}: one or more services do not exist.`,
          );
        }
        const durationMin = services.reduce((n, s) => n + s.durationMin, 0);
        const skills = [...new Set(services.map((s) => s.skill))];

        return {
          participant: {
            id: `p${i}`,
            label: p.label,
            skills,
            durationMin,
            // The chair the LAST service needs. A chain that ends at a basin
            // is holding a basin at the end, not a styling chair.
            resourceType: services[services.length - 1]!.resourceType,
            preferredStaffId: p.preferredStaffId,
          },
          customerId: p.customerId,
          guestName: p.guestName,
        };
      }),
    );

    const outcome = await this.repo.place({
      branchId: cmd.branchId,
      organiserId: cmd.organiserId,
      tradingDay: cmd.tradingDay,
      targetMin: cmd.targetMin,
      mode: cmd.mode,
      arrangement: cmd.arrangement,
      participants: specs,
      ttlMs: HOLD_TTL_MS,
      options: {
        ...(cmd.finishWindowMin !== undefined
          ? { finishWindowMin: cmd.finishWindowMin }
          : {}),
        ...(cmd.maxStaggerMin !== undefined
          ? { maxStaggerMin: cmd.maxStaggerMin }
          : {}),
      },
      roster: {
        professionals: day.professionals.map((p) => ({
          id: p.id,
          name: p.name,
          // The engine holds skill LEVELS; the planner only asks whether the
          // skill is held at all. Level gating stays where it already lives.
          skills: [...p.skills.keys()],
          atCap: p.bookingsToday >= DAILY_BOOKING_CAP,
        })),
        resourceCounts,
      },
    });

    if (outcome.kind === 'infeasible') {
      // 409 rather than 422: the request is well formed, the world just does
      // not have room for it right now. The remedy tells the desk what to try.
      throw new ConflictException(`${outcome.reason} ${outcome.remedy}`);
    }
    if (outcome.kind === 'raced') {
      throw new ConflictException(
        'Someone took one of those lanes while the party was being planned. Nothing was held. Offers have refreshed.',
      );
    }

    const byId = new Map(specs.map((s) => [s.participant.id, s]));
    return {
      groupId: outcome.groupId,
      holdId: outcome.holdId,
      expiresAt: outcome.expiresAt.toISOString(),
      expiresInSeconds: Math.round(
        (outcome.expiresAt.getTime() - Date.now()) / 1000,
      ),
      mode: modeToWire(cmd.mode),
      lanes: outcome.lanes.map((l) => ({
        label: byId.get(l.participantId)!.participant.label,
        staffId: l.staffId,
        start: formatMinute(l.startMin),
        end: formatMinute(l.endMin),
      })),
    };
  }
}

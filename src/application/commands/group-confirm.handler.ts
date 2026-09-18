import { shout, type Shouted } from '@application/contract/wire';
import type { GroupStatus } from '@domain/booking/group-status';
import {
  ConflictException,
  GoneException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { GroupConfirmRepository } from '@infrastructure/persistence/group-confirm.repository';
import { PrismaService } from '@infrastructure/persistence/prisma.service';
import {
  BOOKING_CONTEXT,
  type BookingContextReader,
} from '@application/ports/booking-context.port';
import { DAILY_BOOKING_CAP, formatMinute } from '@domain/availability/grid';
import { Money } from '@domain/shared/money';
// The SAME price table the single confirm uses. One catalogue, one answer.
import { priceOf } from './confirm-booking.handler';
import {
  priceOfService,
  skillsRequired,
  sourceOfAll,
} from '@domain/booking/service-resolution';
import { SlugIndex } from '@infrastructure/persistence/slug-uuid';
import { DEFAULT_BRANCH_ID } from '@infrastructure/tenancy/branch-context';

export interface GroupConfirmCommand {
  readonly groupId: string;
  readonly holdId: string;
  readonly participants: readonly {
    readonly label: string;
    readonly serviceIds: readonly string[];
    readonly preferredStaffId: string | null;
  }[];
  readonly actorId: string | null;
}

export interface GroupConfirmView {
  readonly groupId: string;
  readonly status: Shouted<GroupStatus>;
  readonly bookings: readonly {
    readonly label: string;
    readonly code: string;
    readonly staffId: string;
    readonly start: string;
    readonly share: string;
  }[];
}

@Injectable()
export class GroupConfirmHandler {
  /**
   * Every branch slug that exists. Anything else in the column is a real
   * platform uuid and passes through untouched.
   */
  private static readonly branches = new SlugIndex([DEFAULT_BRANCH_ID]);

  constructor(
    private readonly repo: GroupConfirmRepository,
    private readonly prisma: PrismaService,
    @Inject(BOOKING_CONTEXT)
    private readonly context: BookingContextReader,
  ) {}

  async execute(cmd: GroupConfirmCommand): Promise<GroupConfirmView> {
    const group = await this.prisma.bookingGroup.findUnique({
      where: { id: cmd.groupId },
      select: { branchId: true, tradingDay: true, status: true },
    });
    if (group === null) throw new NotFoundException('No such group');
    if (group.status !== 'draft') {
      throw new ConflictException(
        `This group is already ${shout(group.status)}. Nothing was changed.`,
      );
    }

    const tradingDay = group.tradingDay.toISOString().slice(0, 10);

    /**
     * THE BRANCH COMES FROM THE GROUP, not from a literal.
     *
     * This read 'marina-walk' in three places, under a comment claiming the
     * branch "comes from the caller, as it does everywhere else". It did
     * not: GroupConfirmDto carries no branch, so there was nothing to come
     * from. Hold honoured cmd.branchId all the way down and confirm then
     * discarded it, which is the worse half of the bug -- a party held at
     * another branch was confirmed against marina-walk's roster, diary and
     * chairs, and its bookings were written there.
     *
     * The reason for the literal was real: booking_group.branch_id is a
     * uuid and the fixture catalogue speaks slugs, so the stored value
     * looked one-way. It is not. toUuid passes a genuine uuid through
     * unchanged and folds a slug deterministically, so SlugIndex inverts
     * it -- a folded slug comes back as its slug, and a platform branch id
     * comes back as itself (slug-uuid.spec.ts pins both).
     *
     * That is rule 8: use SlugIndex, never another local conversion.
     */
    const branchId = GroupConfirmHandler.branches.toSlug(group.branchId);

    const day = await this.context.loadDay(branchId, tradingDay);

    const resourceCounts: Record<string, number> = {};
    for (const r of day.resources) {
      resourceCounts[r.id] = Math.max(0, r.units - r.outOfService);
    }

    const items = await Promise.all(
      cmd.participants.map(async (p, i) => {
        const services = await this.context.loadServices(
          branchId,
          p.serviceIds,
        );
        return {
          participantId: `p${i}`,
          label: p.label,
          serviceIds: p.serviceIds,
          priceFils: services.reduce(
            (n, s) => n + priceOfService(s, priceOf),
            0,
          ),
          skills: skillsRequired(services),
          durationMin: services.reduce((n, s) => n + s.durationMin, 0),
          resourceType: services[services.length - 1]!.resourceType,
          preferredStaffId: p.preferredStaffId,
          // One row, several services: mixed where they disagree.
          source: sourceOfAll(services),
        };
      }),
    );

    const outcome = await this.repo.confirm({
      groupId: cmd.groupId,
      holdId: cmd.holdId,
      branchId,
      tradingDay,
      items,
      roster: {
        professionals: day.professionals.map((p) => ({
          id: p.id,
          name: p.name,
          skills: [...p.skills.keys()],
          atCap: p.bookingsToday >= DAILY_BOOKING_CAP,
        })),
        resourceCounts,
      },
      actorId: cmd.actorId,
    });

    switch (outcome.kind) {
      case 'hold_expired':
        throw new GoneException(
          'That party hold has expired. Nothing was charged. Re-check availability and hold again.',
        );
      case 'no_longer_fits':
        // The re-plan is why this exists. Better a refusal now than a party
        // that arrives to find one of them has no professional.
        throw new ConflictException(
          `${outcome.reason} The party was not confirmed and nothing was charged.`,
        );
      case 'confirmed':
        break;
    }

    return {
      groupId: outcome.groupId,
      status: shout(outcome.status),
      bookings: outcome.bookings.map((b) => ({
        label: b.label,
        code: b.code,
        staffId: b.staffId,
        start: formatMinute(b.startMin),
        share: Money.fils(b.shareFils).toString(),
      })),
    };
  }
}

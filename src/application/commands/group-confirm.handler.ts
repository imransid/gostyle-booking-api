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
        `This group is already ${group.status}. Nothing was changed.`,
      );
    }

    // The branch column is a uuid and the catalogue speaks slugs, so the
    // trading day is the only thing read back from the row. The branch comes
    // from the caller, as it does everywhere else.
    const tradingDay = group.tradingDay.toISOString().slice(0, 10);
    const day = await this.context.loadDay('marina-walk', tradingDay);

    const resourceCounts: Record<string, number> = {};
    for (const r of day.resources) {
      resourceCounts[r.id] = Math.max(0, r.units - r.outOfService);
    }

    const items = await Promise.all(
      cmd.participants.map(async (p, i) => {
        const services = await this.context.loadServices(
          'marina-walk',
          p.serviceIds,
        );
        return {
          participantId: `p${i}`,
          label: p.label,
          serviceIds: p.serviceIds,
          priceFils: services.reduce((n, s) => n + priceOf(s.id), 0),
          skills: [...new Set(services.map((s) => s.skill))],
          durationMin: services.reduce((n, s) => n + s.durationMin, 0),
          resourceType: services[services.length - 1]!.resourceType,
          preferredStaffId: p.preferredStaffId,
        };
      }),
    );

    const outcome = await this.repo.confirm({
      groupId: cmd.groupId,
      holdId: cmd.holdId,
      branchId: 'marina-walk',
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

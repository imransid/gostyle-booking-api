import { Injectable } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { toUuid } from './hold.repository';
import type { WalkIn } from '@domain/booking/walk-in';

export interface JoinWalkInInput {
  readonly branchId: string;
  readonly tradingDay: string;
  readonly customerId: string | null;
  readonly guestName: string | null;
  readonly serviceIds: readonly string[];
  readonly durationMin: number;
  readonly joinedMin: number;
}

export interface WalkInRow {
  readonly walkIn: WalkIn;
  readonly customerId: string | null;
  readonly guestName: string | null;
}

@Injectable()
export class WalkInRepository {
  constructor(private readonly prisma: PrismaService) {}

  async join(
    input: JoinWalkInInput,
  ): Promise<{ id: string; position: number }> {
    const entry = await this.prisma.walkInEntry.create({
      data: {
        branchId: toUuid(input.branchId),
        tradingDay: new Date(`${input.tradingDay}T00:00:00Z`),
        customerId: input.customerId === null ? null : toUuid(input.customerId),
        guestName: input.guestName,
        // Packages are already expanded by the handler: the queue stores what
        // will actually be performed, so a quote never has to expand twice.
        serviceIds: [...input.serviceIds],
        durationMin: input.durationMin,
        joinedMin: input.joinedMin,
      },
      select: { id: true },
    });

    const ahead = await this.prisma.walkInEntry.count({
      where: {
        branchId: toUuid(input.branchId),
        tradingDay: new Date(`${input.tradingDay}T00:00:00Z`),
        status: 'waiting',
        joinedMin: { lt: input.joinedMin },
      },
    });

    return { id: entry.id, position: ahead + 1 };
  }

  /** Everyone still standing there, oldest first. */
  async waiting(branchId: string, tradingDay: string): Promise<WalkInRow[]> {
    const rows = await this.prisma.walkInEntry.findMany({
      where: {
        branchId: toUuid(branchId),
        tradingDay: new Date(`${tradingDay}T00:00:00Z`),
        status: 'waiting',
      },
      orderBy: [{ joinedMin: 'asc' }, { joinedAt: 'asc' }],
    });

    return rows.map((r) => ({
      walkIn: {
        id: r.id,
        label: r.guestName ?? 'Customer',
        serviceIds: r.serviceIds,
        durationMin: r.durationMin,
        joinedMin: r.joinedMin,
      },
      customerId: r.customerId,
      guestName: r.guestName,
    }));
  }

  async find(id: string): Promise<WalkInRow | null> {
    const r = await this.prisma.walkInEntry.findUnique({ where: { id } });
    if (r === null || r.status !== 'waiting') return null;
    return {
      walkIn: {
        id: r.id,
        label: r.guestName ?? 'Customer',
        serviceIds: r.serviceIds,
        durationMin: r.durationMin,
        joinedMin: r.joinedMin,
      },
      customerId: r.customerId,
      guestName: r.guestName,
    };
  }

  /** Seated into a real booking, through the ordinary confirm path. */
  /** Branch and day for an entry, so the handler can load its context. */
  async entryContext(
    id: string,
  ): Promise<{ branchId: string; tradingDay: string } | null> {
    const r = await this.prisma.walkInEntry.findUnique({
      where: { id },
      select: { branchId: true, tradingDay: true },
    });
    if (r === null) return null;
    return {
      branchId: r.branchId,
      tradingDay: r.tradingDay.toISOString().slice(0, 10),
    };
  }

  /** The desk took a hold on their behalf. Still waiting until it confirms. */
  async markHeld(id: string, holdId: string): Promise<void> {
    await this.prisma.walkInEntry.update({ where: { id }, data: { holdId } });
  }

  /**
   * The hold became a booking, so the person is in a chair.
   *
   * Matched on the hold rather than told directly, so the ordinary confirm
   * path stays ignorant of walk-ins. Returns false when this booking had
   * nothing to do with the queue, which is the common case.
   */
  async markSeatedByHold(holdId: string, bookingId: string): Promise<boolean> {
    const done = await this.prisma.walkInEntry.updateMany({
      where: { holdId, status: 'waiting' },
      data: { status: 'seated', bookingId, holdId: null },
    });
    return done.count > 0;
  }

  async markLeft(id: string): Promise<boolean> {
    const done = await this.prisma.walkInEntry.updateMany({
      where: { id, status: 'waiting' },
      data: { status: 'left' },
    });
    return done.count > 0;
  }
}

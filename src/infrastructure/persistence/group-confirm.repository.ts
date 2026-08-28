import type { GroupStatus } from '@domain/booking/group-status';
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { toUuid, branchInstant } from './hold.repository';
import { planParty, type PartyContext } from '@domain/availability/party';
import { Money } from '@domain/shared/money';

/** Named: a heredoc eats a line ending in `<`. */
interface HeldLane {
  staff_id: string;
  start_minute: number;
  duration_min: number;
  resource_type: string | null;
}

export interface GroupConfirmInput {
  readonly groupId: string;
  readonly holdId: string;
  readonly branchId: string;
  readonly tradingDay: string;
  /** Per participant, in position order. */
  readonly items: readonly {
    readonly participantId: string;
    readonly serviceIds: readonly string[];
    readonly priceFils: number;
    readonly skills: readonly string[];
    readonly durationMin: number;
    readonly resourceType: string;
    readonly preferredStaffId: string | null;
    readonly label: string;
  }[];
  readonly roster: {
    readonly professionals: readonly {
      readonly id: string;
      readonly name: string;
      readonly skills: readonly string[];
      readonly atCap: boolean;
    }[];
    readonly resourceCounts: Readonly<Record<string, number>>;
  };
  readonly actorId: string | null;
}

export type GroupConfirmOutcome =
  | {
      readonly kind: 'confirmed';
      readonly groupId: string;
      readonly status: GroupStatus;
      readonly bookings: readonly {
        readonly participantId: string;
        readonly label: string;
        readonly bookingId: string;
        readonly code: string;
        readonly staffId: string;
        readonly startMin: number;
        readonly shareFils: number;
      }[];
    }
  | { readonly kind: 'hold_expired' }
  /**
   * The party no longer fits.
   *
   * Between the hold and this moment a professional went off shift, a chair
   * was taken out of service, or someone else took a lane. Nothing is
   * charged and nothing is written.
   */
  | { readonly kind: 'no_longer_fits'; readonly reason: string };

@Injectable()
export class GroupConfirmRepository {
  private static readonly log = new Logger(GroupConfirmRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Turn a held party into N bookings, or nothing at all.
   *
   * THE RE-PLAN IS THE POINT. The hold protected these lanes ten minutes ago;
   * confirmation asks again, on fresh masks, whether the party still works.
   * A colourist who called in sick at 11:05 should make an 11:00 hold fail
   * here rather than confirm into a visit nobody can deliver.
   *
   * If it no longer holds, the transaction rolls back and nothing is charged.
   */
  async confirm(input: GroupConfirmInput): Promise<GroupConfirmOutcome> {
    const day = new Date(`${input.tradingDay}T00:00:00Z`);
    const branch = toUuid(input.branchId);

    return this.prisma.$transaction(async (tx) => {
      // 1. Lock the hold and prove it is alive.
      const alive = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM hold
         WHERE id = ${input.holdId}::uuid
           AND expires_at > now()
         FOR UPDATE`;
      if (alive.length === 0) return { kind: 'hold_expired' as const };

      // 2. The reservations ARE the truth about what was held. Reading the
      //    times from them rather than from the request means a stale client
      //    cannot confirm a different party than the one it holds.
      const held = await tx.$queryRaw<HeldLane[]>`
        SELECT sr.staff_id, sr.start_minute, sr.duration_min,
               (SELECT rr.resource_type FROM resource_reservation rr
                 WHERE rr.hold_id = sr.hold_id
                   AND rr.start_minute = sr.start_minute
                 LIMIT 1) AS resource_type
          FROM staff_reservation sr
         WHERE sr.hold_id = ${input.holdId}::uuid
         ORDER BY sr.start_minute, sr.staff_id`;

      if (held.length !== input.items.length) {
        return { kind: 'hold_expired' as const };
      }

      // 3. Lock the resource types, then RE-PLAN on fresh masks. The lanes
      //    this hold owns are excluded from the diary it plans against:
      //    a party must not be found infeasible because of itself.
      const types = [...new Set(input.items.map((i) => i.resourceType))].sort();
      for (const type of types) {
        const key = `${input.branchId}:${type}:${input.tradingDay}`;
        await tx.$executeRaw`
          SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
      }

      const ctx = await this.freshContext(
        tx,
        branch,
        day,
        input.holdId,
        input.roster,
      );

      const anchor = Math.min(...held.map((h) => h.start_minute));
      const replan = planParty(
        input.items.map((i) => ({
          id: i.participantId,
          label: i.label,
          skills: i.skills,
          durationMin: i.durationMin,
          resourceType: i.resourceType,
          preferredStaffId: i.preferredStaffId,
        })),
        anchor,
        // The held lanes already encode the mode, so the anchor plus the
        // per-lane starts is all that is needed: re-planning arrive-together
        // from the earliest start reproduces the same shape.
        held.every((h) => h.start_minute === anchor)
          ? 'arrive_together'
          : 'finish_together',
        ctx,
      );

      if (replan.kind === 'infeasible') {
        return { kind: 'no_longer_fits' as const, reason: replan.reason };
      }

      // 4. N bookings, one per participant. Each one is an ORDINARY booking,
      //    which is what gives every participant check-in, settlement,
      //    reschedule and the waitlist without a line of extra code.
      const participants = await tx.groupParticipant.findMany({
        where: { groupId: input.groupId },
        orderBy: { position: 'asc' },
      });

      const shares = this.sharesFor(
        input.items.map((i) => i.priceFils),
        await this.arrangementOf(tx, input.groupId),
      );

      const made: {
        participantId: string;
        label: string;
        bookingId: string;
        code: string;
        staffId: string;
        startMin: number;
        shareFils: number;
      }[] = [];

      for (const [i, lane] of replan.lanes.entries()) {
        // The same sequence a single booking uses. A group's participants get
        // ordinary booking codes because they ARE ordinary bookings: the desk
        // looks one up by code without caring whether it came from a party.
        const codeRows = await tx.$queryRaw<{ code: string }[]>`
          SELECT 'GS-' || nextval('booking_code_seq') AS code`;
        const code = codeRows[0]?.code;
        if (code === undefined)
          throw new Error('booking_code_seq returned nothing');

        const spec = input.items.find(
          (x) => x.participantId === lane.participantId,
        )!;
        const participant = participants[i]!;

        const booking = await tx.booking.create({
          data: {
            code,
            branchId: branch,
            customerId: participant.customerId ?? toUuid(input.groupId),
            groupId: input.groupId,
            status: 'confirmed',
            paymentStatus: 'none_required',
            tradingDay: day,
            startAt: branchInstant(input.tradingDay, lane.startMin),
            endAt: branchInstant(input.tradingDay, lane.endMin),
            startMinute: lane.startMin,
            durationMin: lane.endMin - lane.startMin,
            priceFils: spec.priceFils,
            depositFils: 0,
            channel: 'desk',
          },
          select: { id: true, code: true },
        });

        const item = await tx.bookingItem.create({
          data: {
            bookingId: booking.id,
            serviceId: toUuid(spec.serviceIds[0]!),
            serviceName: spec.label,
            resourceType: spec.resourceType,
            requiredSkill: spec.skills[0] ?? 'hair',
            priceFils: spec.priceFils,
            durationMin: spec.durationMin,
            position: 0,
            staffId: toUuid(lane.staffId),
          },
          select: { id: true },
        });

        // 5. Re-point the hold's reservations at this booking's item. Not
        //    recreated: the rows never leave the table, so the lane is
        //    protected continuously and there is no window to lose it in.
        await tx.staffReservation.updateMany({
          where: {
            holdId: input.holdId,
            staffId: toUuid(lane.staffId),
            startMinute: lane.startMin,
          },
          data: { holdId: null, bookingItemId: item.id },
        });
        await tx.resourceReservation.updateMany({
          where: { holdId: input.holdId, startMinute: lane.startMin },
          data: { holdId: null, bookingItemId: item.id },
        });

        await tx.groupParticipant.update({
          where: { id: participant.id },
          data: { bookingId: booking.id, shareFils: shares[i] ?? 0 },
        });

        made.push({
          participantId: lane.participantId,
          label: spec.label,
          bookingId: booking.id,
          code: booking.code,
          staffId: lane.staffId,
          startMin: lane.startMin,
          shareFils: shares[i] ?? 0,
        });
      }

      // 6. The group status is DERIVED, never set directly. Every lane was
      //    just confirmed, so the group is confirmed.
      await tx.bookingGroup.update({
        where: { id: input.groupId },
        data: { status: 'confirmed', activeCount: made.length },
      });

      await tx.eventOutbox.create({
        data: {
          aggregateType: 'group',
          aggregateId: input.groupId,
          eventType: 'group.confirmed',
          payload: {
            participants: made.length,
            codes: made.map((m) => m.code),
            tradingDay: input.tradingDay,
          },
        },
      });

      await tx.hold.delete({ where: { id: input.holdId } });

      GroupConfirmRepository.log.log(
        `Group ${input.groupId} confirmed: ${made.map((m) => m.code).join(', ')}`,
      );

      return {
        kind: 'confirmed' as const,
        groupId: input.groupId,
        status: 'confirmed',
        bookings: made,
      };
    });
  }

  /**
   * The day as it is NOW, minus this hold's own lanes.
   *
   * Excluding them matters: a party planning against a diary that already
   * contains its own reservations would find every professional busy and
   * refuse itself.
   */
  private async freshContext(
    tx: Parameters<Parameters<PrismaService['$transaction']>[0]>[0],
    branch: string,
    day: Date,
    holdId: string,
    roster: GroupConfirmInput['roster'],
  ): Promise<PartyContext> {
    const [staffRows, chairRows] = await Promise.all([
      tx.staffReservation.findMany({
        where: {
          blocking: true,
          branchId: branch,
          tradingDay: day,
          NOT: { holdId },
        },
        select: { staffId: true, startMinute: true, durationMin: true },
      }),
      tx.resourceReservation.findMany({
        where: {
          blocking: true,
          branchId: branch,
          tradingDay: day,
          NOT: { holdId },
        },
        select: { resourceType: true, startMinute: true, durationMin: true },
      }),
    ]);

    const busy = new Map<string, { fromMin: number; toMin: number }[]>();
    for (const r of staffRows) {
      const list = busy.get(r.staffId) ?? [];
      list.push({
        fromMin: r.startMinute,
        toMin: r.startMinute + r.durationMin,
      });
      busy.set(r.staffId, list);
    }

    return {
      professionals: roster.professionals.map((p) => ({
        ...p,
        busy: busy.get(toUuid(p.id)) ?? [],
      })),
      resourceCounts: roster.resourceCounts,
      occupied: chairRows.map((r) => ({
        resourceType: r.resourceType,
        fromMin: r.startMinute,
        toMin: r.startMinute + r.durationMin,
      })),
    };
  }

  private async arrangementOf(
    tx: Parameters<Parameters<PrismaService['$transaction']>[0]>[0],
    groupId: string,
  ): Promise<'organiser_pays_all' | 'split_equally' | 'each_pays_own'> {
    const g = await tx.bookingGroup.findUnique({
      where: { id: groupId },
      select: { arrangement: true },
    });
    return g?.arrangement ?? 'each_pays_own';
  }

  /**
   * What each participant owes.
   *
   * ORGANISER PAYS ALL puts the whole total on the first participant, who is
   * the organiser. SPLIT EQUALLY divides it with Money.allocate, so the
   * remainder lands on the earliest shares rather than vanishing: three
   * people splitting AED 100 pay 33.34, 33.33, 33.33, not three times 33.33
   * and a lost fil. EACH PAYS OWN is simply each participant's own total,
   * which is the cleanest isolation: one cancellation touches one person's
   * money.
   */
  private sharesFor(
    prices: readonly number[],
    arrangement: 'organiser_pays_all' | 'split_equally' | 'each_pays_own',
  ): number[] {
    const total = prices.reduce((n, p) => n + p, 0);

    switch (arrangement) {
      case 'organiser_pays_all':
        return prices.map((_, i) => (i === 0 ? total : 0));
      case 'split_equally':
        // Equal weights, so allocate splits evenly and puts the remainder on
        // the earliest shares rather than losing it. Three people splitting
        // AED 100 pay 33.34, 33.33, 33.33.
        return Money.fils(total)
          .allocate(prices.map(() => 1))
          .map((m) => m.fils);
      case 'each_pays_own':
        return [...prices];
    }
  }
}

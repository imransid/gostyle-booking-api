import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { toUuid, branchInstant } from './hold.repository';
import {
  planParty,
  type GroupMode,
  type PartyContext,
  type PartyParticipant,
  type PartyPlan,
} from '@domain/availability/party';

export interface GroupHoldInput {
  readonly branchId: string;
  readonly organiserId: string;
  readonly tradingDay: string;
  readonly targetMin: number;
  readonly mode: GroupMode;
  readonly arrangement:
    'organiser_pays_all' | 'split_equally' | 'each_pays_own';
  readonly participants: readonly {
    readonly participant: PartyParticipant;
    /** null for a named guest under the organiser. */
    readonly customerId: string | null;
    readonly guestName: string | null;
  }[];
  readonly ttlMs: number;
  /**
   * The roster and chair registry, resolved by the CALLER.
   *
   * The repository does not fetch this. A repository reaching into an
   * application port to answer a question about the world is the wrong
   * direction: it makes persistence depend on the layer above it, which is
   * exactly what the port was drawn to prevent. Nest refused to wire it, and
   * was right to.
   *
   * The handler already owns the booking context, so it resolves the roster
   * and hands it down. Persistence stays a thing that reads and writes rows.
   */
  readonly roster: {
    readonly professionals: readonly {
      readonly id: string;
      readonly name: string;
      readonly skills: readonly string[];
      readonly atCap: boolean;
    }[];
    readonly resourceCounts: Readonly<Record<string, number>>;
  };
}

export type GroupHoldOutcome =
  | {
      readonly kind: 'held';
      readonly groupId: string;
      readonly holdId: string;
      readonly expiresAt: Date;
      readonly lanes: readonly {
        readonly participantId: string;
        readonly staffId: string;
        readonly startMin: number;
        readonly endMin: number;
      }[];
    }
  | {
      readonly kind: 'infeasible';
      readonly reason: string;
      readonly remedy: string;
    }
  /** Somebody took a lane between the plan and the write. */
  | { readonly kind: 'raced' };

@Injectable()
export class GroupHoldRepository {
  private static readonly log = new Logger(GroupHoldRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Hold every lane of a party, or none of them.
   *
   * THE ALL-OR-NOTHING IS THE TRANSACTION, not error handling. If the fourth
   * lane loses a race to the exclusion constraint, the first three vanish
   * with it because they were never committed. There is no partial party to
   * detect and clean up, because a partial party never exists.
   *
   * That matters more here than for a single booking. A half-held group is
   * worse than no group: two people have chairs, two do not, and the salon
   * finds out when the party arrives.
   */
  async place(input: GroupHoldInput): Promise<GroupHoldOutcome> {
    const day = new Date(`${input.tradingDay}T00:00:00Z`);
    const expiresAt = new Date(Date.now() + input.ttlMs);
    const branch = toUuid(input.branchId);

    try {
      return await this.prisma.$transaction(async (tx) => {
        // 1. Lock every resource type the WHOLE party needs, in sorted order.
        //
        //    Locking per lane as the search assigned them would let two
        //    parties interleave: A takes the styling lock, B takes the colour
        //    lock, and each waits for the other. Same reason the single hold
        //    sorts its types, but with more ways to get it wrong.
        const types = [
          ...new Set(input.participants.map((p) => p.participant.resourceType)),
        ].sort();
        for (const type of types) {
          const key = `${input.branchId}:${type}:${input.tradingDay}`;
          await tx.$executeRaw`
            SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
        }

        // 2. Plan under the lock, so the diary cannot move underneath it.
        const ctx = await this.contextFor(tx, branch, day, input.roster);
        const plan: PartyPlan = planParty(
          input.participants.map((p) => p.participant),
          input.targetMin,
          input.mode,
          ctx,
        );

        if (plan.kind === 'infeasible') {
          return {
            kind: 'infeasible' as const,
            reason: plan.reason,
            remedy: plan.remedy,
          };
        }

        // 3. The group, the hold, and every lane. One hold covers the party:
        //    releasing it releases everybody, and no lane can outlive the
        //    others.
        const group = await tx.bookingGroup.create({
          data: {
            branchId: branch,
            organiserId: toUuid(input.organiserId),
            tradingDay: day,
            targetMin: input.targetMin,
            mode: input.mode,
            arrangement: input.arrangement,
            status: 'draft',
          },
          select: { id: true },
        });

        const hold = await tx.hold.create({
          data: {
            branchId: branch,
            customerId: toUuid(input.organiserId),
            tradingDay: day,
            feasibilityToken: `group:${group.id}`,
            expiresAt,
          },
          select: { id: true, expiresAt: true },
        });

        for (const [i, lane] of plan.lanes.entries()) {
          const spec = input.participants.find(
            (p) => p.participant.id === lane.participantId,
          )!;

          await tx.groupParticipant.create({
            data: {
              groupId: group.id,
              customerId:
                spec.customerId === null ? null : toUuid(spec.customerId),
              guestName: spec.guestName,
              shareFils: null,
              position: i,
            },
          });

          // THE EXCLUSION CONSTRAINT DECIDES HERE, once per lane. Any refusal
          // throws, and the whole party goes with it.
          await tx.staffReservation.create({
            data: {
              holdId: hold.id,
              branchId: branch,
              staffId: toUuid(lane.staffId),
              tradingDay: day,
              kind: 'active',
              startAt: branchInstant(input.tradingDay, lane.startMin),
              endAt: branchInstant(input.tradingDay, lane.endMin),
              startMinute: lane.startMin,
              durationMin: lane.endMin - lane.startMin,
              claimPreMin: 0,
              claimPostMin: 0,
            },
          });

          await tx.resourceReservation.create({
            data: {
              holdId: hold.id,
              branchId: branch,
              resourceType: lane.resourceType,
              tradingDay: day,
              startAt: branchInstant(input.tradingDay, lane.startMin),
              endAt: branchInstant(input.tradingDay, lane.endMin),
              startMinute: lane.startMin,
              durationMin: lane.endMin - lane.startMin,
            },
          });
        }

        GroupHoldRepository.log.log(
          `Group ${group.id} held: ${plan.lanes.length} lanes, ${input.mode}`,
        );

        return {
          kind: 'held' as const,
          groupId: group.id,
          holdId: hold.id,
          expiresAt: hold.expiresAt,
          lanes: plan.lanes.map((l) => ({
            participantId: l.participantId,
            staffId: l.staffId,
            startMin: l.startMin,
            endMin: l.endMin,
          })),
        };
      });
    } catch (e) {
      // The exclusion constraint, or a chair count that moved. Either way the
      // party did not fit and nothing was written.
      GroupHoldRepository.log.warn(
        `Group hold raced: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`,
      );
      return { kind: 'raced' };
    }
  }

  /** The day as the planner needs it: who is free, and which chairs are taken. */
  private async contextFor(
    tx: Parameters<Parameters<PrismaService['$transaction']>[0]>[0],
    branch: string,
    day: Date,
    roster: GroupHoldInput['roster'],
  ): Promise<PartyContext> {
    const [staffRows, chairRows] = await Promise.all([
      tx.staffReservation.findMany({
        where: { blocking: true, branchId: branch, tradingDay: day },
        select: { staffId: true, startMinute: true, durationMin: true },
      }),
      tx.resourceReservation.findMany({
        where: { blocking: true, branchId: branch, tradingDay: day },
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

    // The roster and the chair registry still come from the fixture: they
    // live in other services and the gRPC clients do not exist yet.

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
}

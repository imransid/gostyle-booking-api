import {
  shout,
  toWireGate,
  type Shouted,
  type WireGate,
} from '@application/contract/wire';
import type { ItemState } from '@domain/booking/roster-change';
import type { DisruptionRung } from '@domain/availability/disruption-ladder';
import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  BOOKING_CONTEXT,
  type BookingContextReader,
} from '@application/ports/booking-context.port';
import {
  RosterChangeRepository,
  type AffectedBooking,
} from '@infrastructure/persistence/roster-change.repository';
import { HoldRepository } from '@infrastructure/persistence/hold.repository';
import { RescheduleRepository } from '@infrastructure/persistence/reschedule.repository';
import { LifecycleRepository } from '@infrastructure/persistence/lifecycle.repository';
import { WaitlistRepository } from '@infrastructure/persistence/waitlist.repository';
import {
  repairDisruption,
  type DisruptionOutcome,
} from '@domain/availability/disruption-ladder';
import type { RepairCandidate } from '@domain/availability/repair';
import type { ActorKind } from '@domain/booking/lifecycle';
import {
  gateFor,
  stateAfter,
  type RosterChangeKind,
  type Resolution,
} from '@domain/booking/roster-change';
import {
  feasibleSet,
  staffAvailableAt,
  DESK_CHANNEL,
  WHOLE_DAY,
} from '@domain/availability/feasible';
import { toSlots } from '@domain/availability/mask';
import {
  toMin,
  DAILY_BOOKING_CAP,
  formatMinute,
} from '@domain/availability/grid';

export interface OpenRosterChangeCommand {
  readonly branchId: string;
  readonly tradingDay: string;
  readonly kind: RosterChangeKind;
  readonly staffId: string | null;
  readonly resourceType: string | null;
  readonly reason: string;
  readonly actorId: string | null;
}

export interface WireProposal {
  readonly refundMinor: number;
  readonly goodwillMinor: number;
  readonly waitlistWindow?: unknown;
  readonly explanation?: string;
}

export interface RosterChangeDetailView {
  readonly changeId: string;
  readonly branchId: string;
  readonly tradingDay: string;
  readonly kind: Shouted<RosterChangeKind>;
  readonly staffId: string | null;
  readonly resourceType: string | null;
  readonly reason: string;
  readonly committedAt: string | null;
  readonly gate: WireGate;
  readonly items: readonly {
    readonly id: string;
    readonly bookingCode: string;
    readonly state: Shouted<ItemState>;
    readonly rung: Shouted<DisruptionRung> | null;
    readonly proposal: WireProposal | null;
  }[];
}

/**
 * The stored proposal, renamed for the wire.
 *
 * It is JSONB, so nothing type-checks it on the way out — which is exactly
 * why it kept its refundFils/goodwillFils keys while every sibling field on
 * the POST response had already become *Minor.
 */
function toWireProposal(raw: unknown): WireProposal | null {
  if (raw === null || typeof raw !== 'object') return null;
  const p = raw as Record<string, unknown>;
  const { refundFils, goodwillFils, ...rest } = p;
  return {
    ...rest,
    refundMinor: typeof refundFils === 'number' ? refundFils : 0,
    goodwillMinor: typeof goodwillFils === 'number' ? goodwillFils : 0,
  };
}

export interface RosterChangeView {
  readonly changeId: string;
  readonly gate: WireGate;
  readonly affected: number;
  readonly autoRepaired: readonly {
    readonly code: string;
    readonly rung: Shouted<DisruptionRung>;
    readonly explanation: string;
  }[];
  readonly needsDecision: readonly {
    readonly code: string;
    readonly explanation: string;
    readonly refundMinor: number;
    readonly goodwillMinor: number;
  }[];
}

/** How long the repair holds the replacement slot while it moves the booking. */
const REPAIR_HOLD_TTL_MS = 60_000;

/**
 * A roster edit, the bookings it disturbs, and the ladder that repairs them.
 *
 * THE SCAN AND THE REPAIR HAPPEN TOGETHER, on purpose. A worklist of nine
 * items where six are trivially fixable is nine decisions somebody has to
 * read; the same worklist after the ladder has run is three. The gate is
 * about the ones that genuinely need a person.
 */
@Injectable()
export class RosterChangeHandler {
  private static readonly log = new Logger(RosterChangeHandler.name);

  constructor(
    private readonly repo: RosterChangeRepository,
    private readonly holds: HoldRepository,
    private readonly reschedules: RescheduleRepository,
    private readonly lifecycle: LifecycleRepository,
    private readonly waitlist: WaitlistRepository,
    @Inject(BOOKING_CONTEXT) private readonly context: BookingContextReader,
  ) {}

  async open(cmd: OpenRosterChangeCommand): Promise<RosterChangeView> {
    const changeId = await this.repo.open(cmd);
    const affected = await this.repo.affected(cmd);
    await this.repo.addItems(changeId, affected);

    const autoRepaired: {
      code: string;
      rung: Shouted<DisruptionRung>;
      explanation: string;
    }[] = [];
    const needsDecision: {
      code: string;
      explanation: string;
      refundMinor: number;
      goodwillMinor: number;
    }[] = [];

    for (const booking of affected) {
      const outcome = await this.repair(changeId, cmd, booking);
      if (outcome.kind === 'repaired') {
        autoRepaired.push({
          code: booking.code,
          rung: shout(outcome.rung),
          explanation: outcome.explanation,
        });
      } else {
        needsDecision.push({
          code: booking.code,
          explanation: outcome.explanation,
          refundMinor: outcome.refundFils,
          goodwillMinor: outcome.goodwillFils,
        });
      }
    }

    const gate = gateFor(await this.repo.worklist(changeId));

    RosterChangeHandler.log.log(
      `Roster change ${changeId}: ${affected.length} affected, ` +
        `${autoRepaired.length} auto-repaired, gate ${gate.status}`,
    );

    return {
      changeId,
      gate: toWireGate(gate),
      affected: affected.length,
      autoRepaired,
      needsDecision,
    };
  }

  /** Run the ladder over one booking and apply whatever it chose. */
  private async repair(
    changeId: string,
    cmd: OpenRosterChangeCommand,
    booking: AffectedBooking,
  ): Promise<DisruptionOutcome> {
    const candidates = await this.candidatesFor(cmd, booking);
    const chairUnits = await this.effectiveUnits(cmd, booking.resourceType);
    const outcome = repairDisruption({
      booking: {
        bookingId: booking.bookingId,
        code: booking.code,
        startMin: booking.startMin,
        durationMin: booking.durationMin,
        staffId: booking.staffId,
        priceFils: booking.priceFils,
        capturedFils: booking.capturedFils,
      },
      candidates,
    });

    if (outcome.kind === 'propose_cancellation') {
      await this.repo.proposeCancellation(changeId, booking.bookingId, {
        refundFils: outcome.refundFils,
        goodwillFils: outcome.goodwillFils,
        waitlistWindow: outcome.waitlistWindow,
        explanation: outcome.explanation,
      });
      return outcome;
    }

    // A repair is a MOVE, through the same hold-then-reschedule path a desk
    // uses. Writing the booking directly would be a second way to move one,
    // and the second way is the one that forgets the ledger and the history.
    const held = await this.holds.place({
      branchId: cmd.branchId,
      customerId: booking.customerId,
      tradingDay: cmd.tradingDay,
      staffId: outcome.offer.staffId,
      startMin: outcome.offer.startMin,
      durationMin: booking.durationMin,
      claimPreMin: booking.claimPreMin,
      claimPostMin: booking.claimPostMin,
      resourceDemand: [
        {
          resourceType: booking.resourceType,
          startMin: outcome.offer.startMin,
          endMin: outcome.offer.startMin + booking.durationMin,
          // units is the branch's EFFECTIVE CAPACITY for this chair type,
          // not how many this booking wants. Passing 1 told the hold there
          // was a single styling chair, so a branch with three refused every
          // repair as "no chair" -- and the ladder reported it as a lost race.
          units: chairUnits,
        },
      ],
      feasibilityToken: `repair:${changeId}`,
      ttlMs: REPAIR_HOLD_TTL_MS,
    });

    if (held.kind !== 'held') {
      // The replacement slot went between the plan and the hold. Leave the
      // item open: a human sees it rather than the ladder quietly settling
      // for something it did not actually secure.
      RosterChangeHandler.log.warn(
        `${booking.code}: ${outcome.rung} lost the slot (${held.kind}); left for a human`,
      );
      return {
        kind: 'propose_cancellation',
        rung: 'salon_cancellation',
        refundFils: booking.capturedFils,
        goodwillFils: 0,
        waitlistWindow: {
          fromMin: booking.startMin,
          toMin: booking.startMin + booking.durationMin,
        },
        explanation:
          `The replacement slot at ${formatMinute(outcome.offer.startMin)} was ` +
          'taken before the move completed. Needs a decision.',
        customerImpact: 'Unknown until somebody looks.',
      };
    }

    const moved = await this.reschedules.move({
      bookingId: booking.bookingId,
      holdId: held.holdId,
      tradingDay: cmd.tradingDay,
      reason: `${cmd.reason} (${outcome.rung})`,
      actor: 'system',
      actorId: cmd.actorId,
    });

    if (moved.kind !== 'moved') {
      RosterChangeHandler.log.warn(
        `${booking.code}: move refused (${moved.kind}); left for a human`,
      );
      return {
        kind: 'propose_cancellation',
        rung: 'salon_cancellation',
        refundFils: booking.capturedFils,
        goodwillFils: 0,
        waitlistWindow: {
          fromMin: booking.startMin,
          toMin: booking.startMin + booking.durationMin,
        },
        explanation: `The move was refused (${moved.kind}). Needs a decision.`,
        customerImpact: 'Unknown until somebody looks.',
      };
    }

    await this.repo.markAutoRepaired(changeId, booking.bookingId, outcome.rung);
    return outcome;
  }

  /**
   * Feasible starts for this booking, WITHOUT the professional going off.
   *
   * Excluded here rather than in the ladder because the ladder should never
   * have to know why somebody is unavailable, only that they are.
   */
  private async candidatesFor(
    cmd: OpenRosterChangeCommand,
    booking: AffectedBooking,
  ): Promise<RepairCandidate[]> {
    const day = await this.context.loadDay(cmd.branchId, cmd.tradingDay);
    if (day.closureReason !== undefined) return [];

    // A closure sweep removes everybody; a shift conflict removes one person;
    // a chair going out of service removes neither, only capacity.
    const departing = new Set<string>(
      cmd.kind === 'closure_sweep'
        ? day.professionals.map((p) => p.id)
        : booking.staffId === ''
          ? []
          : [booking.staffId],
    );

    const professionals = day.professionals.filter((p) => !departing.has(p.id));
    if (professionals.length === 0) return [];

    const services = await this.context.loadCatalogue(cmd.branchId);
    const service =
      services.find((s) => s.durationMin === booking.durationMin) ??
      services[0];
    if (service === undefined) return [];

    const result = feasibleSet({
      services: [service],
      professionals,
      staffBookings: day.staffBookings,
      resources: day.resources,
      occupations: day.occupations,
      channel: DESK_CHANNEL,
      window: WHOLE_DAY,
      preferredStaffId: null,
      isToday: false,
      nowMin: 0,
      dailyCap: DAILY_BOOKING_CAP,
    });

    const candidates: RepairCandidate[] = [];
    for (const slot of toSlots(result.union)) {
      const startMin = toMin(slot);
      for (const staffId of staffAvailableAt(result, slot)) {
        if (departing.has(staffId)) continue;
        candidates.push({ startMin, staffId, durationMin: result.durationMin });
      }
    }
    return candidates;
  }

  /** Chairs of this type the branch can actually use today. */
  private async effectiveUnits(
    cmd: OpenRosterChangeCommand,
    resourceType: string,
  ): Promise<number> {
    const day = await this.context.loadDay(cmd.branchId, cmd.tradingDay);
    const resource = day.resources.find((r) => r.id === resourceType);
    if (resource === undefined) return 0;
    // A unit out of service is not capacity, exactly as the group planner
    // treats it.
    return Math.max(0, resource.units - resource.outOfService);
  }

  async view(changeId: string): Promise<RosterChangeDetailView> {
    const change = await this.repo.detail(changeId);
    if (change === null) throw new NotFoundException('No such roster change');
    const gate = gateFor(await this.repo.worklist(changeId));

    // The repository row is the DIARY'S vocabulary, not the front end's.
    // Returning it whole is how change.kind, item.state, item.rung and the
    // proposal's *Fils keys all reached the wire untranslated.
    return {
      changeId: change.id,
      branchId: change.branchId,
      tradingDay: change.tradingDay,
      kind: shout(change.kind),
      staffId: change.staffId,
      resourceType: change.resourceType,
      reason: change.reason,
      committedAt:
        change.committedAt === null ? null : change.committedAt.toISOString(),
      gate: toWireGate(gate),
      items: change.items.map((i) => ({
        id: i.id,
        bookingCode: i.bookingCode,
        state: shout(i.state),
        rung: i.rung === null ? null : shout(i.rung as DisruptionRung),
        proposal: toWireProposal(i.proposal),
      })),
    };
  }

  async resolve(
    changeId: string,
    itemId: string,
    resolution: Resolution,
    actor: { kind: ActorKind; id: string | null },
  ): Promise<WireGate> {
    const item = await this.repo.openItem(itemId);
    if (item === null || item.changeId !== changeId) {
      throw new NotFoundException('That item is not open, or does not exist');
    }

    // ACCEPTING THE PROPOSAL IS WHAT APPLIES IT.
    //
    // Until this point the cancellation was prepared and nothing had
    // happened to the customer. Marking the item settled without carrying it
    // out would clear the gate on a promise nobody kept, which is worse than
    // never having proposed it.
    if (resolution === 'accept_cancellation') {
      await this.applyCancellation(item, actor);
    }

    const ok = await this.repo.resolveItem(
      itemId,
      stateAfter(resolution),
      resolution === 'accept_cancellation' ? 'salon_cancellation' : null,
    );
    if (!ok) {
      throw new NotFoundException('That item is not open, or does not exist');
    }
    return toWireGate(gateFor(await this.repo.worklist(changeId)));
  }

  /**
   * Cancel, refund, credit, and put the customer at the front of the queue.
   *
   * The cancellation goes through the ordinary lifecycle transition with
   * initiatedBy: 'salon', so the unconditional full refund comes from the
   * one place that decides cancellation money. A second refund rule here
   * would be a second answer to "what is owed".
   */
  private async applyCancellation(
    item: {
      bookingId: string;
      bookingCode: string;
      proposal: {
        refundFils: number;
        goodwillFils: number;
        waitlistWindow: { fromMin: number; toMin: number };
      } | null;
    },
    actor: { kind: ActorKind; id: string | null },
  ): Promise<void> {
    // THE PERSON WHO ACCEPTED IT IS THE ONE WHO CANCELS.
    //
    // Not 'system'. The lifecycle refuses a system actor here and is right
    // to: cancelling a paying customer is a decision, and the audit trail
    // should name whoever made it rather than the job that proposed it.
    const cancelled = await this.lifecycle.transition({
      bookingId: item.bookingId,
      to: 'cancelled',
      actor: actor.kind,
      actorId: actor.id,
      reason: 'salon cancellation: roster change',
      initiatedBy: 'salon',
    });

    if (cancelled.kind !== 'transitioned') {
      RosterChangeHandler.log.warn(
        `${item.bookingCode}: cancellation refused (${cancelled.kind})`,
      );
      return;
    }

    if (item.proposal === null) return;

    await this.repo.postGoodwill(item.bookingId, item.proposal.goodwillFils);

    // Front of the queue for the window they originally asked for.
    const facts = await this.repo.bookingFacts(item.bookingId);
    if (facts !== null && facts.serviceId !== '') {
      await this.waitlist.join({
        branchId: facts.branchId,
        customerId: facts.customerId,
        serviceId: facts.serviceId,
        tradingDay: facts.tradingDay,
        windowFromMin: item.proposal.waitlistWindow.fromMin,
        windowToMin: item.proposal.waitlistWindow.toMin,
        preferredStaffId: null,
      });
    }

    RosterChangeHandler.log.log(
      `${item.bookingCode}: cancelled, refunded, ` +
        `${item.proposal.goodwillFils} fils goodwill, waitlisted`,
    );
  }

  /**
   * The roster service asks this before it commits.
   *
   * The answer is computed, and the database refuses the write anyway if the
   * caller ignores it. Two layers, and only the second one is a guarantee.
   */
  async commit(
    changeId: string,
  ): Promise<{ committed: boolean; gate: WireGate; message: string }> {
    const gate = gateFor(await this.repo.worklist(changeId));
    const outcome = await this.repo.commit(changeId);

    return {
      committed: outcome.ok,
      gate: toWireGate(gate),
      message: outcome.ok
        ? 'Committed. The roster edit may proceed.'
        : outcome.message,
    };
  }
}

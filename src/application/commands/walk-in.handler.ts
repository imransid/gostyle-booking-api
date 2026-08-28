import {
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  BOOKING_CONTEXT,
  type BookingContextReader,
} from '@application/ports/booking-context.port';
import { WalkInRepository } from '@infrastructure/persistence/walk-in.repository';
import { HoldRepository } from '@infrastructure/persistence/hold.repository';
import {
  queue,
  type NearestOption,
  type QueueRow,
  type WalkInCandidate,
} from '@domain/booking/walk-in';
import { resolveSelection } from '@domain/booking/package';
import { PACKAGES } from '@infrastructure/fixtures/fixture-booking-context';
import { priceOf } from './confirm-booking.handler';
import {
  feasibleSet,
  staffAvailableAt,
  DESK_CHANNEL,
  WHOLE_DAY,
} from '@domain/availability/feasible';
import { toSlots } from '@domain/availability/mask';
import { toMin, DAILY_BOOKING_CAP } from '@domain/availability/grid';

export interface JoinWalkInCommand {
  readonly branchId: string;
  readonly tradingDay: string;
  readonly customerId: string | null;
  readonly guestName: string | null;
  /** May contain package ids. They are expanded before anything is stored. */
  readonly serviceIds: readonly string[];
  readonly joinedMin: number;
}

export interface WalkInQueueView {
  readonly branchId: string;
  readonly tradingDay: string;
  readonly nowMin: number;
  readonly rows: readonly {
    readonly id: string;
    readonly position: number;
    readonly label: string;
    readonly serviceIds: readonly string[];
    readonly waitingMin: number;
    readonly options: readonly NearestOption[];
    readonly explanation: string;
  }[];
}

const WALK_IN_HOLD_TTL_MS = 5 * 60 * 1000;

/**
 * The walk-in queue.
 *
 * A walk-in is a booking created against real gaps, in the same engine, with
 * the same holds. Seating one places an ordinary hold, which the desk then
 * confirms through the ordinary confirm endpoint: there is no walk-in
 * booking path, because a second path is a second set of rules to keep in
 * step with the first.
 */
@Injectable()
export class WalkInHandler {
  constructor(
    private readonly repo: WalkInRepository,
    private readonly holds: HoldRepository,
    @Inject(BOOKING_CONTEXT) private readonly context: BookingContextReader,
  ) {}

  async join(
    cmd: JoinWalkInCommand,
  ): Promise<{ id: string; position: number; serviceIds: readonly string[] }> {
    // Packages expand HERE, once, so the queue stores what will actually be
    // performed and every later quote sees plain services.
    const selection = resolveSelection(cmd.serviceIds, PACKAGES, priceOf);

    const services = await this.context.loadServices(
      cmd.branchId,
      selection.serviceIds,
    );
    if (services.length !== selection.serviceIds.length) {
      throw new UnprocessableEntityException(
        'One or more services do not exist.',
      );
    }

    const durationMin = services.reduce((n, s) => n + s.durationMin, 0);

    const joined = await this.repo.join({
      branchId: cmd.branchId,
      tradingDay: cmd.tradingDay,
      customerId: cmd.customerId,
      guestName: cmd.guestName,
      serviceIds: selection.serviceIds,
      durationMin,
      joinedMin: cmd.joinedMin,
    });

    return { ...joined, serviceIds: selection.serviceIds };
  }

  /**
   * The queue with a live quote per person.
   *
   * The engine is asked once per DISTINCT SERVICE SET rather than once per
   * person, because a waiting room of six people wanting a blow-dry is one
   * question, not six.
   */
  async view(
    branchId: string,
    tradingDay: string,
    nowMin: number,
  ): Promise<WalkInQueueView> {
    const rows = await this.repo.waiting(branchId, tradingDay);
    const day = await this.context.loadDay(branchId, tradingDay);

    const cache = new Map<string, WalkInCandidate[]>();

    const candidatesFor = (
      serviceIds: readonly string[],
    ): WalkInCandidate[] => {
      const key = serviceIds.join('+');
      const hit = cache.get(key);
      if (hit !== undefined) return hit;
      return [];
    };

    // Warm the cache: one feasibility run per distinct set.
    if (day.closureReason === undefined) {
      const sets = new Map<string, readonly string[]>();
      for (const r of rows)
        sets.set(r.walkIn.serviceIds.join('+'), r.walkIn.serviceIds);

      for (const [key, ids] of sets) {
        const services = await this.context.loadServices(branchId, ids);
        if (services.length !== ids.length) {
          cache.set(key, []);
          continue;
        }
        const result = feasibleSet({
          services,
          professionals: day.professionals,
          staffBookings: day.staffBookings,
          resources: day.resources,
          occupations: day.occupations,
          channel: DESK_CHANNEL,
          window: WHOLE_DAY,
          preferredStaffId: null,
          isToday: true,
          nowMin,
          dailyCap: DAILY_BOOKING_CAP,
        });

        const found: WalkInCandidate[] = [];
        for (const slot of toSlots(result.union)) {
          const startMin = toMin(slot);
          for (const staffId of staffAvailableAt(result, slot)) {
            found.push({
              startMin,
              staffId,
              staffName:
                day.professionals.find((p) => p.id === staffId)?.name ??
                staffId,
            });
          }
        }
        cache.set(key, found);
      }
    }

    const built: QueueRow[] = queue(
      rows.map((r) => r.walkIn),
      nowMin,
      (walkIn) => candidatesFor(walkIn.serviceIds),
    );

    return {
      branchId,
      tradingDay,
      nowMin,
      rows: built.map((r) => ({
        id: r.walkIn.id,
        position: r.position,
        label: r.walkIn.label,
        serviceIds: r.walkIn.serviceIds,
        waitingMin: r.waitingMin,
        options: r.options,
        explanation: r.explanation,
      })),
    };
  }

  /**
   * Seat a walk-in: place an ordinary hold on the chosen start.
   *
   * The hold is where this path ENDS. Confirming it is the ordinary confirm
   * endpoint, because a walk-in that is confirmed differently is a walk-in
   * whose deposit rules, quote and audit trail drift from everybody else's.
   */
  async seat(
    walkInId: string,
    startMin: number,
    staffId: string,
  ): Promise<{
    readonly holdId: string;
    readonly expiresAt: string;
    readonly serviceIds: readonly string[];
    readonly startMin: number;
    readonly staffId: string;
  }> {
    const row = await this.repo.find(walkInId);
    if (row === null) {
      throw new NotFoundException('That walk-in is not waiting.');
    }

    const entry = await this.repo.entryContext(walkInId);
    if (entry === null)
      throw new NotFoundException('That walk-in is not waiting.');

    const services = await this.context.loadServices(
      entry.branchId,
      row.walkIn.serviceIds,
    );
    const day = await this.context.loadDay(entry.branchId, entry.tradingDay);
    const last = services[services.length - 1];
    if (last === undefined) {
      throw new UnprocessableEntityException('That walk-in wants nothing.');
    }
    const resource = day.resources.find((r) => r.id === last.resourceType);
    const units =
      resource === undefined
        ? 0
        : Math.max(0, resource.units - resource.outOfService);

    const held = await this.holds.place({
      branchId: entry.branchId,
      customerId: row.customerId,
      tradingDay: entry.tradingDay,
      staffId,
      startMin,
      durationMin: row.walkIn.durationMin,
      claimPreMin: last.claims.preMin,
      claimPostMin: last.claims.postMin,
      resourceDemand: [
        {
          resourceType: last.resourceType,
          startMin,
          endMin: startMin + row.walkIn.durationMin,
          units,
        },
      ],
      feasibilityToken: `walk-in:${walkInId}`,
      ttlMs: WALK_IN_HOLD_TTL_MS,
    });

    if (held.kind !== 'held') {
      throw new UnprocessableEntityException(
        `That slot went while you were seating them (${held.kind}). Refresh the queue.`,
      );
    }

    // Remembered, not marked seated: they are not in a chair until the
    // booking exists, and a hold can still lapse.
    await this.repo.markHeld(walkInId, held.holdId);

    return {
      holdId: held.holdId,
      expiresAt: held.expiresAt.toISOString(),
      serviceIds: row.walkIn.serviceIds,
      startMin,
      staffId,
    };
  }

  async leave(walkInId: string): Promise<{ left: boolean }> {
    return { left: await this.repo.markLeft(walkInId) };
  }
}

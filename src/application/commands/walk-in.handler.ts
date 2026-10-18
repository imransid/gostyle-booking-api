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
import {
  CUSTOMER_CONTEXT,
  type CustomerContextReader,
} from '@application/ports/customer-context.port';
import { WalkInRepository } from '@infrastructure/persistence/walk-in.repository';
import { HoldRepository } from '@infrastructure/persistence/hold.repository';
import {
  queue,
  type NearestOption,
  type QueueRow,
  type WalkInCandidate,
} from '@domain/booking/walk-in';
import { toWireNearestOption } from '@application/contract/wire';
import { PlatformPackageCatalogue } from '@infrastructure/persistence/platform-package-catalogue';
import { resolveBasket } from './basket';
import { resourceDemandFor } from './place-hold.handler';
import { SlugIndex } from '@infrastructure/persistence/slug-uuid';
import { DEFAULT_BRANCH_ID } from '@infrastructure/tenancy/branch-context';

/**
 * Every branch slug that exists, so a stored branch id reads back as the
 * branch it was written for (CLAUDE.md 8). A platform uuid passes through.
 */
const BRANCHES = new SlugIndex([DEFAULT_BRANCH_ID]);
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
    /** What to print on the queue board. Never null. */
    readonly label: string;
    /**
     * WHO THEY ARE, when they are somebody.
     *
     * The row published `label: "Customer"` for every registered walk-in and
     * carried no id at all, so a queue seated by a receptionist who had
     * already identified the customer rendered as a row of anonymous
     * "Customer" entries with nothing to look up. The column has held this
     * since the entry was written.
     */
    readonly customerId: string | null;
    /** Set instead of `customerId` for somebody who just walked in. */
    readonly guestName: string | null;
    readonly serviceIds: readonly string[];
    readonly waitingMin: number;
    readonly options: readonly ReturnType<
      typeof toWireNearestOption<NearestOption>
    >[];
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
    /** Only to put a name on the board. See `view`. */

    @Inject(CUSTOMER_CONTEXT)
    private readonly customers: CustomerContextReader,
    private readonly packageCatalogue: PlatformPackageCatalogue,
  ) {}

  async join(
    cmd: JoinWalkInCommand,
  ): Promise<{ id: string; position: number; serviceIds: readonly string[] }> {
    // EXACTLY ONE IDENTITY, checked here rather than by the CHECK.
    //
    // walk_in_is_customer_or_guest (num_nonnulls = 1) is the backstop, not
    // the first line of defence. Reaching it turns a caller mistake into
    // `500 Internal server error` with the reason only in the log -- which
    // is how this endpoint failed for every customer token, since a customer
    // client sends neither field and had no way to send one.
    const named = [cmd.customerId, cmd.guestName].filter((v) => v !== null);
    if (named.length !== 1) {
      throw new UnprocessableEntityException(
        named.length === 0
          ? 'Say who is waiting: a customerId for a registered customer, or a guestName.'
          : 'Send customerId or guestName, not both: two identities for one person at the desk.',
      );
    }

    // THE QUEUE KEEPS WHAT WAS ASKED FOR, a package included, and expands it
    // whenever it is read (basket.ts). It stored the expansion, so the seat
    // handed the desk the parts, the desk confirmed the parts, and the
    // package price was gone before the booking existed: AED 651 for a
    // package sold at AED 588. The answer still lists the parts, as it did.
    const basket = await resolveBasket(
      this.context,
      this.packageCatalogue,
      cmd.branchId,
      cmd.serviceIds,
    );
    if (basket.missing.length > 0) {
      throw new UnprocessableEntityException(
        'One or more services do not exist.',
      );
    }

    const durationMin = basket.services.reduce((n, s) => n + s.durationMin, 0);

    const joined = await this.repo.join({
      branchId: cmd.branchId,
      tradingDay: cmd.tradingDay,
      customerId: cmd.customerId,
      guestName: cmd.guestName,
      serviceIds: cmd.serviceIds,
      durationMin,
      joinedMin: cmd.joinedMin,
    });

    return { ...joined, serviceIds: basket.serviceIds };
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
        // A queued package expands here, as it does everywhere else.
        const basket = await resolveBasket(
          this.context,
          this.packageCatalogue,
          branchId,
          ids,
        );
        if (basket.missing.length > 0) {
          cache.set(key, []);
          continue;
        }
        const services = basket.services;
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

    // The queue is ordered by the domain, so the identity is matched back by
    // id rather than by position -- a reorder here would silently attach the
    // wrong name to the wrong person.
    const identity = new Map(rows.map((r) => [r.walkIn.id, r]));

    /**
     * A REGISTERED WALK-IN GETS THEIR NAME, not the word "Customer".
     *
     * `label` fell back to that string for anybody joined with a customerId
     * rather than a guestName, so a queue of identified customers rendered
     * as a column of identical rows. The guest-name path already worked.
     * Null names stay "Customer", which is honest rather than blank.
     */
    const named = new Map<string, string>();
    await Promise.all(
      [...new Set(rows.map((r) => r.customerId).filter((x) => x !== null))].map(
        async (id) => {
          try {
            const name = (await this.customers.load(id)).name;
            if (name !== null) named.set(id, name);
          } catch {
            // Decoration. A directory that blinked must not empty the queue.
          }
        },
      ),
    );

    return {
      branchId,
      tradingDay,
      nowMin,
      rows: built.map((r) => ({
        id: r.walkIn.id,
        position: r.position,
        label:
          named.get(identity.get(r.walkIn.id)?.customerId ?? '') ??
          r.walkIn.label,
        customerId: identity.get(r.walkIn.id)?.customerId ?? null,
        guestName: identity.get(r.walkIn.id)?.guestName ?? null,
        serviceIds: r.walkIn.serviceIds,
        waitingMin: r.waitingMin,
        options: r.options.map(toWireNearestOption),
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

    /**
     * THE STORED BRANCH IS THE HASH. walk_in_entry.branch_id is a uuid
     * column, so the demo salon's "marina-walk" comes back folded through
     * toUuid -- and read as it is, it looks like a real platform branch.
     * Found by running the journey: seating a queued package asked the
     * platform for the demo salon's packages and answered 503. Read back
     * through SlugIndex, as group confirm reads its branch.
     */
    const branchId = BRANCHES.toSlug(entry.branchId);

    const basket = await resolveBasket(
      this.context,
      this.packageCatalogue,
      branchId,
      row.walkIn.serviceIds,
    );
    if (basket.missing.length > 0) {
      throw new UnprocessableEntityException(
        `That walk-in asked for something this branch no longer sells: ` +
          `${basket.missing.join(', ')}.`,
      );
    }
    const services = basket.services;
    const day = await this.context.loadDay(branchId, entry.tradingDay);
    const first = services[0];
    const last = services[services.length - 1];
    if (first === undefined || last === undefined) {
      throw new UnprocessableEntityException('That walk-in wants nothing.');
    }

    const held = await this.holds.place({
      branchId,
      customerId: row.customerId,
      tradingDay: entry.tradingDay,
      staffId,
      startMin,
      durationMin: row.walkIn.durationMin,
      // The visit's own edges, as an ordinary hold takes them.
      claimPreMin: first.claims.preMin,
      claimPostMin: last.claims.postMin,
      // A station per part, for that part's minutes -- the same demand an
      // ordinary hold places, not the last service's station for all of it.
      resourceDemand: resourceDemandFor(services, startMin, day.resources),
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

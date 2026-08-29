import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  BOOKING_CONTEXT,
  type BookingContextReader,
  type DayContext,
} from '@application/ports/booking-context.port';
import {
  feasibleSet,
  staffAvailableAt,
  DESK_CHANNEL,
  ONLINE_CHANNEL,
  type Channel,
  type DayWindow,
  type FeasibilityResult,
  type Service,
} from '@domain/availability/feasible';
import { toSlots, popcount } from '@domain/availability/mask';
import {
  toMin,
  formatMinute,
  DAY_START_MIN,
  DAY_END_MIN,
  DAILY_BOOKING_CAP,
} from '@domain/availability/grid';
import type { ChairOccupation } from '@domain/availability/capacity';
import type { StaffBooking } from '@domain/availability/staff-mask';
import { resolveSelection } from '@domain/booking/package';
import { PACKAGES } from '@infrastructure/fixtures/fixture-booking-context';
import { priceOf } from '@application/commands/confirm-booking.handler';
import {
  fragmentationScore,
  rankAndSelect,
  DEMAND_MIX,
  type Badge,
  type Candidate,
  type FragmentationBreakdown,
  type PlannedBooking,
  type SellableStartsProbe,
} from '@domain/availability/ranking';

export interface GetAvailabilityQuery {
  readonly branchId: string;
  readonly tradingDay: string;
  readonly serviceIds: readonly string[];
  readonly channel: 'desk' | 'online';
  readonly preferredStaffId: string | null;
  readonly fromMin: number;
  readonly toMin: number;
  /** Test hook. Real requests leave this out and the branch clock is used. */
  readonly nowOverrideMin?: number;
}

export interface OfferView {
  readonly startMin: number;
  readonly start: string;
  readonly endMin: number;
  readonly end: string;
  readonly staff: readonly { id: string; name: string }[];
}

export interface RankedOfferView extends OfferView {
  readonly assignedTo: { id: string; name: string };
  readonly badges: readonly Badge[];
  readonly score: number;
  readonly fragmentation: number;
  readonly deltaCapacity: number;
  /** Plain English, so an offer row explains itself. */
  readonly why: readonly string[];
}

export interface AvailabilityView {
  readonly branchId: string;
  readonly tradingDay: string;
  readonly isToday: boolean;
  readonly channel: string;
  readonly grainMin: number;
  readonly durationMin: number;
  readonly count: number;
  /** The three the operator sees. */
  readonly topOffers: readonly RankedOfferView[];
  /** Everything feasible, for the reschedule chip grid. */
  readonly offers: readonly OfferView[];
  readonly eligible: readonly { id: string; name: string }[];
  readonly refusals: readonly { id: string; name: string; reason: string }[];
  readonly closureReason?: string;
  readonly computeMs: number;
}

const BRANCH_TIMEZONE = 'Asia/Dubai';

/** The branch's own wall clock, not the server's. */
function branchNow(timeZone: string): { day: string; minuteOfDay: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date());

  const get = (t: string): string =>
    parts.find((p) => p.type === t)?.value ?? '00';

  return {
    day: `${get('year')}-${get('month')}-${get('day')}`,
    minuteOfDay: Number(get('hour')) * 60 + Number(get('minute')),
  };
}

export function describeRefusal(reason: {
  kind: string;
  skills?: readonly string[];
  cap?: number;
}): string {
  switch (reason.kind) {
    case 'missing_skills':
      return `does not hold the required skills: ${(reason.skills ?? []).join(', ')}`;
    case 'daily_cap':
      return `daily cap reached: ${reason.cap ?? 0} bookings today`;
    default:
      return 'not the requested professional';
  }
}

function round(ms: number): number {
  return Math.round(ms * 1000) / 1000;
}

/** Turn the score breakdown into something an operator can read. */
function explain(
  f: FragmentationBreakdown,
  delta: number,
  staffName: string,
): string[] {
  const out: string[] = [];
  if (f.insideProcessing) {
    out.push("fits inside another client's hands-free window");
  }
  if (f.flushBefore) {
    out.push('starts the moment the previous visit releases the chair');
  }
  if (f.flushAfter) out.push('ends just as the next visit needs to begin');
  if (f.sliverBeforeMin !== null) {
    out.push(`leaves ${f.sliverBeforeMin} unsellable minutes before it`);
  }
  if (f.sliverAfterMin !== null) {
    out.push(`leaves ${f.sliverAfterMin} unsellable minutes after it`);
  }
  if (f.behindHighRisk)
    out.push('sits directly behind a high-risk appointment');
  if (delta <= 0.5) out.push('costs the salon almost no sellable capacity');
  else if (delta >= 2) {
    out.push(`costs ${delta} sellable starts across the demand mix`);
  }
  if (out.length === 0) {
    out.push(`${staffName} is free and the day absorbs it easily`);
  }
  return out;
}

@Injectable()
export class GetAvailabilityHandler {
  constructor(
    @Inject(BOOKING_CONTEXT) private readonly context: BookingContextReader,
  ) {}

  async execute(query: GetAvailabilityQuery): Promise<AvailabilityView> {
    const started = performance.now();

    // Packages expand to real services before the engine sees anything, so
    // availability for a package is availability for its parts. There is no
    // package branch in the engine and there never should be.
    const selection = resolveSelection(query.serviceIds, PACKAGES, priceOf);

    const services = await this.context.loadServices(
      query.branchId,
      selection.serviceIds,
    );
    if (services.length !== selection.serviceIds.length) {
      const known = new Set(services.map((s) => s.id));
      const missing = selection.serviceIds.filter((id) => !known.has(id));
      throw new NotFoundException(`Unknown service: ${missing.join(', ')}`);
    }

    const day = await this.context.loadDay(query.branchId, query.tradingDay);

    const clock = branchNow(BRANCH_TIMEZONE);
    const isToday = query.tradingDay === clock.day;
    const nowMin = query.nowOverrideMin ?? clock.minuteOfDay;
    const channel: Channel =
      query.channel === 'online' ? ONLINE_CHANNEL : DESK_CHANNEL;
    const window: DayWindow = { fromMin: query.fromMin, toMin: query.toMin };

    if (day.closureReason !== undefined) {
      return {
        branchId: query.branchId,
        tradingDay: query.tradingDay,
        isToday,
        channel: query.channel,
        grainMin: channel.grainMin,
        durationMin: services.reduce((a, s) => a + s.durationMin, 0),
        count: 0,
        topOffers: [],
        offers: [],
        eligible: [],
        refusals: [],
        closureReason: day.closureReason,
        computeMs: round(performance.now() - started),
      };
    }

    const result = feasibleSet({
      services,
      professionals: day.professionals,
      staffBookings: day.staffBookings,
      resources: day.resources,
      occupations: day.occupations,
      channel,
      window,
      preferredStaffId: query.preferredStaffId,
      isToday,
      nowMin,
      dailyCap: DAILY_BOOKING_CAP,
    });

    const nameOf = (id: string): string =>
      day.professionals.find((p) => p.id === id)?.name ?? id;

    const topOffers = await this.rank(query.branchId, day, result, services, {
      channel,
      window,
      isToday,
      nowMin,
      nameOf,
    });

    return {
      branchId: query.branchId,
      tradingDay: query.tradingDay,
      isToday,
      channel: query.channel,
      grainMin: channel.grainMin,
      durationMin: result.durationMin,
      count: popcount(result.union),
      topOffers,
      offers: this.toOffers(result, nameOf),
      eligible: result.pool.map((id) => ({ id, name: nameOf(id) })),
      refusals: [...result.excluded].map(([id, reason]) => ({
        id,
        name: nameOf(id),
        reason: describeRefusal(reason),
      })),
      computeMs: round(performance.now() - started),
    };
  }

  private async rank(
    branchId: string,
    day: DayContext,
    result: FeasibilityResult,
    services: readonly Service[],
    ctx: {
      channel: Channel;
      window: DayWindow;
      isToday: boolean;
      nowMin: number;
      nameOf: (id: string) => string;
    },
  ): Promise<RankedOfferView[]> {
    const slots = toSlots(result.union);
    if (slots.length === 0) return [];

    const loadOf = (id: string): number =>
      day.professionals.find((p) => p.id === id)?.bookingsToday ?? 0;

    const candidates: Candidate[] = [];
    for (const slot of slots) {
      const who = staffAvailableAt(result, slot);
      // First-free, least-loaded, ties broken by id so the answer is stable.
      const assigned = [...who].sort(
        (a, b) => loadOf(a) - loadOf(b) || (a < b ? -1 : 1),
      )[0];
      if (assigned === undefined) continue;

      const startMin = toMin(slot);
      candidates.push({
        slot,
        startMin,
        endMin: startMin + result.durationMin,
        staffId: assigned,
        alsoAvailable: who.filter((id) => id !== assigned),
        fragmentation: fragmentationScore({
          startMin,
          durationMin: result.durationMin,
          claims: result.claims,
          bookings: day.staffBookings.get(assigned) ?? [],
          load: loadOf(assigned),
          dailyCap: DAILY_BOOKING_CAP,
        }),
      });
    }

    const probe = await this.buildProbe(branchId, day, ctx);

    const ranked = rankAndSelect({
      candidates,
      durationMin: result.durationMin,
      claims: result.claims,
      resourceType: services[0]?.resourceType ?? 'styling',
      probe,
    });

    return ranked.offers.map((o) => ({
      startMin: o.startMin,
      start: formatMinute(o.startMin),
      endMin: o.endMin,
      end: formatMinute(o.endMin),
      staff: [o.staffId, ...o.alsoAvailable].map((id) => ({
        id,
        name: ctx.nameOf(id),
      })),
      assignedTo: { id: o.staffId, name: ctx.nameOf(o.staffId) },
      badges: o.badges,
      score: o.score,
      fragmentation: o.fragmentation.score,
      deltaCapacity: o.deltaCapacity,
      why: explain(o.fragmentation, o.deltaCapacity, ctx.nameOf(o.staffId)),
    }));
  }

  /**
   * Measures weighted sellable starts across the demand mix.
   *
   * Built once per request and closed over the day context, so ranking stays
   * a pure function that knows nothing about rosters or chairs.
   */
  private async buildProbe(
    branchId: string,
    day: DayContext,
    ctx: {
      channel: Channel;
      window: DayWindow;
      isToday: boolean;
      nowMin: number;
    },
  ): Promise<SellableStartsProbe> {
    const catalogue = await this.context.loadCatalogue(branchId);
    const byId = new Map(catalogue.map((s) => [s.id, s]));

    const baskets = DEMAND_MIX.map((b) => ({
      weight: b.weight,
      services: b.serviceIds
        .map((id) => byId.get(id))
        .filter((s): s is Service => s !== undefined),
    })).filter((b) => b.services.length > 0);

    return (extra: readonly PlannedBooking[]): number => {
      const staffBookings = new Map<string, StaffBooking[]>();
      for (const [id, list] of day.staffBookings)
        staffBookings.set(id, [...list]);
      const occupations: ChairOccupation[] = [...day.occupations];

      for (const e of extra) {
        const list = staffBookings.get(e.staffId) ?? [];
        list.push({ startMin: e.startMin, endMin: e.endMin, claims: e.claims });
        staffBookings.set(e.staffId, list);
        occupations.push({
          resourceType: e.resourceType,
          startMin: e.startMin,
          endMin: e.endMin,
        });
      }

      let total = 0;
      for (const basket of baskets) {
        const r = feasibleSet({
          services: basket.services,
          professionals: day.professionals,
          staffBookings,
          resources: day.resources,
          occupations,
          channel: ctx.channel,
          window: ctx.window,
          preferredStaffId: null,
          isToday: ctx.isToday,
          nowMin: ctx.nowMin,
          dailyCap: DAILY_BOOKING_CAP,
        });
        total += basket.weight * popcount(r.union);
      }
      return Math.round(total * 100) / 100;
    };
  }

  private toOffers(
    result: FeasibilityResult,
    nameOf: (id: string) => string,
  ): OfferView[] {
    return toSlots(result.union).map((slot) => {
      const startMin = toMin(slot);
      return {
        startMin,
        start: formatMinute(startMin),
        endMin: startMin + result.durationMin,
        end: formatMinute(startMin + result.durationMin),
        staff: staffAvailableAt(result, slot).map((id) => ({
          id,
          name: nameOf(id),
        })),
      };
    });
  }
}

export interface CatalogueItemView {
  readonly id: string;
  readonly name: string;
  readonly skill: string;
  readonly requiredLevel: number;
  readonly durationMin: number;
  readonly resourceType: string;
  readonly processing?: { fromMin: number; toMin: number };
}

@Injectable()
export class GetCatalogueHandler {
  constructor(
    @Inject(BOOKING_CONTEXT) private readonly context: BookingContextReader,
  ) {}

  async execute(branchId: string): Promise<CatalogueItemView[]> {
    const services = await this.context.loadCatalogue(branchId);
    return services.map((s) => ({
      id: s.id,
      name: s.name,
      skill: s.skill,
      requiredLevel: s.requiredLevel,
      durationMin: s.durationMin,
      resourceType: s.resourceType,
      ...(s.processing !== undefined ? { processing: s.processing } : {}),
    }));
  }
}

export const DEFAULT_WINDOW = { fromMin: DAY_START_MIN, toMin: DAY_END_MIN };

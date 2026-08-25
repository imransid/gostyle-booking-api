import { Mask, NONE, ALL, bitAt } from './mask';
import { SLOTS, DAY_END_MIN, toMin } from './grid';
import {
  BufferClaims,
  ProcessingBand,
  Shift,
  StaffBooking,
  startMask,
  chainClaims,
  chainDuration,
} from './staff-mask';
import {
  ChainSegment,
  ChairOccupation,
  ResourceType,
  capacityFreeByType,
  chainCapacityMask,
} from './capacity';

// ---------------------------------------------------------------- inputs
// Every input is a plain object. Nothing here knows about Prisma, HTTP, or
// the clock. That is what lets the whole engine be tested in milliseconds.

export interface Professional {
  readonly id: string;
  readonly name: string;
  /** skill id -> level held. A missing skill means level 0. */
  readonly skills: ReadonlyMap<string, number>;
  readonly shift: Shift;
  /** Per person: on for colourists, off for trainees still certifying. */
  readonly overlapAllowed: boolean;
  /** Bookings already taken today, checked against the daily cap. */
  readonly bookingsToday: number;
}

export interface Service {
  readonly id: string;
  readonly name: string;
  readonly skill: string;
  readonly requiredLevel: number;
  readonly durationMin: number;
  readonly resourceType: string;
  readonly claims: BufferClaims;
  readonly processing?: ProcessingBand;
  /** Whether the client leaves the chair during the hands-free band. */
  readonly releasesChairDuringProcessing?: boolean;
  /**
   * What this service asks for before it is confirmed. Rung 3 of the
   * precedence engine.
   *
   * A service may set a percentage, a fixed amount, or both; where both, the
   * larger wins. That is how a keratin treatment charges AED 400 rather than
   * a percentage that would under-protect it.
   */
  readonly depositPercent?: number | null;
  readonly depositFixedFils?: number | null;
}

/** Grain and lead time are properties of the CHANNEL, not of the service. */
export interface Channel {
  readonly grainMin: number;
  readonly leadMin: number;
}

export const DESK_CHANNEL: Channel = { grainMin: 5, leadMin: 15 };
export const ONLINE_CHANNEL: Channel = { grainMin: 15, leadMin: 60 };

/** Morning, afternoon, evening, or the whole day. */
export interface DayWindow {
  readonly fromMin: number;
  readonly toMin: number;
}

export const WHOLE_DAY: DayWindow = { fromMin: 600, toMin: 1320 };

export interface FeasibilityRequest {
  readonly services: readonly Service[];
  readonly professionals: readonly Professional[];
  /** professional id -> what is already on their calendar today. */
  readonly staffBookings: ReadonlyMap<string, readonly StaffBooking[]>;
  readonly resources: readonly ResourceType[];
  readonly occupations: readonly ChairOccupation[];
  readonly channel: Channel;
  readonly window: DayWindow;
  /** null or undefined means "any available". */
  readonly preferredStaffId?: string | null;
  readonly isToday: boolean;
  readonly nowMin: number;
  readonly dailyCap: number;
}

// ---------------------------------------------------------------- eligibility

export type IneligibilityReason =
  | { readonly kind: 'missing_skills'; readonly skills: readonly string[] }
  | { readonly kind: 'daily_cap'; readonly cap: number }
  | { readonly kind: 'not_preferred' };

export interface EligibilityResult {
  readonly pool: readonly string[];
  /** Why each excluded professional was dropped. Feeds refusal messages. */
  readonly excluded: ReadonlyMap<string, IneligibilityReason>;
}

/**
 * Who may take this chain.
 *
 * A professional is eligible only if they hold EVERY skill the chain needs,
 * at the level it needs. Partial coverage is not coverage; that case routes
 * to a relay hand-off instead.
 *
 * The reasons are collected as we go, because an unexplained empty window
 * is a support ticket.
 */
export function eligible(
  professionals: readonly Professional[],
  services: readonly Service[],
  preferredStaffId: string | null | undefined,
  dailyCap: number,
): EligibilityResult {
  const pool: string[] = [];
  const excluded = new Map<string, IneligibilityReason>();

  for (const p of professionals) {
    const missing = services
      .filter((s) => (p.skills.get(s.skill) ?? 0) < s.requiredLevel)
      .map((s) => s.skill);

    if (missing.length > 0) {
      excluded.set(p.id, {
        kind: 'missing_skills',
        skills: [...new Set(missing)],
      });
      continue;
    }
    if (p.bookingsToday >= dailyCap) {
      excluded.set(p.id, { kind: 'daily_cap', cap: dailyCap });
      continue;
    }
    if (preferredStaffId != null && p.id !== preferredStaffId) {
      excluded.set(p.id, { kind: 'not_preferred' });
      continue;
    }
    pool.push(p.id);
  }

  return { pool, excluded };
}

// ---------------------------------------------------------------- the chain

/**
 * Lay the services end to end and cut them into chair segments.
 *
 * A service with a hands-free band that releases the chair becomes three
 * segments: chair, no chair, chair. That middle piece is what returns a
 * colour station to capacity while the dye develops.
 */
export function expandChain(services: readonly Service[]): ChainSegment[] {
  const out: ChainSegment[] = [];
  let offset = 0;

  for (const s of services) {
    const band = s.processing;
    if (band !== undefined && s.releasesChairDuringProcessing === true) {
      if (band.fromMin > 0) {
        out.push({
          offsetMin: offset,
          durationMin: band.fromMin,
          resourceType: s.resourceType,
        });
      }
      out.push({
        offsetMin: offset + band.fromMin,
        durationMin: band.toMin - band.fromMin,
        resourceType: null,
      });
      if (band.toMin < s.durationMin) {
        out.push({
          offsetMin: offset + band.toMin,
          durationMin: s.durationMin - band.toMin,
          resourceType: s.resourceType,
        });
      }
    } else {
      out.push({
        offsetMin: offset,
        durationMin: s.durationMin,
        resourceType: s.resourceType,
      });
    }
    offset += s.durationMin;
  }

  return out;
}

// ---------------------------------------------------------------- alignment

/**
 * Starts the CHANNEL is willing to offer.
 *
 * Four rules, all about the offer rather than the diary:
 *   1. on the channel grain: 5 minutes at the desk, 15 online
 *   2. at or after the lead time, but only when the day is today
 *   3. inside the requested part of the day
 *   4. the chain still finishes before the branch closes
 */
export function alignmentMask(
  channel: Channel,
  window: DayWindow,
  durationMin: number,
  isToday: boolean,
  nowMin: number,
): Mask {
  const earliest = isToday
    ? Math.max(
        window.fromMin,
        Math.ceil((nowMin + channel.leadMin) / channel.grainMin) *
          channel.grainMin,
      )
    : window.fromMin;

  let mask: Mask = NONE;
  for (let i = 0; i < SLOTS; i++) {
    const t = toMin(i);
    if (t % channel.grainMin !== 0) continue;
    if (t < earliest) continue;
    if (t >= window.toMin) continue;
    if (t + durationMin > DAY_END_MIN) continue;
    mask |= 1n << BigInt(i);
  }
  return mask;
}

// ---------------------------------------------------------------- the answer

export interface FeasibilityResult {
  readonly durationMin: number;
  readonly claims: BufferClaims;
  readonly segments: readonly ChainSegment[];
  readonly pool: readonly string[];
  readonly excluded: ReadonlyMap<string, IneligibilityReason>;
  /** Per professional: every start THEY could take. */
  readonly perStaff: ReadonlyMap<string, Mask>;
  /** Any professional could take these. This is what gets offered. */
  readonly union: Mask;
  readonly capacityMask: Mask;
  readonly alignmentMask: Mask;
}

/**
 * The complete feasible set for one chain, one day, one channel.
 *
 * One intersection, four masks:
 *
 *   staff      who is actually free, buffers respected     (step 5)
 *   AND capacity  a chair for every segment, at its offset (step 6)
 *   AND alignment grain, lead time, window, closing time
 *   ---------------------------------------------------------------
 *   = every start this salon can honestly deliver
 *
 * Computed per professional, then unioned. Keeping the per-professional
 * masks is what lets "any available" defer the concrete pick to confirm
 * time, and what lets an offer say how many other people are also free.
 */
export function feasibleSet(request: FeasibilityRequest): FeasibilityResult {
  const durationMin = chainDuration(request.services.map((s) => s.durationMin));
  const claims = chainClaims(request.services.map((s) => s.claims));
  const segments = expandChain(request.services);

  const { pool, excluded } = eligible(
    request.professionals,
    request.services,
    request.preferredStaffId,
    request.dailyCap,
  );

  const freeByType = capacityFreeByType(request.resources, request.occupations);
  const capacityMask = chainCapacityMask(freeByType, segments);

  const align = alignmentMask(
    request.channel,
    request.window,
    durationMin,
    request.isToday,
    request.nowMin,
  );

  const perStaff = new Map<string, Mask>();
  let union: Mask = NONE;

  // Nothing can be offered when no chair or no legal start exists, and there
  // is no point walking the pool to discover that.
  if (capacityMask !== NONE && align !== NONE) {
    for (const id of pool) {
      const p = request.professionals.find((x) => x.id === id);
      if (p === undefined) continue;

      const mine =
        startMask(
          p.shift,
          request.staffBookings.get(id) ?? [],
          { durationMin, claims },
          { overlapAllowed: p.overlapAllowed },
        ) &
        capacityMask &
        align;

      perStaff.set(id, mine);
      union |= mine;
    }
  }

  return {
    durationMin,
    claims,
    segments,
    pool,
    excluded,
    perStaff,
    union,
    capacityMask,
    alignmentMask: align,
  };
}

/** Who could take this exact start. Used to pin a professional at confirm. */
export function staffAvailableAt(
  result: FeasibilityResult,
  slot: number,
): string[] {
  const out: string[] = [];
  for (const [id, mask] of result.perStaff) {
    if (bitAt(mask, slot)) out.push(id);
  }
  return out;
}

/** True when the salon can deliver nothing in this window. */
export function isEmpty(result: FeasibilityResult): boolean {
  return result.union === NONE;
}

export const EVERYTHING: Mask = ALL;

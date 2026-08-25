import { Mask, ALL, NONE, runsAtLeast } from './mask';
import { SLOTS, SLOT_MIN, toSlot } from './grid';

/**
 * A physical unit of capacity: a styling chair, a colour station, a nail
 * station, a treatment room.
 *
 * A professional cannot be in two places. A resource TYPE can, up to the
 * number of units you own. That is why chairs are counted and staff are
 * excluded, and why they need two different functions.
 */
export interface ResourceType {
  readonly id: string;
  /** How many units exist at this branch. */
  readonly units: number;
  /** Units marked out of service, or removed by a closed floor. */
  readonly outOfService: number;
  /**
   * Turnover after a visit ends. A treatment room is held 10 minutes, a
   * colour station 5. Extends CHAIR occupation only; it is invisible to
   * staff time, because the professional is free while the room is reset.
   */
  readonly changeoverMin: number;
}

/** A stretch of time when one unit of a type is taken. */
export interface ChairOccupation {
  readonly resourceType: string;
  readonly startMin: number;
  readonly endMin: number;
}

/**
 * One piece of a chain, positioned relative to the chain's own start.
 *
 * `resourceType: null` means no chair is occupied. That is how a hands-free
 * processing band is expressed: the client is developing in the lounge, or
 * the service policy releases the chair, so the middle returns to capacity.
 */
export interface ChainSegment {
  readonly offsetMin: number;
  readonly durationMin: number;
  readonly resourceType: string | null;
}

/** Units actually available. Out-of-service and closed floors are excluded. */
export function effectiveUnits(resource: ResourceType): number {
  return Math.max(0, resource.units - resource.outOfService);
}

/**
 * How many units of this type are in use, slot by slot.
 *
 * Built with a DIFFERENCE ARRAY, which is the trick worth knowing here.
 *
 * The obvious way is: for each booking, walk every slot it covers and add
 * one. A 125-minute colour touches 25 slots, so 200 bookings is 5,000 writes.
 *
 * Instead we write +1 where a booking starts and -1 where it ends, which is
 * two writes per booking regardless of length. Then one pass over the day
 * carries a running total. 200 bookings becomes 400 writes plus 144 adds.
 *
 * Same answer, and the cost stops depending on how long the bookings are.
 */
export function usageTimeline(
  resource: ResourceType,
  occupations: readonly ChairOccupation[],
): number[] {
  const diff = new Array<number>(SLOTS + 1).fill(0);

  for (const o of occupations) {
    if (o.resourceType !== resource.id) continue;

    // Changeover extends chair occupation past the end of the visit.
    const endWithTurnover = o.endMin + resource.changeoverMin;

    const from = Math.max(0, toSlot(o.startMin));
    const to = Math.min(SLOTS, Math.ceil((endWithTurnover - 600) / SLOT_MIN));
    if (to <= from) continue;

    diff[from] = (diff[from] ?? 0) + 1;
    diff[to] = (diff[to] ?? 0) - 1;
  }

  const timeline = new Array<number>(SLOTS).fill(0);
  let running = 0;
  for (let i = 0; i < SLOTS; i++) {
    running += diff[i] ?? 0;
    timeline[i] = running;
  }
  return timeline;
}

/**
 * Slots where at least one unit of this type is still free.
 *
 * Note what this is NOT: it is not a start-position mask. It is raw free
 * time. Turning it into start positions is chainCapacityMask's job.
 */
export function capacityFreeMask(
  resource: ResourceType,
  occupations: readonly ChairOccupation[],
): Mask {
  const limit = effectiveUnits(resource);
  if (limit <= 0) return NONE;

  const timeline = usageTimeline(resource, occupations);

  let mask: Mask = NONE;
  for (let i = 0; i < SLOTS; i++) {
    if ((timeline[i] ?? 0) < limit) {
      mask |= 1n << BigInt(i);
    }
  }
  return mask;
}

/** How many units are free at one minute. Used to explain a refusal. */
export function unitsFreeAt(
  resource: ResourceType,
  occupations: readonly ChairOccupation[],
  minuteOfDay: number,
): number {
  const slot = toSlot(minuteOfDay);
  if (slot < 0 || slot >= SLOTS) return 0;
  const timeline = usageTimeline(resource, occupations);
  return Math.max(0, effectiveUnits(resource) - (timeline[slot] ?? 0));
}

/**
 * Where the WHOLE chain has a chair for every one of its segments.
 *
 * The result is expressed at CHAIN-START positions, which is the point of
 * the shift below.
 *
 * Say segment two sits 45 minutes into the chain and needs a wash station
 * for 15 minutes. For the chain to start at slot t, a wash station must be
 * free for 3 slots beginning at t + 9.
 *
 *   runsAtLeast(washFree, 3)      bit i means "3 free slots start at i"
 *   (that mask) >> 9n             bit t means "3 free slots start at t + 9"
 *
 * Shifting right re-indexes the answer from segment time to chain time.
 * AND every segment together and you have the chain's capacity mask.
 */
export function chainCapacityMask(
  freeByType: ReadonlyMap<string, Mask>,
  segments: readonly ChainSegment[],
): Mask {
  let result: Mask = ALL;

  for (const seg of segments) {
    if (seg.resourceType === null) continue; // no chair held, nothing to check

    const free = freeByType.get(seg.resourceType);
    if (free === undefined) return NONE; // an unknown type is never sellable

    const segSlots = Math.ceil(seg.durationMin / SLOT_MIN);
    const offsetSlots = Math.ceil(seg.offsetMin / SLOT_MIN);

    result &= runsAtLeast(free, segSlots) >> BigInt(offsetSlots);
    if (result === NONE) return NONE;
  }

  return result & ALL;
}

/** Build the per-type free masks the chain mask needs. */
export function capacityFreeByType(
  resources: readonly ResourceType[],
  occupations: readonly ChairOccupation[],
): Map<string, Mask> {
  const out = new Map<string, Mask>();
  for (const r of resources) {
    out.set(r.id, capacityFreeMask(r, occupations));
  }
  return out;
}

/**
 * A booking already on the diary, with its own hands-free band.
 *
 * The band is measured from the booking's own start, exactly as it is on
 * ChainSegment.
 */
export interface OccupyingBooking {
  readonly resourceType: string;
  readonly startMin: number;
  readonly endMin: number;
  readonly processing?: { readonly fromMin: number; readonly toMin: number };
  /** Whether the client leaves the chair during the band. */
  readonly releasesChairDuringProcessing?: boolean;
}

/**
 * Cut an existing booking into the chair intervals it ACTUALLY occupies.
 *
 * A colour with a hands-free band holds its station in TWO intervals, before
 * the band and after it, not one continuous block. During the band the client
 * is in the lounge and the station is genuinely sellable to someone else.
 *
 * expandChain already does this for the chain being PLACED. This is the same
 * rule for the bookings already on the diary, and without it the two halves
 * of the engine disagree: a colour offers its own band back to the next
 * customer, then the capacity count insists every station is busy.
 *
 * Net effect of the omission: colour stations read as oversubscribed all day
 * and slots that exist are refused.
 */
export function occupationsFor(booking: OccupyingBooking): ChairOccupation[] {
  const band = booking.processing;
  if (band === undefined || booking.releasesChairDuringProcessing !== true) {
    return [
      {
        resourceType: booking.resourceType,
        startMin: booking.startMin,
        endMin: booking.endMin,
      },
    ];
  }

  const bandStart = booking.startMin + band.fromMin;
  const bandEnd = booking.startMin + band.toMin;
  const out: ChairOccupation[] = [];

  if (bandStart > booking.startMin) {
    out.push({
      resourceType: booking.resourceType,
      startMin: booking.startMin,
      endMin: bandStart,
    });
  }
  if (booking.endMin > bandEnd) {
    out.push({
      resourceType: booking.resourceType,
      startMin: bandEnd,
      endMin: booking.endMin,
    });
  }
  return out;
}
